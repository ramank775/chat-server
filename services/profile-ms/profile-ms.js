const crypto = require('crypto');
const { join } = require('path');
const Joi = require('joi');
const protobufjs = require('protobufjs');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const { addMemCacheOptions, initMemCache } = require('../../libs/cache');
const eventStore = require('../../libs/event-store');
const { profileDB } = require('./database');
const { addAuthProviderOptions, initializeAuthProvider, AuthError } = require('./auth-provider');
const { SmsGatewayError, SmsGatewayUnavailableError } = require('./auth-provider/sms-sender');
const { HttpClient } = require('../../libs/http-client');
const { EnvelopeEvent, SERVER_EVENT_MARKER } = require('../../libs/v3-envelope');
const { validateUsername } = require('./username');
const { uuidv4, hashSecret, verifySecret, sha256 } = require('../../helper');

const asMain = require.main === module;

const E164 = /^\+\d{8,15}$/;
const USERNAME_CHANGE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const USER_ID_MAX_RETRY = 10;
const CONTACT_LOOKUP_MAX = 100;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** proto/v3-server-event-payload.proto `ServerEventType` */
const SERVER_EVENT_TYPE = { PROFILE_EDITED: 6, USERNAME_CHANGED: 7 };

/** @type {import('protobufjs').Type} */
let serverEventPayload = null;

/**
 * SYNC_PROTOCOL 10.2: the `Envelope.payload` of a REST-write fanout is a
 * `ServerEventPayload` behind the 0x53 marker byte.
 * @param {object} body one populated `ServerEventPayload`
 * @returns {Buffer}
 */
function encodeServerEvent(body) {
  if (!serverEventPayload) {
    serverEventPayload = protobufjs
      .loadSync(join(__dirname, '..', '..', 'proto', 'v3-server-event-payload.proto'))
      .lookupType('vartalap.v3.payload.ServerEventPayload');
  }
  const bytes = serverEventPayload.encode(serverEventPayload.create(body)).finish();
  return Buffer.concat([Buffer.from([SERVER_EVENT_MARKER]), bytes]);
}

// AUTH_CONTRACT 2.4: routes reachable while `username` is still null
const GATE_EXEMPT = [/^\/users\/me$/, /^\/users\/username\/check$/, /^\/auth\//];

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = profileDB.addDatabaseOptions(cmd);
  cmd = addAuthProviderOptions(cmd);
  cmd = addMemCacheOptions(cmd);
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd.option(
    '--new-login-topic <new-login-topic>',
    'New login topic used to produce new login events'
  );
  cmd.option(
    '--new-message-topic <new-message-topic>',
    'Topic the REST-write fanout envelopes are published to (SYNC_PROTOCOL 10.2)'
  );
  cmd.option(
    '--expose-dev-otp',
    'DEV ONLY: serve GET /auth/dev/otp?phone= with the last code the mock sms sender produced',
    false
  );
  cmd.option('--channel-ms-endpoint <channel-ms-endpoint>', 'Base url for channel service');
  cmd.option('--gateway-endpoint <gateway-endpoint>', 'Base url for connection gateway');
  cmd.option('--otp-rate-phone-hour <count>', 'OTP sends per phone per hour', (c) => Number(c), 5);
  cmd.option('--otp-rate-phone-day <count>', 'OTP sends per phone per day', (c) => Number(c), 15);
  cmd.option('--otp-rate-ip-hour <count>', 'OTP sends per ip per hour', (c) => Number(c), 20);
  cmd.option(
    '--profile-rate-hour <count>',
    'Profile field updates per user per hour',
    (c) => Number(c),
    50
  );
  cmd.option('--contact-lookup-day <count>', 'Phone hashes per user per day', (c) => Number(c), 500);
  cmd.option(
    '--contact-lookup-ip-day <count>',
    'Phone hashes per ip per day',
    (c) => Number(c),
    5000
  );
  cmd.option(
    '--username-lookup-min <count>',
    'by-username lookups per user per minute',
    (c) => Number(c),
    60
  );
  cmd.option(
    '--username-lookup-ip-day <count>',
    'by-username lookups per ip per day',
    (c) => Number(c),
    5000
  );
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options)
    .then(initHttpResource)
    .then(profileDB.initializeDatabase)
    .then(initializeAuthProvider)
    .then(initMemCache)
    .then(eventStore.initializeEventStore({ producer: true }));
}

/**
 * AUTH_CONTRACT 11.1 error envelope
 */
function errorEnvelope(code, message, extra = {}) {
  return { error: { code, message, ...extra } };
}

