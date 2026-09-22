const WebSocket = require('ws');
const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const EventStore = require('../../libs/event-store');
const MemCache = require('../../libs/cache');
const ChannelServiceClient = require('../../libs/channel-service-client');
const DeliveryManager = require('../../libs/delivery-manager');
const { ConnectionStateEvent } = require('../../libs/event-args');
const {
  WS_TYPE,
  ACK_OUTCOME,
  REASON,
  SERVER_EVENT_MARKER,
  EnvelopeEvent,
  decodeWsEnvelope,
  ackFrame,
  reauthFrame,
  errorFrame,
  opIdUserBits,
  dmChannelId,
  isDmChannelId,
  isUserId
} = require('../../libs/v3-envelope');

const asMain = require.main === module;

const EVENT_TYPE = {
  NEW_MESSAGE_EVENT: 'new-message',
  CONNECTION_STATE: 'connection-state',
}

/** Locked by SYNC_PROTOCOL.md §19; not operator-tunable, so not flags. */
const MAX_BATCH = 20;                       // §19 decision 7
const DEDUP_MAX_ENTRIES = 10000;            // §19 decision 3
const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;     // §19 decision 3
const SEQ_TTL_SEC = DEDUP_TTL_SEC;          // §16: seq tracking aligns with dedup
const RATE_LIMIT = {                        // §14.1 / §19 decision 4
  user: { capacity: 100, refillPerSec: 30 },
  ip: { capacity: 100, refillPerSec: 100 }
};

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

    this.deliveryManager.eventArg = EnvelopeEvent;
    this.deliveryManager.messageHandler = this.messageHandler.bind(this);
    // The undelivered queue is message-delivery's (V3_RELEASE_PLAN §3.3). It
    // owns `offlineMessageHandler` and is expected to expose
    //   queueForUser(user_id, wsEnvelopeBytes, deliverySequence)
    // over the recipients it gets back from us. Nothing to do here — and when
    // we share one manager with it (monolith), leave its handler alone.
    if (!this.deliveryManager.offlineMessageHandler) {
      this.deliveryManager.offlineMessageHandler = () => { };
    }
    await this.deliveryManager.startConsumer();
  }

  initWebsocket() {
    const wss = new WebSocket.Server({
      server: this.httpServer,
      // Mounted, the raw server also serves every other service's http, so
      // only upgrades on our own prefix are ours, and the authentication
      // nginx did ahead of us is a hook the runner supplies (the upgrade
      // never reaches fastify, so the global auth hook cannot see it).
      path: this.mount ? this.mount.prefix : undefined,
      verifyClient: this.context.wsVerify,
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
      ws.on('message', (payload, isBinary) => this.onMessage(ws, payload, isBinary));
      ws.on('close', () => this.onDisconnect(ws));
    });
  }

  // ---- connection lifecycle -------------------------------------------

  async onConnect(ws) {
    const { userId, deviceId } = ws;
    const key = sessionKey(userId, deviceId);
    const previous = this.sessions.get(key);
    if (previous && previous !== ws) {
      // One active socket per (user_id, deviceId); the newer one wins.
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

  async onDisconnect(ws) {
    const { userId, deviceId } = ws;
    if (!this._unregister(ws)) return;
    this.statsClient.gauge({
      stat: 'user.connected.count',
      value: -1,
      tags: { service: 'gateway', gateway: this.options.gatewayName, user: userId }
    });
    // the route is per device; the connection-state event is per user
    await this.deliveryManager.userLeft(userId, deviceId);
    if (this.userSessions.has(userId)) return; // another device is still online
    await this.publishEvent(
      EVENT_TYPE.CONNECTION_STATE,
      ConnectionStateEvent.disconnect(userId, this.options.gatewayName),
      userId
    );
  }

  /** Drop a socket from both indexes. Returns false when it was already gone. */
  _unregister(ws) {
    const { userId, deviceId } = ws;
    const key = sessionKey(userId, deviceId);
    const sockets = this.userSessions.get(userId);
    const known = sockets ? sockets.delete(ws) : false;
    if (sockets && !sockets.size) this.userSessions.delete(userId);
    if (this.sessions.get(key) === ws) this.sessions.delete(key);
    return known;
  }

  // ---- client -> server ------------------------------------------------

  async onMessage(ws, payload, isBinary) {
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

    // §5.4 — over the batch cap the whole frame is rejected, one permanent
    // ack per envelope.
    if (envelopes.length > MAX_BATCH) {
      this.sendAcks(ws, envelopes.map((envelope) => ({
        opId: envelope.opId,
        outcome: ACK_OUTCOME.PERMANENT,
        reason: REASON.VALIDATION_FAILED
      })));
      return;
    }

    const acks = [];
    for (let i = 0; i < envelopes.length; i += 1) {
      // Serial on purpose: envelopes in one frame may target one resource,
      // and the resource_seq compare-and-set has to see them in order.
      // eslint-disable-next-line no-await-in-loop
      const ack = await this.processEnvelope(ws, envelopes[i]);
      if (ack) acks.push(ack);
    }
    // §5.4 — acks for one incoming frame ride back in one WS_ACK.
    if (acks.length) this.sendAcks(ws, acks);
  }

  /**
   * SYNC_PROTOCOL.md §6a.3. Returns the Ack to send back, or null for an
   * ephemeral envelope (which is never acked).
   */
  async processEnvelope(ws, envelope) {
    const { userId } = ws;
    const { opId } = envelope;
    const dedupKey = `dedup:${userId}`;

    // §14 rate limits. Checked first so a flood cannot burn resource_seq
    // slots or downstream calls, and never recorded in the dedup window —
    // a transient outcome has to stay retryable.
    const retryAfterMs = await this.checkRate(ws);
    if (retryAfterMs) {
      return { opId, outcome: ACK_OUTCOME.TRANSIENT, reason: REASON.RATE_LIMITED, retryAfterMs };
    }

    // §3 — op_id must embed this session's user_id.
    const bits = opIdUserBits(opId);
    if (bits === null) return this.rejectPermanent(dedupKey, opId, REASON.VALIDATION_FAILED);
    if (bits !== parseInt(userId, 16)) {
      return this.rejectPermanent(dedupKey, opId, REASON.PREFIX_MISMATCH);
    }

    // §7.1 — a replayed op_id returns the stored outcome, never re-processed.
    if (!envelope.ephemeral) {
      const stored = await this.memCache.dedupGet(dedupKey, opId);
      if (stored) return JSON.parse(stored);
    }

    // §6a.3 step 3 — membership. Before sequencing so a non-member never
    // advances the channel's counter. A DM id is derived from the pair
    // (TRIM_4_12_CONTRACT §3), so it has no row to look up: recompute it
    // from the authenticated sender and `peer` instead.
    let recipients = [];
    if (isDmChannelId(envelope.channelId)) {
      if (!isUserId(envelope.peer)) {
        return this.rejectPermanent(dedupKey, opId, REASON.VALIDATION_FAILED);
      }
      if (dmChannelId(userId, envelope.peer) !== envelope.channelId) {
        return this.rejectPermanent(dedupKey, opId, REASON.FORBIDDEN);
      }
      // Both sides, so the sender's own other devices get it too (§8); the
      // sending device is what fanout excludes.
      recipients = [envelope.peer, userId];
    } else {
      let isMember;
      try {
        isMember = await this.channelClient.isMember(envelope.channelId, userId);
      } catch (e) {
        this.log.error('channel-ms membership lookup failed', { err: e, user: userId });
        return {
          opId,
          outcome: ACK_OUTCOME.TRANSIENT,
          reason: REASON.DOWNSTREAM_TIMEOUT,
          retryAfterMs: 1000
        };
      }
      if (!isMember) return this.rejectPermanent(dedupKey, opId, REASON.FORBIDDEN);
    }

    // §10.2 / §19 decision 15 — a 0x53 payload is a server-authored event.
    // Clients may not mint one. This is the ONLY byte of `payload` we look
    // at; §6a.2 forbids parsing the rest.
    if (envelope.payload && envelope.payload.length && envelope.payload[0] === SERVER_EVENT_MARKER) {
      return this.rejectPermanent(dedupKey, opId, REASON.VALIDATION_FAILED);
    }

    // Ephemeral (typing): no dedup, no sequencing, no delivery_sequence, no
    // ack, and message-delivery drops it rather than queueing it offline.
    if (envelope.ephemeral) {
      await this.publishEnvelope({
        ...envelope,
        senderUserId: userId,
        serverTimestampMs: Date.now()
      }, recipients, ws.deviceId);
      return null;
    }

    // §6 — resource_seq must be exactly last + 1 for (user_id, channel_id).
    const seqKey = `seq:${userId}:${envelope.channelId}`;
    const inOrder = await this.memCache.casNext(seqKey, envelope.resourceSeq, SEQ_TTL_SEC);
    if (!inOrder) return this.rejectPermanent(dedupKey, opId, REASON.OUT_OF_ORDER);

    const serverTimestampMs = Date.now();
    const deliverySequence = await this.memCache.incr(`dseq:${envelope.channelId}`);
    try {
      await this.publishEnvelope({
        ...envelope,
        senderUserId: userId,
        serverTimestampMs,
        deliverySequence
      }, recipients, ws.deviceId);
    } catch (e) {
      this.log.error('Failed to publish envelope', { err: e, user: userId, opId });
      // Give the seq slot back so the client's retry of the same op is not
      // met with out_of_order. Safe because §6 lets the client keep only one
      // op per resource in flight.
      await this.memCache.set(seqKey, envelope.resourceSeq - 1);
      return {
        opId,
        outcome: ACK_OUTCOME.TRANSIENT,
        reason: REASON.STORAGE_UNAVAILABLE,
        retryAfterMs: 1000
      };
    }

    const ack = { opId, outcome: ACK_OUTCOME.SUCCESS, serverTimestampMs, deliverySequence };
    await this.memCache.dedupPut(
      dedupKey, opId, JSON.stringify(ack), DEDUP_MAX_ENTRIES, DEDUP_TTL_SEC
    );
    return ack;
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

  /** §7.1 case 2 — permanent rejects are remembered so a replay repeats them. */
  async rejectPermanent(dedupKey, opId, reason) {
    const ack = { opId, outcome: ACK_OUTCOME.PERMANENT, reason };
    await this.memCache.dedupPut(
      dedupKey, opId, JSON.stringify(ack), DEDUP_MAX_ENTRIES, DEDUP_TTL_SEC
    );
    return ack;
  }

  /** §14.1 — per-user then per-IP. Returns 0 when the envelope may proceed. */
  async checkRate(ws) {
    const userWait = await this.memCache.takeToken(
      `rate:user:${ws.userId}`, RATE_LIMIT.user.capacity, RATE_LIMIT.user.refillPerSec
    );
    if (userWait) return userWait;
    return this.memCache.takeToken(
      `rate:ip:${ws.remoteIp}`, RATE_LIMIT.ip.capacity, RATE_LIMIT.ip.refillPerSec
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
    if (!this.send(this.sessions.get(subject), frame)) {
      this.statsClient.increment({
        stat: 'message.delivery.error_count',
        tags: { channel: 'websocket', gateway: this.options.gatewayName, user, code: 404 }
      });
      return false;
    }
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
  EVENT_TYPE,
};
