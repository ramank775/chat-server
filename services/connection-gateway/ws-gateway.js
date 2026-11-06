const WebSocket = require('ws');
const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const {
  addHttpOptions,
  appBuildVerify,
  initHttpResource,
  HttpServiceBase
} = require('../../libs/http-service-base');
const { extractInfoFromRequest, schemas, errorEnvelope } = require('../../helper');
const EventStore = require('../../libs/event-store');
const MemCache = require('../../libs/cache');
const ChannelServiceClient = require('../../libs/channel-service-client');
const DeliveryManager = require('../../libs/delivery-manager');
const { ConnectionStateEvent } = require('../../libs/event-args');
const { HttpClient } = require('../../libs/http-client');
const { serverEventPayload } = require('../channel-ms/server-event');
const {
  WS_TYPE,
  ACK_OUTCOME,
  REASON,
  SERVER_EVENT_MARKER,
  ENVELOPE_FLAG,
  FRAME_CLASS,
  EnvelopeEvent,
  decodeWsEnvelope,
  ackFrame,
  pushFrame,
  reauthFrame,
  errorFrame,
  frameClass,
  classFlags,
  toWire,
  opIdFor,
  opIdUserBits,
  serverNow,
  dmChannelId,
  uuidText,
  userIdText,
  isUuid
} = require('../../libs/v3-envelope');

const asMain = require.main === module;

const EVENT_TYPE = {
  NEW_MESSAGE_EVENT: 'new-message',
  CONNECTION_STATE: 'connection-state',
  OFFLINE_EVENT: 'offline-event',
}

/** Locked by SYNC_PROTOCOL.md §19; not operator-tunable, so not flags. */
const MAX_BATCH = 20;                       // §19 decision 7
const DEDUP_MAX_ENTRIES = 10000;            // §19 decision 3
const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;     // §19 decision 3
const RATE_LIMIT = {                        // §14.1 / §19 decision 4
  user: { capacity: 100, refillPerSec: 30 },
  ip: { capacity: 100, refillPerSec: 100 }
};
const HEARTBEAT_MS = 30 * 1000;             // §5.10

/** proto/v3-server-event-payload.proto `ServerEventType` PRESENCE (decision 223, track F). */
const PRESENCE_EVENT = 50;
/** `noteDm` remembers this many pairs, then starts over. */
const DM_NOTED_MAX = 10000;

/**
 * SYNC_PROTOCOL §22 — `target`'s presence as `viewer` may see it: an
 * ephemeral PRESENCE push that reads as a DM frame from `target`. Online
 * false and no last seen means "show nothing".
 */
function presenceFrame(target, viewer, online, lastSeenMs) {
  const definition = serverEventPayload();
  const bytes = definition.encode(definition.fromObject({
    version: 1, type: PRESENCE_EVENT, presence: { userId: target, online, lastSeenMs }
  })).finish();
  return pushFrame(toWire({
    opId: opIdFor(target),
    peer: viewer,
    payload: Buffer.concat([Buffer.from([SERVER_EVENT_MARKER]), bytes]),
    ephemeral: true,
    flags: classFlags(FRAME_CLASS.PRESENCE) + ENVELOPE_FLAG.SILENT,
    serverTimestampMs: serverNow()
  }));
}

/** A client presence op's `online` (the app on screen); null for any other payload. */
function presenceOnline(payload) {
  if (!payload.length || payload[0] !== SERVER_EVENT_MARKER) return null;
  try {
    const { presence } = serverEventPayload().decode(payload.subarray(1));
    return presence ? !!presence.online : null;
  } catch (e) {
    return null;
  }
}

/** AUTH_CONTRACT.md §6.5 — the only application close codes this server may use. */
const REVOKE_REASON = {
  expired: { code: 4001, reason: 'accesskey_expired' },
  revoked: { code: 4002, reason: 'session_revoked' },
  rebind: { code: 4003, reason: 'phone_rebind' }
};

async function prepareListEvent(context) {
  const { options } = context;
  context.events = {
    [EVENT_TYPE.NEW_MESSAGE_EVENT]: options.newMessageTopic,
    [EVENT_TYPE.CONNECTION_STATE]: options.userConnectionStateTopic,
    [EVENT_TYPE.OFFLINE_EVENT]: options.offlineMessageTopic,
  };
  return context;
}