/**
 * `Authorization: Bearer <accesskey>` (REST) or
 * `Sec-WebSocket-Protocol: accesskey.<accesskey>` (WS upgrade, AUTH_CONTRACT 6.1)
 * @param {import('@hapi/hapi').Request} req
 * @returns {string|null}
 */
function extractAccesskey(req) {
  const { authorization } = req.headers;
  if (authorization && /^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, '').trim() || null;
  }
  const subprotocol = req.headers['sec-websocket-protocol'];
  if (subprotocol) {
    const entry = subprotocol
      .split(',')
      .map((part) => part.trim())
      .find((part) => part.startsWith('accesskey.'));
    if (entry) return entry.slice('accesskey.'.length) || null;
  }
  return null;
}

/**
 * The caller's address for the AUTH_CONTRACT 10.1 per-IP budgets. Every request
 * arrives from nginx, so `remoteAddress` is the proxy and the budget would be
 * global; the last `x-forwarded-for` hop is the peer nginx actually saw.
 * @param {import('@hapi/hapi').Request} req
 */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.info.remoteAddress;
}

/**
 * Is the upstream request behind an `auth_request` subject to the
 * `USERNAME_REQUIRED` gate?
 * @param {string} originalUri value of the `x-original-uri` header nginx sets
 * @returns {boolean}
 */
function isUsernameGated(originalUri) {
  if (!originalUri) return false;
  const path = originalUri.split('?')[0].replace(/^\/v\d+\.\d+/, '');
  // the WS handshake is explicitly not gated (AUTH_CONTRACT 13.3)
  if (path.startsWith('/wss')) return false;
  return !GATE_EXEMPT.some((exempt) => exempt.test(path));
}

/**
 * The owner view of a profile (AUTH_CONTRACT 4.4). The only shape allowed to
 * carry `phone`.
 * @param {import('./database/profile/profile-db').User} user
 */
function selfProfile(user) {
  return {
    user_id: user.user_id,
    username: user.username || null,
    phone: user.phone,
    displayName: user.displayName || null,
    avatarUrl: user.avatarUrl || null,
    statusText: user.statusText || null,
    createdAt: user.createdAt.getTime()
  };
}

/**
 * The view every other user gets (AUTH_CONTRACT 7.5). Never carries `phone`.
 * @param {import('./database/profile/profile-db').User} user
 */
function publicProfile(user) {
  return {
    user_id: user.user_id,
    username: user.username || null,
    displayName: user.displayName || null,
    avatarUrl: user.avatarUrl || null,
    statusText: user.statusText || null
  };
}

class ProfileMs extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('./database/profile/profile-db').IProfileDB } */
    this.profileDB = context.profileDB;
    /** @type {import('./auth-provider/auth-provider').IAuthProvider} */
    this.authProvider = context.authProvider;
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = context.eventStore;
    this.memCache = context.memCache;
    this.newLoginTopic = this.options.newLoginTopic;
    this.newMessageTopic = this.options.newMessageTopic;
    // ponytail: channel-ms exposes no "channels of a user" internal route and
    // libs/channel-service-client only answers `isMember`, so the fanout reads
    // the public list route per channel kind. Collapse to one internal call
    // when channel-ms grows one.
    this.channelClient = new HttpClient(this.options.channelMsEndpoint);
    this.gatewayClient = new HttpClient(this.options.gatewayEndpoint);
  }

  async init() {
    await super.init();

    // every non-envelope error (joi rejection, unknown route, crash) still leaves
    // the service through the AUTH_CONTRACT 11 envelope
    this.hapiServer.ext('onPreResponse', (req, h) => {
      const { response } = req;
      if (!response.isBoom) return h.continue;
      const status = response.output.statusCode;
      if (status >= 500) {
        this.log.error(`Unhandled error on ${req.path}: ${response.message}`);
        return h.response(errorEnvelope('INTERNAL_ERROR', 'Internal server error')).code(status);
      }
      const code = status === 404 ? 'NOT_FOUND' : 'validation_failed';
      return h.response(errorEnvelope(code, response.message)).code(status);
    });

    const payload = (schema) => ({ validate: { payload: schema.required() } });

    this.addRoute(
      '/auth',
      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      this.guard(this.subrequestAuth)
    );

    this.addRoute(
      '/auth/otp/send',
      'POST',
      this.guard(this.otpSend),
      payload(
        Joi.object({
          phone: Joi.string().required(),
          deviceId: Joi.string().required()
        })
      )
    );

    this.addRoute(
      '/auth/otp/verify',
      'POST',
      this.guard(this.otpVerify),
      payload(
        Joi.object({
          sessionId: Joi.string().required(),
          code: Joi.string().pattern(/^\d{6}$/).required(),
          deviceId: Joi.string().required()
        })
      )
    );

    this.addRoute(
      '/auth/otp/resend',
      'POST',
      this.guard(this.otpResend),
      payload(Joi.object({ sessionId: Joi.string().required() }))
    );

    this.addRoute(
      '/auth/session/refresh',
      'POST',
      this.guard(this.sessionRefresh),
      payload(
        Joi.object({
          refreshToken: Joi.string().required(),
          deviceId: Joi.string().required()
        })
      )
    );

    this.addRoute(
      '/auth/session/revoke',
      'POST',
      this.guard(this.sessionRevoke),
      { validate: { payload: Joi.object({ refreshToken: Joi.string() }).default({}) } }
    );

    // ponytail: the OTP code is only ever stored as a scrypt hash, so a local
    // end to end run has no way back to it. This reads the mock sender's
    // in-memory log and nothing else. Never on without --expose-dev-otp.
    if (this.options.exposeDevOtp && this.context.smsSender.lastCode) {
      this.addRoute(
        '/auth/dev/otp',
        'GET',
        (req, res) => {
          const code = this.context.smsSender.lastCode(req.query.phone);
          if (!code) return res.response(errorEnvelope('NOT_FOUND', 'no code for phone')).code(404);
          return { code };
        },
        { validate: { query: Joi.object({ phone: Joi.string().required() }) } }
      );
      this.log.warn('--expose-dev-otp is on: GET /auth/dev/otp leaks OTP codes');
    }

    this.addRoute('/users/me', 'GET', this.guard(this.getMe), { pre: [this.authPre(false)] });

    this.addRoute('/users/me', 'PATCH', this.guard(this.patchMe), {
      pre: [this.authPre(false)],
      validate: {
        payload: Joi.object({
          username: Joi.string().allow(null),
          usernameKey: Joi.string().allow(null),
          displayName: Joi.string().allow(null, ''),
          avatarUrl: Joi.string().allow(null, ''),
          statusText: Joi.string().allow(null, '')
        })
          .min(1)
          .required()
      }
    });

    this.addRoute('/users/username/check', 'POST', this.guard(this.usernameCheck), {
      pre: [this.authPre(false)],
      validate: { payload: Joi.object({ username: Joi.string().required() }).required() }
    });

    this.addRoute('/users/me/delete', 'POST', this.guard(this.deleteMe), {
      pre: [this.authPre()],
      validate: { payload: Joi.object({ confirmation: Joi.string().required() }).required() }
    });

    this.addRoute('/users/by-username/{username}', 'GET', this.guard(this.getUserByUsername), {
      pre: [this.authPre()],
      validate: {
        params: Joi.object({ username: Joi.string().required() }),
        query: Joi.object({ key: Joi.string().allow('') })
      }
    });

    this.addRoute('/users/{userId}', 'GET', this.guard(this.getUser), {
      pre: [this.authPre()],
      validate: { params: Joi.object({ userId: Joi.string().required() }) }
    });

    this.addRoute('/contacts/lookup', 'POST', this.guard(this.contactsLookup), {
      pre: [this.authPre()],
      validate: {
        payload: Joi.object({
          phoneHashes: Joi.array().items(Joi.string().pattern(SHA256_HEX)).min(1).required()
        }).required()
      }
    });

    this.addRoute(
      '/auth/phone/rebind/start',
      'POST',
      this.guard(this.rebindStart),
      {
        pre: [this.authPre(false)],
        validate: { payload: Joi.object({ newPhone: Joi.string().required() }).required() }
      }
    );

    this.addRoute(
      '/auth/phone/rebind/verify',
      'POST',
      this.guard(this.rebindVerify),
      {
        pre: [this.authPre(false)],
        validate: {
          payload: Joi.object({
            rebindSessionId: Joi.string().required(),
            code: Joi.string().pattern(/^\d{6}$/).required()
          }).required()
        }
      }
    );
  }

  /**
   * Wrap a handler so an `AuthError` leaves as its contract envelope
   * @param {(req, res) => Promise<*>} handler
   */
  guard(handler) {
    return async (req, res) => {
      try {
        return await handler.call(this, req, res);
      } catch (error) {
        if (error instanceof AuthError) {
          return res.response(errorEnvelope(error.code, error.message, error.extra)).code(error.status);
        }
        throw error;
      }
    };
  }

  /**
   * The single implementation of authentication + the AUTH_CONTRACT 2.4
   * `USERNAME_REQUIRED` gate. Routes opt out of the gate with `exempt = true`.
   * @param {boolean} gated
   * @returns {import('@hapi/hapi').RouteOptionsPreObject}
   */
  authPre(gated = true) {
    return {
      assign: 'auth',
      method: async (req, h) => {
        try {
          const { session, user } = await this.resolveSession(req, gated);
          return { session, user };
        } catch (error) {
          if (error instanceof AuthError) {
            return h
              .response(errorEnvelope(error.code, error.message, error.extra))
              .code(error.status)
              .takeover();
          }
          throw error;
        }
      }
    };
  }

  /**
   * Resolve the accesskey on a request to its session and user.
   * @param {import('@hapi/hapi').Request} req
   * @param {boolean} gated apply the USERNAME_REQUIRED gate
   */
  async resolveSession(req, gated) {
    const accesskey = extractAccesskey(req);
    if (!accesskey) {
      throw new AuthError(401, 'MISSING_ACCESSKEY', 'Authorization bearer accesskey is required');
    }
    const session = await this.authProvider.verifyAccessKey(accesskey);
    const user = await this.profileDB.getByUserId(session.user_id);
    if (!user) {
      throw new AuthError(401, 'INVALID_ACCESSKEY', 'accesskey is not valid');
    }
    if (gated && !user.username) {
      throw new AuthError(403, 'USERNAME_REQUIRED', 'Set a username before using this route');
    }
    return { session, user };
  }

  /**
   * nginx `auth_request` endpoint. Answers 200 with the identity headers every
   * upstream service reads, or the 401/403 envelope.
   */
  async subrequestAuth(req, res) {
    const { session } = await this.resolveSession(req, isUsernameGated(req.headers['x-original-uri']));
    return res
      .response({ status: true })
      .code(200)
      .header('x-user', session.user_id)
      .header('x-device', session.deviceId);
  }

  async otpSend(req, res) {
    const { phone, deviceId } = req.payload;
    if (!E164.test(phone)) {
      return res
        .response(errorEnvelope('INVALID_PHONE_FORMAT', 'phone must be in E.164 format'))
        .code(400);
    }
    await this.otpRateLimits(phone, clientIp(req));

    const challenge = await this.sendOtp(() => this.authProvider.startOtp({ phone, deviceId }), res);
    if (challenge.isBoom || !challenge.sessionId) return challenge;
    const existing = await this.profileDB.getByPhone(phone);
    return {
      sessionId: challenge.sessionId,
      resendAfterSec: challenge.resendAfterSec,
      expiresInSec: challenge.expiresInSec,
      isExistingAccount: !!existing
    };
  }

  async otpResend(req, res) {
    const challenge = await this.sendOtp(
      () => this.authProvider.resendOtp(req.payload.sessionId),
      res
    );
    if (challenge.isBoom || !challenge.sessionId) return challenge;
    const existing = await this.profileDB.getByPhone(challenge.phone);
    return {
      sessionId: challenge.sessionId,
      resendAfterSec: challenge.resendAfterSec,
      expiresInSec: challenge.expiresInSec,
      isExistingAccount: !!existing
    };
  }

  async otpVerify(req) {
    const { sessionId, code, deviceId } = req.payload;
    const verified = await this.authProvider.verifyOtp({ sessionId, code, deviceId });
    let user = await this.profileDB.getByPhone(verified.phone);
    const isNew = !user;
    if (isNew) {
      user = await this.createUser(verified.phone);
    }
    const issued = await this.authProvider.issueSession(user.user_id, deviceId);
    return {
      status: true,
      user_id: user.user_id,
      username: user.username || null,
      phone: user.phone,
      ...issued,
      isNew
    };
  }

  async sessionRefresh(req) {
    const { refreshToken, deviceId } = req.payload;
    return this.authProvider.refreshSession(refreshToken, deviceId);
  }

  async sessionRevoke(req) {
    // idempotent: an unknown or already revoked accesskey is a no-op, not an error
    const accesskey = extractAccesskey(req);
    if (!accesskey) {
      throw new AuthError(401, 'MISSING_ACCESSKEY', 'Authorization bearer accesskey is required');
    }
    // 4.6 side effect 4: this device's socket goes with the credentials
    const session = await this.authProvider.verifyAccessKey(accesskey).catch(() => null);
    await this.authProvider.revoke(accesskey);
    if (session) {
      await this.revokeGatewaySessions(session.user_id, 'revoked', session.deviceId);
    }
    return { status: true };
  }

  // eslint-disable-next-line class-methods-use-this
  async getMe(req) {
    return selfProfile(req.pre.auth.user);
  }

  async patchMe(req, res) {
    const { user } = req.pre.auth;
    const { payload } = req;
    const has = (field) => Object.prototype.hasOwnProperty.call(payload, field);
    const now = new Date();
    const updates = {};

    ['displayName', 'avatarUrl', 'statusText'].forEach((field) => {
      if (has(field)) updates[field] = payload[field] || null;
    });

    if (has('username') && (payload.username || null) !== (user.username || null)) {
      const next = payload.username;
      if (next !== null) {
        const invalid = validateUsername(next);
        if (invalid) {
          return res
            .response(
              errorEnvelope(
                invalid,
                invalid === 'USERNAME_RESERVED'
                  ? 'That username is reserved'
                  : 'username must be 3-30 chars of a-z 0-9 . _ and start with a letter'
              )
            )
            .code(invalid === 'USERNAME_RESERVED' ? 409 : 400);
        }
      }
      // 10.6: one change per 90 days. The first ever set does not start the clock.
      if (user.usernameChangedAt) {
        const elapsed = now.getTime() - user.usernameChangedAt.getTime();
        if (elapsed < USERNAME_CHANGE_WINDOW_MS) {
          return res
            .response(
              errorEnvelope('RATE_LIMITED', 'username can only be changed once every 90 days', {
                retryAfterSec: Math.ceil((USERNAME_CHANGE_WINDOW_MS - elapsed) / 1000),
                scope: 'user'
              })
            )
            .code(429);
        }
      }
      if (next === null) {
        updates.username = null;
        updates.usernameLower = null;
        // a key is meaningless with no handle to gate (4.5)
        updates.usernameKeyHash = null;
      } else {
        // a tombstoned handle is still taken (8.3)
        const taken = await this.profileDB.getUsernameHolder(next);
        if (taken) {
          return res
            .response(errorEnvelope('USERNAME_TAKEN', 'That username is already taken'))
            .code(409);
        }
        updates.username = next;
        updates.usernameLower = next;
      }
      if (user.username || user.usernameChangedAt) {
        updates.usernameChangedAt = now;
      }
    }

    if (has('usernameKey')) {
      const key = payload.usernameKey;
      if (key === null) {
        updates.usernameKeyHash = null;
      } else {
        const willHaveUsername = has('username') ? payload.username !== null : !!user.username;
        if (!/^\d{4}$/.test(key) || !willHaveUsername) {
          return res
            .response(
              errorEnvelope(
                'INVALID_USERNAME_KEY',
                'usernameKey must be 4 digits and requires a username'
              )
            )
            .code(400);
        }
        updates.usernameKeyHash = await hashSecret(key);
      }
    }

    await this.rateLimit(
      `profile:rate:${user.user_id}:h`,
      this.options.profileRateHour,
      3600,
      'user'
    );

    let updated;
    try {
      updated = await this.profileDB.updateUser(user.user_id, updates);
    } catch (error) {
      if (error.code === 'USERNAME_TAKEN') {
        return res
          .response(errorEnvelope('USERNAME_TAKEN', 'That username is already taken'))
          .code(409);
      }
      throw error;
    }
    await this.fanoutProfileChange(updated, updates, now);
    return selfProfile(updated);
  }

  /**
   * SYNC_PROTOCOL 10.2/10.3 - a profile or username edit reaches every user
   * sharing at least one channel with the editor, as a server-event envelope
   * on the same topic (and so the same delivery path) as chat. Best effort:
   * an edit already written is not failed by a fanout that could not publish.
   * @param {import('./database/profile/profile-db').User} user
   * @param {Partial<import('./database/profile/profile-db').User>} updates
   * @param {Date} now
   */
  async fanoutProfileChange(user, updates, now) {
    const events = [];
    const has = (field) => Object.prototype.hasOwnProperty.call(updates, field);
    if (has('displayName') || has('avatarUrl') || has('statusText')) {
      const body = { userId: user.user_id, editedAtMs: now.getTime() };
      // present and empty means cleared, absent means untouched (proto3 optional)
      if (has('displayName')) body.displayName = updates.displayName || '';
      if (has('avatarUrl')) body.avatarUrl = updates.avatarUrl || '';
      if (has('statusText')) body.statusText = updates.statusText || '';
      events.push({ version: 1, type: SERVER_EVENT_TYPE.PROFILE_EDITED, profileEdited: body });
    }
    // `username` only lands in `updates` when it actually changed
    if (has('username')) {
      events.push({
        version: 1,
        type: SERVER_EVENT_TYPE.USERNAME_CHANGED,
        usernameChanged: {
          userId: user.user_id,
          newUsername: updates.username || '',
          changedAtMs: now.getTime()
        }
      });
    }
    if (!events.length || !this.newMessageTopic) return;
    try {
      const { recipients, channelId } = await this.coMembers(user.user_id);
      if (!recipients.length) return;
      for (let i = 0; i < events.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await this.publishServerEvent(events[i], recipients, channelId);
      }
    } catch (error) {
      this.log.error(`Profile fanout failed for ${user.user_id}: ${error.message}`);
    }
  }

  /**
   * Every user sharing a channel with `userId`, and one of those channels to
   * carry the envelope. A profile edit is not channel scoped but `Envelope`
   * is, so every recipient gets the same arbitrary shared channel id; the
   * client only uses it to record the op id (SYNC_PROTOCOL 10.2).
   * @param {string} userId
   */
  async coMembers(userId) {
    const lists = await Promise.all(
      ['group', 'one_to_one'].map((type) =>
        this.channelClient.get('/', { headers: { 'x-user': userId }, params: { type } })
      )
    );
    const members = new Set();
    let channelId = null;
    lists.flat().forEach((channel) => {
      channelId = channelId || channel.channelId;
      // ponytail: channel-ms still keys members by `username`; v3 step 3.4 renames it
      (channel.members || []).forEach((member) =>
        members.add(member.user_id ?? member.username ?? member)
      );
    });
    // 10.3 rule 4: the editor does not receive their own fanout
    members.delete(userId);
    return { recipients: [...members], channelId };
  }

  /**
   * Publish one server-event envelope the way the gateway publishes a chat
   * envelope, so message-delivery fans it out unchanged.
   * @param {object} body populated `ServerEventPayload`
   * @param {string[]} recipients
   * @param {string} channelId
   */
  async publishServerEvent(body, recipients, channelId) {
    const nowMs = Date.now();
    const envelope = {
      opId: uuidv4(),
      channelId,
      resourceSeq: 0,
      clientTimestampMs: nowMs,
      payload: encodeServerEvent(body),
      senderUserId: '', // server authored
      serverTimestampMs: nowMs,
      deliverySequence: await this.memCache.incr(`dseq:${channelId}`)
    };
    await this.eventStore.emit(
      this.newMessageTopic,
      EnvelopeEvent.of(envelope, recipients),
      channelId
    );
  }

  /**
   * AUTH_CONTRACT 6.3 - tell the gateway to drop this user's sockets. Best
   * effort: the credentials are already gone from the database either way.
   * @param {string} userId
   * @param {'expired'|'revoked'|'rebind'} reason
   * @param {string} [deviceId] limit the close to one device
   */
  async revokeGatewaySessions(userId, reason, deviceId = undefined) {
    try {
      await this.gatewayClient.post('/_internal/sessions/revoke', {
        user_id: userId,
        reason,
        ...(deviceId ? { deviceId } : {})
      });
    } catch (error) {
      this.log.error(`Gateway session revoke (${reason}) failed for ${userId}: ${error.message}`);
    }
  }

  /**
   * AUTH_CONTRACT 7.5 — any authenticated user may read any public profile.
   * A tombstoned account is a 404 like an unknown one (8.3).
   */
  async getUser(req, res) {
    const target = await this.profileDB.getByUserId(req.params.userId);
    if (!target) {
      return res.response(errorEnvelope('USER_NOT_FOUND', 'No such user')).code(404);
    }
    return publicProfile(target);
  }

  /**
   * AUTH_CONTRACT 7.6 — exact, case insensitive handle lookup. A keyed handle
   * needs `?key=NNNN`; a wrong key is indistinguishable from an unknown
   * handle, a *missing* one is not (decision 33).
   */
  async getUserByUsername(req, res) {
    const { user } = req.pre.auth;
    await this.rateLimit(
      `uname:rate:user:${user.user_id}:m`,
      this.options.usernameLookupMin,
      60,
      'user'
    );
    await this.rateLimit(
      `uname:rate:ip:${clientIp(req)}:d`,
      this.options.usernameLookupIpDay,
      86400,
      'ip'
    );
    const notFound = (code = 'USER_NOT_FOUND') =>
      res.response(errorEnvelope(code, 'No such user')).code(404);

    const target = await this.profileDB.getByUsername(req.params.username.toLowerCase());
    if (!target) return notFound();
    if (target.usernameKeyHash) {
      const { key } = req.query;
      if (!key) return notFound('USERNAME_KEY_REQUIRED');
      if (!(await verifySecret(key, target.usernameKeyHash))) return notFound();
    }
    return publicProfile(target);
  }

  /**
   * AUTH_CONTRACT 7.2 — phone hash batch to `(user_id, username)`. Hashes with
   * no live account are simply absent; negatives are never reported (7.1).
   */
  async contactsLookup(req, res) {
    const { user } = req.pre.auth;
    const { phoneHashes } = req.payload;
    if (phoneHashes.length > CONTACT_LOOKUP_MAX) {
      return res
        .response(errorEnvelope('BATCH_TOO_LARGE', `At most ${CONTACT_LOOKUP_MAX} hashes per request`))
        .code(400);
    }
    // 7.4 budgets are counted in hashes, not requests
    await this.rateLimit(
      `lookup:rate:user:${user.user_id}:d`,
      this.options.contactLookupDay,
      86400,
      'user',
      phoneHashes.length
    );
    await this.rateLimit(
      `lookup:rate:ip:${clientIp(req)}:d`,
      this.options.contactLookupIpDay,
      86400,
      'ip',
      phoneHashes.length
    );
    const matches = await this.profileDB.getByPhoneHashes([...new Set(phoneHashes)]);
    return {
      matches: matches
        // the caller's own number is in their own address book; nothing to chat about
        .filter((match) => match.user_id !== user.user_id)
        .map((match) => ({
          phoneHash: match.phoneHash,
          user_id: match.user_id,
          username: match.username || null
        }))
    };
  }

  /**
   * AUTH_CONTRACT 8.2 — tombstone the account. The row keeps `user_id` and
   * `usernameLower` (both stay reserved by their unique indexes) and leaves
   * the partial phone index, which is what releases the number for a fresh
   * signup. Deregistering the push topic is notification-ms's job (5.4).
   */
  async deleteMe(req, res) {
    const { user } = req.pre.auth;
    if (req.payload.confirmation !== `DELETE ${user.username}`) {
      return res
        .response(errorEnvelope('INVALID_CONFIRMATION', 'confirmation must be "DELETE <username>"'))
        .code(400);
    }
    await this.profileDB.updateUser(user.user_id, { deletedAt: new Date() });
    await this.authProvider.revokeAll(user.user_id);
    await this.revokeGatewaySessions(user.user_id, 'revoked');
    return { status: true };
  }

  /**
   * AUTH_CONTRACT 9.2 — OTP on the new number while authenticated on the old.
   * The challenge is bound to this user, so nobody else can spend it.
   */
  async rebindStart(req, res) {
    const { user, session } = req.pre.auth;
    const { newPhone } = req.payload;
    if (!E164.test(newPhone)) {
      return res
        .response(errorEnvelope('INVALID_PHONE_FORMAT', 'newPhone must be in E.164 format'))
        .code(400);
    }
    if (newPhone === user.phone) {
      return res
        .response(errorEnvelope('SAME_PHONE', 'newPhone is already bound to this account'))
        .code(409);
    }
    if (await this.profileDB.getByPhone(newPhone)) {
      return res
        .response(errorEnvelope('PHONE_TAKEN', 'newPhone is bound to another account'))
        .code(409);
    }
    await this.otpRateLimits(newPhone, clientIp(req));
    const challenge = await this.sendOtp(
      () =>
        this.authProvider.startOtp({
          phone: newPhone,
          deviceId: session.deviceId,
          userId: user.user_id
        }),
      res
    );
    if (challenge.isBoom || !challenge.sessionId) return challenge;
    return {
      rebindSessionId: challenge.sessionId,
      resendAfterSec: challenge.resendAfterSec,
      expiresInSec: challenge.expiresInSec
    };
  }

  /**
   * AUTH_CONTRACT 9.3 — swap the bound number. `user_id`, `username` and every
   * session survive; the other devices are only nudged off their socket so
   * they reconnect (6.5 close 4003).
   */
  async rebindVerify(req, res) {
    const { user, session } = req.pre.auth;
    const { rebindSessionId, code } = req.payload;
    const verified = await this.authProvider.verifyOtp({
      sessionId: rebindSessionId,
      code,
      deviceId: session.deviceId
    });
    if (verified.userId !== user.user_id) {
      throw new AuthError(404, 'SESSION_NOT_FOUND', 'Unknown session');
    }
    const phoneTaken = () =>
      res.response(errorEnvelope('PHONE_TAKEN', 'newPhone is bound to another account')).code(409);
    // 9.3 step 2: somebody may have signed up on it between start and verify
    if (await this.profileDB.getByPhone(verified.phone)) return phoneTaken();
    let updated;
    try {
      updated = await this.profileDB.updateUser(user.user_id, {
        phone: verified.phone,
        phoneHash: sha256(verified.phone)
      });
    } catch (error) {
      if (error.code === 'PHONE_TAKEN') return phoneTaken();
      throw error;
    }
    // ponytail: the gateway's revoke route takes one device or all of them,
    // never "all but this one", so the rebinding device is nudged too. Harmless
    // - its credentials still resolve - and it saves a route change in a file
    // another agent owns this cycle.
    await this.revokeGatewaySessions(user.user_id, 'rebind');
    return {
      user_id: updated.user_id,
      username: updated.username || null,
      phone: updated.phone
    };
  }

  async usernameCheck(req) {
    const username = req.payload.username.toLowerCase();
    const invalid = validateUsername(username);
    if (invalid) {
      return { available: false, reason: invalid === 'USERNAME_RESERVED' ? 'reserved' : 'invalid' };
    }
    const owner = await this.profileDB.getUsernameHolder(username);
    if (owner && owner.user_id !== req.pre.auth.user.user_id) {
      return { available: false, reason: 'taken' };
    }
    return { available: true };
  }

  /**
   * Run the SMS bound part of a challenge, mapping gateway failures to 502/503
   * @param {() => Promise<import('./auth-provider/auth-provider').OtpChallenge>} start
   */
  // eslint-disable-next-line class-methods-use-this
  async sendOtp(start, res) {
    try {
      return await start();
    } catch (error) {
      if (error instanceof SmsGatewayError) {
        return res.response(errorEnvelope('SMS_GATEWAY_ERROR', error.message)).code(502);
      }
      if (error instanceof SmsGatewayUnavailableError) {
        return res.response(errorEnvelope('SMS_GATEWAY_UNAVAILABLE', error.message)).code(503);
      }
      throw error;
    }
  }

  /**
   * The three SMS budgets of AUTH_CONTRACT 10.1, shared by a login challenge
   * and a rebind challenge (same gateway bill either way).
   * @param {string} phone
   * @param {string} remoteAddress
   */
  async otpRateLimits(phone, remoteAddress) {
    const { otpRatePhoneHour, otpRatePhoneDay, otpRateIpHour } = this.options;
    const phoneKey = sha256(phone).slice(0, 32);
    await this.rateLimit(`otp:rate:phone:${phoneKey}:h`, otpRatePhoneHour, 3600, 'phone');
    await this.rateLimit(`otp:rate:phone:${phoneKey}:d`, otpRatePhoneDay, 86400, 'phone');
    await this.rateLimit(`otp:rate:ip:${remoteAddress}:h`, otpRateIpHour, 3600, 'ip');
  }

  /**
   * @param {string} key
   * @param {number} limit
   * @param {number} windowSec
   * @param {string} scope
   * @param {number} units how much of the budget this request spends
   */
  async rateLimit(key, limit, windowSec, scope, units = 1) {
    // ponytail: the cache counts by one, so a 100 hash lookup is 100 (pipelined)
    // incrs. One INCRBY on libs/cache would do it, when that file is free to touch.
    const counts = await Promise.all(
      Array.from({ length: units }, () => this.memCache.incr(key, windowSec))
    );
    const count = Math.max(...counts);
    if (count > limit) {
      const code = key.startsWith('otp:') ? 'OTP_RATE_LIMITED' : 'RATE_LIMITED';
      throw new AuthError(429, code, 'Too many requests. Try again later.', {
        retryAfterSec: windowSec,
        scope
      });
    }
  }

  /**
   * AUTH_CONTRACT 2.3: random 36 bit id, retry on collision, alarm on exhaustion.
   * @param {string} phone
   */
  async createUser(phone) {
    for (let attempt = 0; attempt < USER_ID_MAX_RETRY; attempt += 1) {
      // eslint-disable-next-line no-bitwise
      const userId = crypto.randomInt(0, 2 ** 36).toString(16).padStart(9, '0');
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.profileDB.existsUserId(userId))) {
        // eslint-disable-next-line no-await-in-loop
        return await this.profileDB.createUser({
          user_id: userId,
          phone,
          phoneHash: sha256(phone),
          username: null,
          usernameLower: null,
          usernameKeyHash: null,
          usernameChangedAt: null,
          displayName: null,
          avatarUrl: null,
          statusText: null,
          createdAt: new Date(),
          deletedAt: null
        });
      }
    }
    this.log.error('user_id space exhausted: 10 collisions in a row');
    throw new AuthError(500, 'INTERNAL_ERROR', 'Could not allocate a user id');
  }

  async shutdown() {
    await super.shutdown();
    await this.profileDB.dispose();
    await this.authProvider.dispose();
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResource(options)
    .then(async (context) => {
      await new ProfileMs(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Profile MS', error);
      process.exit(1);
    });
}

module.exports = {
  ProfileMs,
  parseOptions,
  initResource
};