async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(prepareListEvent)
    .then(initHttpResource)
    .then(MemCache.initMemCache)
    .then(ChannelServiceClient.init)
    .then(EventStore.initializeEventStore({ producer: true }))
    .then(DeliveryManager.init);

  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = EventStore.addEventStoreOptions(cmd);
  cmd = MemCache.addMemCacheOptions(cmd);
  cmd = ChannelServiceClient.addOptions(cmd);
  cmd = DeliveryManager.addOptions(cmd);
  cmd
    .option(
      '--gateway-name <gateway-name>',
      'Used as gateway server idenitifer for the user connected to this server.'
    )
    .option(
      '--new-message-topic <new-message-topic>',
      'Used by producer to produce new message for each new incoming message'
    )
    .option(
      '--user-connection-state-topic <user-connection-state-topic>',
      'Used by producer to publish user connect/disconnect state'
    )
    .option(
      '--offline-message-topic <offline-message-topic>',
      'Used by producer to wake a device whose socket died under a push'
    )
    .option('--profile-ms-endpoint <profile-ms-endpoint>', 'Base url for profile service')
    .option(
      '--reauth-grace-ms <reauth-grace-ms>',
      'Grace period between WS_REAUTH_REQUIRED and the close frame',
      (value) => Number(value),
      5000
    )
  return cmd.parse(argv).opts();
}

/**
 * TRIM_4_12_CONTRACT §7 — the session subject. The same string delivery uses
 * as a recipient, so a push frame lands on exactly one socket.
 */
function sessionKey(userId, deviceId) {
  return `${userId}:${deviceId}`;
}

/**
 * v3 sync gateway (SYNC_PROTOCOL.md §5-§10, AUTH_CONTRACT.md §6).
 *
 * Auth happens ahead of us: nginx runs the `auth_request` subrequest against
 * profile-ms and, on success, proxies the upgrade with `x-user: <user_id>`
 * and `x-device: <deviceId>`. We echo the client's `accesskey.<uuid>`
 * subprotocol on the 101 and bind the socket to that identity.
 */
class Gateway extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {{eventStore: import('../../libs/event-store/iEventStore').IEventStore}} */
    const { eventStore, events } = this.context;

    this.publishEvent = async (event, eventArgs, key) => {
      const topic = events[event];
      if (!topic) return;
      await eventStore.emit(topic, eventArgs, key);
    };

    /** subject (user_id:deviceId) -> socket. One active socket per subject. */
    this.sessions = new Map();
    /** user_id -> Set<socket>: presence and revocation are per user, not per device. */
    this.userSessions = new Map();

    this.memCache = context.memCache;
    /** @type { import('../../libs/channel-service-client').ChannelServiceClient } */
    this.channelClient = context.channelServiceClient;
    /** @type { import('../../libs/delivery-manager').DeliveryManager } */
    this.deliveryManager = context.deliveryManager;
    this.reauthGraceMs = this.options.reauthGraceMs ?? 5000;
    /**
     * SYNC_PROTOCOL §22: user_id -> the sockets watching that user's
     * presence. A socket watches one user at most (`ws.watching`), and is
     * online while its app is on screen (`ws.here`).
     * ponytail: in process. Ceiling: with several gateways a watcher hears
     * only about sockets on its own gateway; keep `here` and the watchers
     * in redis and publish changes if a second gateway ever runs.
     */
    this.watchers = new Map();
    /** `from:to` DM pairs already sent to profile-ms (`noteDm`). */
    this.dmNoted = new Set();
    /** Null without `--profile-ms-endpoint`: no presence then. */
    this.profileClient = this.options.profileMsEndpoint
      ? new HttpClient(this.options.profileMsEndpoint)
      : null;
  }

  async init() {
    await super.init();
    this.initWebsocket();
    this.addInternalRoute('/sessions/revoke', 'POST', this.revokeSessions.bind(this), {
      validate: {
        payload: Joi.object({
          user_id: Joi.string().required(),
          deviceId: Joi.string().optional(),
          reason: Joi.string().valid(...Object.keys(REVOKE_REASON)).required()
        })
      }
    });
    // §22: profile-ms, after a user changed who sees their presence
    this.addInternalRoute('/presence/refresh', 'POST', this.refreshPresence.bind(this), {
      validate: { payload: Joi.object({ user_id: Joi.string().required() }) }
    });
    // SYNC_PROTOCOL §5.11 — the socket's frames over https, for a phone
    // with no socket: a push wake, a send after the app was closed.
    this.addRoute('/ops', 'POST', this.postOps.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        payload: Joi.object({ frame: Joi.string().base64().required() })
      }
    });

    this.deliveryManager.eventArg = EnvelopeEvent;
    this.deliveryManager.messageHandler = this.messageHandler.bind(this);
    // message-delivery queues every frame before it reaches us and owns
    // `offlineMessageHandler` (the wake for the recipients we could not
    // reach). Nothing to do here — and when we share one manager with it
    // (monolith), leave its handler alone.
    if (!this.deliveryManager.offlineMessageHandler) {
      this.deliveryManager.offlineMessageHandler = () => { };
    }
    await this.deliveryManager.startConsumer();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  initWebsocket() {
    const wss = new WebSocket.Server({
      server: this.httpServer,
      // Mounted, the raw server also serves every other service's http, so
      // only upgrades on our own prefix are ours, and the authentication
      // nginx did ahead of us is a hook the runner supplies (the upgrade
      // never reaches fastify, so the global auth hook cannot see it).
      // An outdated app is refused before either (decision 192).
      path: this.mount ? this.mount.prefix : undefined,
      verifyClient: appBuildVerify(this.options.minAppBuild, this.context.wsVerify),
      // AUTH_CONTRACT.md §6.2 step 3 — echo the accesskey subprotocol on the
      // 101 so the client's handshake completes.
      handleProtocols: (protocols) =>
        [...protocols].find((protocol) => protocol.startsWith('accesskey.')) || false
    });
    this.context.wss = wss;
    wss.on('connection', (ws, request) => {
      const userId = request.headers['x-user'];
      const deviceId = request.headers['x-device'] || 'default';
      if (!userId) {
        // nginx should never proxy an unauthenticated upgrade; if it does,
        // fail closed rather than serving an anonymous socket.
        ws.send(errorFrame('UNAUTHENTICATED', 'missing x-user on upgrade'), { binary: true });
        ws.close(1008, 'unauthenticated');
        return;
      }
      ws.userId = userId;
      ws.deviceId = deviceId;
      ws.remoteIp = (request.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || request.socket.remoteAddress;
      this.onConnect(ws);
      ws.on('pong', () => {
        ws.missedPing = false;
        // everything pushed before that ping reached the device
        ws.confirmed = ws.pushedAtPing;
      });
      ws.on('message', (payload, isBinary) => this.onMessage(ws, payload, isBinary));
      ws.on('close', (code) => this.onDisconnect(ws, code));
    });
  }

  // ---- connection lifecycle -------------------------------------------

  async onConnect(ws) {
    const { userId, deviceId } = ws;
    const key = sessionKey(userId, deviceId);
    const previous = this.sessions.get(key);
    if (previous && previous !== ws) {
      // One active socket per (user_id, deviceId); the newer one wins,
      // still on screen if the old one was: the app says so again anyway.
      ws.here = previous.here;
      this._unregister(previous);
      previous.close(1000, 'replaced');
    }
    this.sessions.set(key, ws);
    if (!this.userSessions.has(userId)) this.userSessions.set(userId, new Set());
    this.userSessions.get(userId).add(ws);

    this.statsClient.gauge({
      stat: 'user.connected.count',
      value: '+1',
      tags: { service: 'gateway', gateway: this.options.gatewayName, user: userId }
    });
    await this.deliveryManager.userJoin(userId, deviceId);
    await this.publishEvent(
      EVENT_TYPE.CONNECTION_STATE,
      ConnectionStateEvent.connect(userId, this.options.gatewayName),
      userId
    );
  }

  async onDisconnect(ws, code) {
    const { userId, deviceId } = ws;
    if (!this._unregister(ws)) return;
    this.statsClient.gauge({
      stat: 'user.connected.count',
      value: -1,
      tags: { service: 'gateway', gateway: this.options.gatewayName, user: userId }
    });
    // the route is per device; the connection-state event is per user
    await this.deliveryManager.userLeft(userId, deviceId);
    if (ws.here && !this.isOnline(userId)) await this.presenceChanged(userId);
    await this.wakeIfLost(ws, code);
    if (this.userSessions.has(userId)) return; // another device is still online
    await this.publishEvent(
      EVENT_TYPE.CONNECTION_STATE,
      ConnectionStateEvent.disconnect(userId, this.options.gatewayName),
      userId
    );
  }

  /**
   * §12.1 — the socket died (no close frame: the heartbeat gave up on it, or
   * the app was killed) after pushes no pong has confirmed. They may never
   * have arrived; they are in the device's log, so wake it to pull them now
   * rather than whenever the app next opens. A close the client sent itself
   * needs nothing: it pulls past its pointer when it comes back.
   */
  async wakeIfLost(ws, code) {
    if (code === 1000 || code === 1001) return;
    if ((ws.pushed || 0) <= (ws.confirmed || 0)) return;
    const subject = sessionKey(ws.userId, ws.deviceId);
    try {
      await this.publishEvent(EVENT_TYPE.OFFLINE_EVENT, EnvelopeEvent.of({}, [subject]), subject);
    } catch (e) {
      this.log.error('Wake on close failed', { err: e, user: ws.userId });
    }
  }

  /**
   * §5.10 — ping every socket; one that has not answered the previous ping
   * died without a close (the phone changed networks or lost coverage).
   * Terminating it is an ordinary close: the device goes offline, and
   * `wakeIfLost` wakes it for whatever it may have missed.
   */
  heartbeat() {
    this.sessions.forEach((ws) => {
      if (ws.missedPing) {
        ws.terminate();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.missedPing = true;
      ws.pushedAtPing = ws.pushed || 0;
      ws.ping();
    });
  }

  /** Drop a socket from both indexes. Returns false when it was already gone. */
  _unregister(ws) {
    const { userId, deviceId } = ws;
    const key = sessionKey(userId, deviceId);
    const sockets = this.userSessions.get(userId);
    const known = sockets ? sockets.delete(ws) : false;
    if (sockets && !sockets.size) this.userSessions.delete(userId);
    if (this.sessions.get(key) === ws) this.sessions.delete(key);
    this.watch(ws, null);
    return known;
  }

  // ---- presence (SYNC_PROTOCOL §22) ------------------------------------

  /** Online: a socket of theirs whose app is on screen. */
  isOnline(userId) {
    return [...(this.userSessions.get(userId) || [])].some((ws) => ws.here);
  }

  /** `ws` now watches `target` (null: nobody). */
  watch(ws, target) {
    if (ws.watching === target) return;
    const watching = this.watchers.get(ws.watching);
    if (watching) {
      watching.delete(ws);
      if (!watching.size) this.watchers.delete(ws.watching);
    }
    ws.watching = target;
    ws.shown = false;
    if (!target) return;
    if (!this.watchers.has(target)) this.watchers.set(target, new Set());
    this.watchers.get(target).add(ws);
  }

  /**
   * A client's presence op: its app is (not) on screen, and it watches
   * `target` (its own id: nobody), which is answered at once.
   */
  async presenceOp(session, target, payload) {
    const ws = session;
    // over https there is no socket to be online on or to answer
    if (this.sessions.get(sessionKey(ws.userId, ws.deviceId)) !== ws) return;
    const here = presenceOnline(payload);
    if (here === null) return;
    this.watch(ws, target === ws.userId ? null : target);
    const wasOnline = this.isOnline(ws.userId);
    ws.here = here;
    if (wasOnline !== this.isOnline(ws.userId)) await this.presenceChanged(ws.userId);
    if (ws.watching) await this.tellPresence(ws.watching, [ws], false);
  }

  /** `userId` came online or left: stamp their last seen, tell who watches. */
  async presenceChanged(userId) {
    await this.tellPresence(userId, [...(this.watchers.get(userId) || [])], true);
  }

  /** profile-ms: `user_id` changed who may see their presence. */
  async refreshPresence(req) {
    const userId = req.payload.user_id;
    await this.tellPresence(userId, [...(this.watchers.get(userId) || [])], false);
    return { status: true };
  }

  /**
   * Ask profile-ms which of `sockets`' users may see `target` (and, with
   * `stamp`, record `target`'s last seen as now), then push each its view.
   * One who may not gets "nothing" only when it asked (no `stamp`) or was
   * shown something before: never on a change it may not see, which would
   * give the change away by its timing.
   */
  async tellPresence(target, sockets, stamp) {
    if (!this.profileClient || (!stamp && !sockets.length)) return;
    let answer;
    try {
      answer = await this.profileClient.post('/_internal/presence', {
        user_id: target,
        viewers: [...new Set(sockets.map((ws) => ws.userId))],
        seen: stamp
      });
    } catch (e) {
      this.log.error('Presence lookup failed', { err: e, user: target });
      return;
    }
    const allowed = new Set(answer.viewers);
    const online = this.isOnline(target);
    sockets.forEach((ws) => {
      if (allowed.has(ws.userId)) {
        ws.shown = true;
        this.send(ws, presenceFrame(target, ws.userId, online, answer.last_seen_ms));
      } else if (!stamp || ws.shown) {
        ws.shown = false;
        this.send(ws, presenceFrame(target, ws.userId, false, 0));
      }
    });
  }

  /**
   * §22 "My contacts" for now: users who have each written to the other in
   * a DM. Each direction is sent to profile-ms once per process.
   */
  noteDm(from, to) {
    const key = `${from}:${to}`;
    if (!this.profileClient || this.dmNoted.has(key)) return;
    if (this.dmNoted.size >= DM_NOTED_MAX) this.dmNoted.clear();
    this.dmNoted.add(key);
    this.profileClient.post('/_internal/presence/contact', { user_id: from, peer: to })
      .catch((e) => {
        this.dmNoted.delete(key);
        this.log.error('Recording a DM contact failed', { err: e, user: from });
      });
  }

  // ---- client -> server ------------------------------------------------

  async onMessage(ws, payload, isBinary) {
    // any frame proves the socket alive, as a pong does (§5.10)
    ws.missedPing = false;
    this.statsClient.increment({
      stat: 'message.received.count',
      tags: { channel: 'websocket', gateway: this.options.gatewayName, user: ws.userId }
    });

    if (!isBinary) {
      const text = payload.toString();
      // The only text frames on the v3 wire are the legacy keepalive.
      if (text === 'ping') {
        ws.send('pong');
        return;
      }
      if (text === 'pong') return;
      this.protocolError(ws, 'VALIDATION_FAILED', 'v3 frames must be binary WsEnvelope');
      return;
    }

    let frame;
    try {
      frame = decodeWsEnvelope(payload);
    } catch (e) {
      this.log.error('Malformed WsEnvelope', { err: e, user: ws.userId });
      this.protocolError(ws, 'MALFORMED_FRAME', 'WsEnvelope could not be decoded');
      return;
    }

    if (frame.type !== WS_TYPE.WS_OP) {
      this.protocolError(ws, 'VALIDATION_FAILED', `unexpected WsType ${frame.type}`);
      return;
    }

    const envelopes = (frame.ops && frame.ops.envelopes) || [];
    if (!envelopes.length) return;
    const acks = await this.processOps(ws, envelopes);
    // §5.4 — acks for one incoming frame ride back in one WS_ACK.
    if (acks.length) this.sendAcks(ws, acks);
  }

  /**
   * `POST /wss/ops` (§5.11) — one WS_OP frame, base64 in `frame`, from the
   * session nginx authenticated; the WS_ACK the socket would have sent comes
   * back the same way. The server owns an op once that ack is out, as on the
   * socket, and the dedup window is shared, so a frame sent both ways lands once.
   */
  async postOps(req, res) {
    const session = {
      userId: extractInfoFromRequest(req, 'x-user'),
      deviceId: extractInfoFromRequest(req, 'x-device', 'default'),
      remoteIp: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket.remoteAddress
    };
    this.statsClient.increment({
      stat: 'message.received.count',
      tags: { channel: 'https', gateway: this.options.gatewayName, user: session.userId }
    });
    let frame;
    try {
      frame = decodeWsEnvelope(Buffer.from(req.payload.frame, 'base64'));
    } catch (e) {
      return res.response(errorEnvelope('MALFORMED_FRAME', 'WsEnvelope could not be decoded'))
        .code(400);
    }
    if (frame.type !== WS_TYPE.WS_OP) {
      return res.response(errorEnvelope('VALIDATION_FAILED', `unexpected WsType ${frame.type}`))
        .code(400);
    }
    const acks = await this.processOps(session, (frame.ops && frame.ops.envelopes) || []);
    return res.response({ frame: ackFrame(acks).toString('base64') }).code(200);
  }

  /**
   * One frame's envelopes, socket or https: the acks to send back, in order.
   * @param {{userId: string, deviceId: string, remoteIp: string}} session
   */
  async processOps(session, envelopes) {
    // §5.4 — over the batch cap the whole frame is rejected, one permanent
    // ack per envelope.
    if (envelopes.length > MAX_BATCH) {
      return envelopes.map((envelope) => ({
        opId: envelope.opId,
        outcome: ACK_OUTCOME.PERMANENT,
        reason: REASON.VALIDATION_FAILED
      }));
    }
    const acks = [];
    for (let i = 0; i < envelopes.length; i += 1) {
      // Serial on purpose: acks and fanout keep the frame's envelope order.
      // eslint-disable-next-line no-await-in-loop
      const ack = await this.processEnvelope(session, envelopes[i]);
      if (ack) acks.push(ack);
    }
    return acks;
  }

  /**
   * SYNC_PROTOCOL.md §6a.3. Returns the Ack to send back, or null for an
   * ephemeral envelope (which is never acked).
   * Decision 218: the ids arrive as bytes and are turned into their text
   * forms here, the one place they enter; the Ack names the op by the bytes
   * it was sent with.
   * @param {{userId: string, deviceId: string, remoteIp: string}} session
   * @param {object} wire the Envelope as decoded off the wire
   */
  async processEnvelope(session, wire) {
    const { userId } = session;
    const dedupKey = `dedup:${userId}`;
    const permanent = (reason) => ({ opId: wire.opId, outcome: ACK_OUTCOME.PERMANENT, reason });

    // §14 rate limits. Checked first so a flood cannot burn downstream calls,
    // and never recorded in the dedup window — a transient outcome has to
    // stay retryable.
    const retryAfterMs = await this.checkRate(session);
    if (retryAfterMs) {
      return {
        opId: wire.opId, outcome: ACK_OUTCOME.TRANSIENT, reason: REASON.RATE_LIMITED, retryAfterMs
      };
    }

    // An op_id that is not 16 bytes has no text form to remember it by, and
    // fails the same way again. The sending device goes on every fanout as
    // 16 bytes, so a session whose device id is no UUID cannot send at all
    // (the app's is a UUIDv4; only a hand-made session lacks one).
    const opId = uuidText(wire.opId);
    if (!opId || !isUuid(session.deviceId)) return permanent(REASON.VALIDATION_FAILED);

    // §3 — op_id must embed this session's user_id.
    if (opIdUserBits(opId) !== parseInt(userId, 16)) {
      return this.rejectPermanent(dedupKey, opId, wire.opId, REASON.PREFIX_MISMATCH);
    }

    // §7.1 — a replayed op_id returns the stored outcome, never re-processed.
    // Best effort: the window lives in the cache and may be lost on a restart,
    // which is harmless because clients dedupe inbound envelopes by op_id.
    if (!wire.ephemeral) {
      const stored = await this.memCache.dedupGet(dedupKey, opId);
      if (stored) return { ...JSON.parse(stored), opId: wire.opId };
    }

    // Decision 218: a DM names its peer and no channel, a group its channel
    // and no peer; anything else is malformed.
    const isDm = wire.peer.length > 0;
    if (isDm === wire.channelId.length > 0) {
      return this.rejectPermanent(dedupKey, opId, wire.opId, REASON.VALIDATION_FAILED);
    }

    // §6a.3 step 3 — membership. A DM id is derived from the pair
    // (TRIM_4_12_CONTRACT §3), so it has no row to look up: the channel is
    // whatever (sender, peer) derives to, and a third party cannot reach
    // someone else's DM because their own user_id is half of it.
    let channelId;
    let peer = '';
    let recipients = [];
    if (isDm) {
      peer = userIdText(wire.peer);
      if (!peer) return this.rejectPermanent(dedupKey, opId, wire.opId, REASON.VALIDATION_FAILED);
      channelId = dmChannelId(userId, peer);
      // Both sides, so the sender's own other devices get it too (§8); the
      // sending device is what fanout excludes.
      recipients = [peer, userId];
    } else {
      channelId = uuidText(wire.channelId);
      if (!channelId) {
        return this.rejectPermanent(dedupKey, opId, wire.opId, REASON.VALIDATION_FAILED);
      }
      let isMember;
      try {
        isMember = await this.channelClient.isMember(channelId, userId);
      } catch (e) {
        this.log.error('channel-ms membership lookup failed', { err: e, user: userId });
        return {
          opId: wire.opId,
          outcome: ACK_OUTCOME.TRANSIENT,
          reason: REASON.DOWNSTREAM_TIMEOUT,
          retryAfterMs: 1000
        };
      }
      if (!isMember) return this.rejectPermanent(dedupKey, opId, wire.opId, REASON.FORBIDDEN);
    }

    // §22 — a presence op is for the server itself: never acked, never
    // fanned out. Only ephemeral, so no client waits on an ack for one.
    if (frameClass(wire.flags) === FRAME_CLASS.PRESENCE) {
      if (!wire.ephemeral) {
        return this.rejectPermanent(dedupKey, opId, wire.opId, REASON.VALIDATION_FAILED);
      }
      if (isDm) await this.presenceOp(session, peer, wire.payload);
      return null;
    }

    // §10.2 / §19 decision 15 — a 0x53 payload is a server-authored event.
    // Clients may not mint one. This is the ONLY byte of `payload` we look
    // at; §6a.2 forbids parsing the rest.
    if (wire.payload.length && wire.payload[0] === SERVER_EVENT_MARKER) {
      return this.rejectPermanent(dedupKey, opId, wire.opId, REASON.VALIDATION_FAILED);
    }

    // The server keeps no per-channel order: it stamps server_timestamp_ms
    // and clients order a channel by (server_timestamp_ms, op_id). An edit
    // that arrives before its message is the client's to hold (DECISIONS row 127).
    const serverTimestampMs = serverNow();
    const envelope = {
      opId,
      channelId,
      peer,
      payload: wire.payload,
      ephemeral: wire.ephemeral,
      ttlSec: wire.ttlSec,
      flags: wire.flags,
      senderUserId: userId,
      serverTimestampMs
    };

    // Ephemeral (typing): no dedup, no ack, and message-delivery drops it
    // rather than queueing it offline.
    if (wire.ephemeral) {
      await this.publishEnvelope(envelope, recipients, session.deviceId);
      return null;
    }

    try {
      await this.publishEnvelope(envelope, recipients, session.deviceId);
    } catch (e) {
      this.log.error('Failed to publish envelope', { err: e, user: userId, opId });
      return {
        opId: wire.opId,
        outcome: ACK_OUTCOME.TRANSIENT,
        reason: REASON.STORAGE_UNAVAILABLE,
        retryAfterMs: 1000
      };
    }

    if (isDm && frameClass(wire.flags) === FRAME_CLASS.MESSAGE) this.noteDm(userId, peer);
    const ack = { outcome: ACK_OUTCOME.SUCCESS, serverTimestampMs };
    await this.memCache.dedupPut(
      dedupKey, opId, JSON.stringify(ack), DEDUP_MAX_ENTRIES, DEDUP_TTL_SEC
    );
    return { ...ack, opId: wire.opId };
  }

  /**
   * @param {object} envelope server-stamped
   * @param {string[]} recipients spelled out for a DM (no channel row to
   *   read); empty for a group, which message-delivery resolves from
   *   channel-ms.
   * @param {string} senderDevice the one device fanout skips (§8)
   */
  async publishEnvelope(envelope, recipients = [], senderDevice = '') {
    await this.publishEvent(
      EVENT_TYPE.NEW_MESSAGE_EVENT,
      EnvelopeEvent.of(envelope, recipients, senderDevice),
      envelope.channelId
    );
  }

  /**
   * §7.1 case 2 — permanent rejects are remembered so a replay repeats them.
   * Kept under the op_id's text, without it: a replay names its own bytes.
   */
  async rejectPermanent(dedupKey, opId, opIdBytes, reason) {
    const ack = { outcome: ACK_OUTCOME.PERMANENT, reason };
    await this.memCache.dedupPut(
      dedupKey, opId, JSON.stringify(ack), DEDUP_MAX_ENTRIES, DEDUP_TTL_SEC
    );
    return { ...ack, opId: opIdBytes };
  }

  /** §14.1 — per-user then per-IP. Returns 0 when the envelope may proceed. */
  async checkRate(session) {
    const userWait = await this.memCache.takeToken(
      `rate:user:${session.userId}`, RATE_LIMIT.user.capacity, RATE_LIMIT.user.refillPerSec
    );
    if (userWait) return userWait;
    return this.memCache.takeToken(
      `rate:ip:${session.remoteIp}`, RATE_LIMIT.ip.capacity, RATE_LIMIT.ip.refillPerSec
    );
  }

  sendAcks(ws, acks) {
    this.send(ws, ackFrame(acks));
  }

  /** §5.3 / §5.8 — protocol-level failure: one WS_ERROR, then close 1002. */
  protocolError(ws, code, message) {
    this.send(ws, errorFrame(code, message));
    ws.close(1002, code);
  }

  // ---- server -> client ------------------------------------------------

  /**
   * Called by delivery-manager with a server-stamped fanout envelope.
   * Returns the subjects we could not reach so delivery-manager routes them
   * on (and ultimately to message-delivery's undelivered queue).
   * Synchronous by contract — delivery-manager does not await this.
   * @param {EnvelopeEvent} event
   */
  messageHandler(event) {
    const frame = event.toPushFrame();
    return event.recipients.filter((subject) => !this.pushToSubject(subject, frame, event));
  }

  /**
   * §10.3 step 2 — deliver a WS_PUSH frame to one `user_id:device_id`
   * subject. False means "offline": that device was not reachable here.
   * @param {string} subject
   * @param {Buffer} frame serialized WsEnvelope{type: WS_PUSH}
   */
  pushToSubject(subject, frame, event) {
    const user = subject.split(':')[0];
    const ws = this.sessions.get(subject);
    if (!this.send(ws, frame)) {
      this.statsClient.increment({
        stat: 'message.delivery.error_count',
        tags: { channel: 'websocket', gateway: this.options.gatewayName, user, code: 404 }
      });
      return false;
    }
    // §5.10 — a pong for a later ping confirms it arrived (`wakeIfLost`)
    ws.pushed = (ws.pushed || 0) + 1;
    if (event) {
      this.statsClient.timing({
        stat: 'message.delivery.latency',
        value: Date.now() - (event.envelope.serverTimestampMs || Date.now()),
        tags: { gateway: this.options.gatewayName, channel: 'websocket', user }
      });
    }
    return true;
  }

  send(ws, frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(frame, { binary: Buffer.isBuffer(frame) });
      return true;
    } catch (e) {
      this.log.error('Error while sending websocket message', { err: e });
      return false;
    }
  }

  // ---- session revocation (AUTH_CONTRACT.md §6.3-§6.5) -----------------

  /**
   * `POST /_internal/sessions/revoke` — profile-ms calls this when an
   * accesskey expires, a session is revoked, or a phone rebind invalidates
   * the session. We warn the client, then close with the matching code.
   */
  async revokeSessions(req) {
    const { user_id: userId, deviceId, reason } = req.payload;
    const { code, reason: closeReason } = REVOKE_REASON[reason];
    const sockets = deviceId
      ? [this.sessions.get(sessionKey(userId, deviceId))].filter(Boolean)
      : [...(this.userSessions.get(userId) || [])];

    sockets.forEach((ws) => {
      this.send(ws, reauthFrame());
      const timer = setTimeout(() => ws.close(code, closeReason), this.reauthGraceMs);
      if (timer.unref) timer.unref();
    });
    this.log.info(`Revoked ${sockets.length} session(s) for ${userId} (${reason})`);
    return { status: true, sessions: sockets.length };
  }

  async shutdown() {
    clearInterval(this.heartbeatTimer);
    if (this.context.wss) this.context.wss.close();
    await super.shutdown();
    const { eventStore } = this.context;
    if (eventStore) await eventStore.dispose();
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResources(options)
    .then(async (context) => {
      await new Gateway(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Gateway server', error);
      process.exit(1);
    });
}

module.exports = {
  Gateway,
  parseOptions,
  initResources,
  prepareListEvent,
};
