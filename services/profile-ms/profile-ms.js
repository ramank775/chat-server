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
const { TTL_SEC } = require('../../libs/delivery-manager/undelivered-queue');
const {
  EVENT_FLAGS, EnvelopeEvent, SERVER_EVENT_MARKER, serverNow
} = require('../../libs/v3-envelope');
const { validateUsername } = require('./username');
const { PRESENCE, canSee } = require('./presence');
const { bundleSchema, publicBundle, publishKeys, claimKeys } = require('./device-keys');
const {
  DISCOVERABILITY,
  DEFAULT_DISCOVERABILITY,
  addPhoneKeyOptions,
  phonePepper,
  phoneKey,
  pepperFingerprint,
  discoveryToken
} = require('./phone-key');
const { Timeline, addTimelineOptions } = require('./timeline');
const timelineDB = require('./database/timeline');
const crashReports = require('./crash-reports');
const { uuidv4, hashSecret, verifySecret, sha256, errorEnvelope } = require('../../helper');

/**
 * AUTH_CONTRACT 8.2 — every field a deleted account loses. The tombstone
 * keeps user_id and username, both reserved forever (8.3).
 */
const ERASED = {
  phoneKey: null,
  discoverability: null,
  discoveryTokens: null,
  usernameKeyHash: null,
  usernameChangedAt: null,
  displayName: null,
  avatarUrl: null,
  statusText: null,
  presence: null,
  lastSeenAt: null,
  createdAt: null
};

const asMain = require.main === module;

const E164 = /^\+\d{8,15}$/;
const USERNAME_CHANGE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const USER_ID_MAX_RETRY = 10;
// decision 208: no daily budget; the app looks up only numbers it doesn't
// know, each at most once per cooling period
const CONTACT_LOOKUP_MAX = 5000;
// decision 223: each entry costs a scrypt on every save, so a chosen list is
// a circle of people, not an address book
const CHOSEN_MAX = 500;
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
  cmd = addPhoneKeyOptions(cmd);
  cmd = addTimelineOptions(cmd);
  cmd = crashReports.addCrashReportOptions(cmd);
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
  cmd.option('--notification-ms-endpoint <notification-ms-endpoint>', 'Base url for notification service');
  cmd.option('--media-ms-endpoint <media-ms-endpoint>', 'Base url for media service');
  cmd.option('--otp-rate-phone-hour <count>', 'OTP sends per phone per hour', (c) => Number(c), 5);
  cmd.option('--otp-rate-phone-day <count>', 'OTP sends per phone per day', (c) => Number(c), 15);
  cmd.option('--otp-rate-ip-hour <count>', 'OTP sends per ip per hour', (c) => Number(c), 20);
  cmd.option(
    '--profile-rate-hour <count>',
    'Profile field updates per user per hour',
    (c) => Number(c),
    50
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
  // decision 223: short windows only, never a daily budget (decision 208)
  cmd.option(
    '--phone-lookup-min <count>',
    'contacts/lookup requests per user per minute',
    (c) => Number(c),
    20
  );
  cmd.option(
    '--chosen-check-min <count>',
    'chosen-list checks (one scrypt each) per user per minute; past it a match looks unknown',
    (c) => Number(c),
    300
  );
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options)
    .then(initHttpResource)
    .then(profileDB.initializeDatabase)
    .then(timelineDB.initialize)
    .then(crashReports.initialize)
    .then(initializeAuthProvider)
    .then(initMemCache)
    .then(eventStore.initializeEventStore({ producer: true }));
}

/**
 * `Authorization: Bearer <accesskey>` (REST) or
 * `Sec-WebSocket-Protocol: accesskey.<accesskey>` (WS upgrade, AUTH_CONTRACT 6.1)
 * @param {import('fastify').FastifyRequest} req
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
 * @param {import('fastify').FastifyRequest} req
 */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.ip;
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
 * The owner view of a profile (AUTH_CONTRACT 4.4). No `phone`: the server
 * keeps only its key (decision 223); the app knows its own number.
 * @param {import('./database/profile/profile-db').User} user
 */
function selfProfile(user) {
  return {
    user_id: user.user_id,
    username: user.username || null,
    displayName: user.displayName || null,
    avatarUrl: user.avatarUrl || null,
    statusText: user.statusText || null,
    discoverability: user.discoverability || DEFAULT_DISCOVERABILITY,
    // SYNC_PROTOCOL §22: who sees my last seen and online
    presence: user.presence || 'everyone',
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
    this.newMessageTopic = this.options.newMessageTopic;
    // ponytail: channel-ms exposes no "channels of a user" internal route and
    // libs/channel-service-client only answers `isMember`, so the fanout reads
    // the public list route per channel kind. Collapse to one internal call
    // when channel-ms grows one.
    this.channelClient = new HttpClient(this.options.channelMsEndpoint);
    this.gatewayClient = new HttpClient(this.options.gatewayEndpoint);
    this.notificationClient = new HttpClient(this.options.notificationMsEndpoint);
    this.mediaClient = new HttpClient(this.options.mediaMsEndpoint);
    this.pepper = phonePepper(this.options);
    this.timeline = new Timeline(this);
    this.crashReports = new crashReports.CrashReports(this);
  }

  /** The stored form of a lookup hash (decision 223). */
  keyOfHash(phoneHash) {
    return phoneKey(this.pepper, phoneHash);
  }

  /** The stored form of an E.164 number from a request. */
  keyOfPhone(phone) {
    return this.keyOfHash(sha256(phone));
  }

  async init() {
    await this.profileDB.migratePhones(
      (phoneHash) => this.keyOfHash(phoneHash),
      pepperFingerprint(this.pepper)
    );
    await super.init();

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
      // `phone` from decision 223 on; an older app sends none
      payload(Joi.object({ sessionId: Joi.string().required(), phone: Joi.string() }))
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

    // Dev runs read the mock sender's log. Never on without --expose-dev-otp.
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

    this.addRoute('/keys/me', 'PUT', this.guard(this.putKeys), {
      pre: [this.authPre()], validate: { payload: bundleSchema }
    });
    this.addRoute('/keys/{userId}', 'GET', this.guard(this.getKeys), {
      pre: [this.authPre()],
      validate: { params: Joi.object({ userId: Joi.string().pattern(/^[0-9a-f]{9}$/).required() }) }
    });
    this.addRoute('/keys/{userId}/claim', 'POST', this.guard(this.claimDeviceKeys), {
      pre: [this.authPre()],
      validate: {
        params: Joi.object({ userId: Joi.string().pattern(/^[0-9a-f]{9}$/).required() }),
        payload: Joi.object({ deviceId: Joi.string().max(256).required(), generation: Joi.string().uuid().required() }).required()
      }
    });

    this.addRoute('/users/me', 'PATCH', this.guard(this.patchMe), {
      pre: [this.authPre(false)],
      validate: {
        payload: Joi.object({
          username: Joi.string().allow(null),
          usernameKey: Joi.string().allow(null),
          displayName: Joi.string().allow(null, ''),
          avatarUrl: Joi.string().allow(null, ''),
          statusText: Joi.string().allow(null, ''),
          presence: Joi.string().valid(...PRESENCE),
          // SYNC_PROTOCOL 11.4: the client's outbound queue adds these; a
          // profile edit is a plain overwrite, so a replay needs no dedup
          op_id: Joi.string().uuid(),
          client_timestamp_ms: Joi.number().integer()
        })
          .min(1)
          .required()
      }
    });

    // SYNC_PROTOCOL §22: the gateway's questions about presence
    this.addInternalRoute('/presence', 'POST', this.guard(this.presence), {
      validate: {
        payload: Joi.object({
          user_id: Joi.string().required(),
          viewers: Joi.array().items(Joi.string()).max(1000).default([]),
          seen: Joi.boolean().default(false)
        }).required()
      }
    });

    this.addRoute('/users/username/check', 'POST', this.guard(this.usernameCheck), {
      pre: [this.authPre(false)],
      validate: { payload: Joi.object({ username: Joi.string().required() }).required() }
    });

    this.addRoute('/users/me/discoverability', 'PUT', this.guard(this.putDiscoverability), {
      pre: [this.authPre()],
      validate: {
        payload: Joi.object({
          mode: Joi.string().valid(...DISCOVERABILITY).required(),
          phoneHashes: Joi.array()
            .items(Joi.string().pattern(SHA256_HEX))
            .max(CHOSEN_MAX)
            .when('mode', { is: 'chosen', then: Joi.required(), otherwise: Joi.forbidden() })
        }).required()
      }
    });

    this.addRoute('/users/me/delete', 'POST', this.guard(this.deleteMe), {
      pre: [this.authPre()],
      validate: { payload: Joi.object({ confirmation: Joi.string().required() }).required() }
    });

    // runbook "Deleting an account by email": the operator, after the SMS check.
    // The username must match too, so a typo in the phone deletes nobody.
    this.addInternalRoute('/users/delete', 'POST', this.guard(this.deleteByPhone), {
      validate: {
        payload: Joi.object({
          phone: Joi.string().pattern(E164).required(),
          username: Joi.string().allow(null).required()
        }).required()
      }
    });

    // message-delivery's fanout in the microservice layout (the monolith
    // calls fanoutDevices in process)
    this.addInternalRoute('/devices', 'POST', (req) => this.fanoutDevices(req.payload.user_ids), {
      validate: {
        payload: Joi.object({ user_ids: Joi.array().items(Joi.string()).required() }).required()
      }
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

    this.timeline.addRoutes();
    this.crashReports.addRoutes();
  }

  /**
   * The devices a fanout to [userIds] is for, from the session rows: a device
   * counts from sign-in, before its first socket, and through a logout for as
   * long as the timeline keeps frames, so it finds them when it signs back in.
   * ponytail: a device replaced by a sign-in elsewhere, or an account deleted,
   * keeps getting frames queued until the TTL; nobody pulls them. Record why a
   * session was revoked if that waste ever shows.
   * @param {string[]} userIds
   * @returns {Promise<{user_id: string, deviceId: string}[]>}
   */
  fanoutDevices(userIds) {
    return this.context.authDB.devicesOf(userIds, new Date(Date.now() - TTL_SEC * 1000));
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
   * @returns {{assign: string, method: Function}} a `pre` entry for `addRoute`
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
   * @param {import('fastify').FastifyRequest} req
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
    const key = this.keyOfPhone(phone);
    await this.otpRateLimits(key, clientIp(req));

    const challenge = await this.sendOtp(
      () => this.authProvider.startOtp({ phone, phoneKey: key, deviceId }),
      res
    );
    if (!challenge.sessionId) return challenge;
    const existing = await this.profileDB.getByPhoneKey(key);
    return {
      sessionId: challenge.sessionId,
      resendAfterSec: challenge.resendAfterSec,
      expiresInSec: challenge.expiresInSec,
      isExistingAccount: !!existing
    };
  }

  async otpResend(req, res) {
    const { sessionId, phone } = req.payload;
    // Decision 223: the server keeps no number to resend to. An app that
    // sends none starts over with /otp/send, as for any 410.
    if (!phone) throw new AuthError(410, 'RESEND_UNAVAILABLE', 'Request a new code');
    const key = this.keyOfPhone(phone);
    // a resend is an SMS like any other: same budgets as /otp/send
    const challenge = await this.sendOtp(
      () =>
        this.authProvider.resendOtp(sessionId, { phone, phoneKey: key }, () =>
          this.otpRateLimits(key, clientIp(req))
        ),
      res
    );
    if (!challenge.sessionId) return challenge;
    const existing = await this.profileDB.getByPhoneKey(key);
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
    let user = await this.profileDB.getByPhoneKey(verified.phoneKey);
    const isNew = !user;
    if (isNew) {
      user = await this.createUser(verified.phoneKey);
    }
    const issued = await this.authProvider.issueSession(user.user_id, deviceId);
    if (!isNew) await this.retireOtherDevices(user.user_id, deviceId);
    return {
      status: true,
      user_id: user.user_id,
      username: user.username || null,
      ...issued,
      isNew
    };
  }

  /**
   * Decision 183: one active phone per account this release. A login signs
   * every other phone out and withdraws its keys and push endpoint. Sessions,
   * keys, push and fanout all stay keyed by device, so allowing more phones
   * means dropping this call and adding device approval, not a redesign.
   * @param {string} userId
   * @param {string} deviceId the phone that just signed in
   */
  async retireOtherDevices(userId, deviceId) {
    const others = new Set((await this.context.authDB.devicesOf([userId], new Date()))
      .map((session) => session.deviceId).filter((other) => other !== deviceId));
    await this.authProvider.revokeAll(userId, deviceId);
    await this.context.authDB.deleteDeviceKeys(userId, { exceptDeviceId: deviceId });
    await Promise.all([...others].map(async (other) => {
      await this.revokeGatewaySessions(userId, 'revoked', other);
      await this.revokePushTopics(userId, other);
    }));
  }

  async sessionRefresh(req) {
    const { refreshToken, deviceId } = req.payload;
    return this.authProvider.refreshSession(refreshToken, deviceId);
  }

  async putKeys(req) {
    const { session, user } = req.pre.auth;
    await this.rateLimit(`keys:write:${user.user_id}:h`, 60, 3600, 'user');
    const result = await publishKeys(this.context.authDB, user.user_id, session.deviceId, req.payload);
    // An in-flight registration cannot outlive a concurrent account deletion
    // or a newer login that signed this phone out (decision 183).
    const live = await this.authProvider.verifyAccessKey(extractAccesskey(req)).catch(() => null);
    if (!live || !(await this.profileDB.getByUserId(user.user_id))) {
      await this.context.authDB.deleteDeviceKeys(user.user_id, { deviceId: session.deviceId });
      throw new AuthError(401, 'INVALID_ACCESSKEY', 'This phone was signed out');
    }
    return result;
  }

  async keyLookupBudget(req) {
    await this.rateLimit(`keys:read:${req.pre.auth.user.user_id}:h`, 1000, 3600, 'user');
    await this.rateLimit(`keys:read:ip:${clientIp(req)}:h`, 2000, 3600, 'ip');
    if (!(await this.profileDB.getByUserId(req.params.userId))) {
      throw new AuthError(404, 'KEYS_NOT_FOUND', 'The account is unavailable');
    }
  }

  async getKeys(req) {
    await this.keyLookupBudget(req);
    const records = await this.context.authDB.listDeviceKeys(req.params.userId);
    return { devices: records.map(publicBundle) };
  }

  async claimDeviceKeys(req) {
    await this.keyLookupBudget(req);
    return claimKeys(this.context.authDB, req.params.userId, req.payload.deviceId, req.payload.generation);
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
      // 4.6 side effect 3: deregister this device's push endpoint
      await this.revokePushTopics(session.user_id, session.deviceId);
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
    if (has('presence')) updates.presence = payload.presence;

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
    if (has('avatarUrl') && user.avatarUrl !== updated.avatarUrl) {
      await this.deleteProfilePhoto(user.user_id, user.avatarUrl);
    }
    await this.fanoutProfileChange(updated, updates, now);
    if (has('presence') && user.presence !== updated.presence) {
      // §22: whoever watches this user sees the new setting now
      try {
        await this.gatewayClient.post('/_internal/presence/refresh', { user_id: user.user_id });
      } catch (error) {
        this.log.error(`Presence refresh failed for ${user.user_id}: ${error.message}`);
      }
    }
    return selfProfile(updated);
  }

  /**
   * SYNC_PROTOCOL §22, from the gateway: `user_id`'s last seen, and which of
   * `viewers` may see their presence. `seen`: they just came online or
   * left, so their last seen is now.
   */
  async presence(req) {
    const { user_id: userId, viewers, seen } = req.payload;
    const target = seen
      ? await this.profileDB.updateUser(userId, { lastSeenAt: new Date() })
      : await this.profileDB.getByUserId(userId);
    if (!target) return { last_seen_ms: 0, viewers: [] };
    // decision 219: "contacts" are connections; a block hides it both ways
    const [users, { connected, blocked }] = await Promise.all([
      Promise.all(viewers.map((id) => this.profileDB.getByUserId(id))),
      viewers.length
        ? this.channelClient.post('/_internal/connections/pairs', { user_id: userId, users: viewers })
        : { connected: [], blocked: [] }
    ]);
    return {
      last_seen_ms: target.lastSeenAt ? new Date(target.lastSeenAt).getTime() : 0,
      viewers: viewers.filter((id, i) => users[i]
        && canSee(target, users[i], connected.includes(id), blocked.includes(id)))
    };
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
    // the internal list: this runs on the user's behalf, not on a request of
    // theirs, so it must not go through the authenticated prefix. Groups are
    // the only rows left (trim 4), so one call is the whole set.
    const channels = await this.channelClient.get('/_internal/', {
      headers: { 'x-user': userId }
    });
    const members = new Set();
    let channelId = null;
    // the same view the client gets: `channel_id`, and members as user ids
    channels.forEach((channel) => {
      channelId = channelId || channel.channel_id;
      channel.members.forEach((id) => members.add(id));
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
    const nowMs = serverNow();
    const envelope = {
      opId: uuidv4(),
      channelId,
      payload: encodeServerEvent(body),
      senderUserId: '', // server authored
      serverTimestampMs: nowMs,
      // Decision 218: class EVENT, which wakes nobody; no SILENT bit needed.
      flags: EVENT_FLAGS
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
   * AUTH_CONTRACT 4.6 step 3 / 8.2 step 4 — notification-ms owns push_topics,
   * so deregistering it is a cross-service call. Best effort: the accesskey
   * is already revoked either way.
   * @param {string} userId
   * @param {string} [deviceId] limit to one device; omitted = every device
   */
  async revokePushTopics(userId, deviceId = undefined) {
    try {
      await this.notificationClient.post('/_internal/push/topics/delete', {
        user_id: userId,
        ...(deviceId ? { deviceId } : {})
      });
    } catch (error) {
      this.log.error(`Push topic deregister failed for ${userId}: ${error.message}`);
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
   * no live account, or whose account may not be found by this caller
   * (decision 223), are simply absent; negatives are never reported (7.1).
   * Every phone lookup of the app comes here, a shared contact card too.
   */
  async contactsLookup(req, res) {
    const { user } = req.pre.auth;
    const { phoneHashes } = req.payload;
    if (phoneHashes.length > CONTACT_LOOKUP_MAX) {
      return res
        .response(errorEnvelope('BATCH_TOO_LARGE', `At most ${CONTACT_LOOKUP_MAX} hashes per request`))
        .code(400);
    }
    await this.rateLimit(
      `lookup:rate:${user.user_id}:m`,
      this.options.phoneLookupMin,
      60,
      'user'
    );
    const hashOf = new Map(phoneHashes.map((hash) => [this.keyOfHash(hash), hash]));
    const found = (await this.profileDB.getByPhoneKeys([...hashOf.keys()]))
      // the caller's own number is in their own address book; nothing to chat about
      .filter((match) => match.user_id !== user.user_id);
    const findable = await this.findableBy(user, found);
    return {
      matches: found
        .filter((_, i) => findable[i])
        .map((match) => ({
          phoneHash: hashOf.get(match.phoneKey),
          user_id: match.user_id,
          username: match.username || null
        }))
    };
  }

  /**
   * Decision 223: may `searcher` find each of `owners` by phone? `nobody`
   * never, `everyone` always, `chosen` when the searcher's own number is on
   * the owner's list, checked by recomputing its token.
   * ponytail: one scrypt per `chosen` match. Past the per-minute budget the
   * rest answer no, which the app takes as unknown and asks again after its
   * 15 minute cooldown. A cache per (owner, searcher) if real lists outgrow it.
   * @param {import('./database/profile/profile-db').User} searcher
   * @param {import('./database/profile/profile-db').User[]} owners
   * @returns {Promise<boolean[]>}
   */
  async findableBy(searcher, owners) {
    const chosen = owners.filter((owner) => owner.discoverability === 'chosen').length;
    let budget = 0;
    if (chosen) {
      const used = await this.memCache.incr(`lookup:chosen:${searcher.user_id}:m`, 60, chosen);
      budget = Math.max(0, this.options.chosenCheckMin - (used - chosen));
    }
    return Promise.all(owners.map(async (owner) => {
      const mode = owner.discoverability || DEFAULT_DISCOVERABILITY;
      if (mode !== 'chosen') return mode === 'everyone';
      if (budget <= 0) return false;
      budget -= 1;
      const token = await discoveryToken(this.pepper, owner.user_id, searcher.phoneKey);
      return this.profileDB.hasDiscoveryToken(owner.user_id, token);
    }));
  }

  /**
   * Decision 223: who may find this account by phone. `chosen` takes the
   * whole list each time, as SHA-256 hashes like a lookup; only their tokens
   * are kept, so the list cannot be read back (the app keeps its own copy).
   */
  async putDiscoverability(req) {
    const { user } = req.pre.auth;
    const { mode, phoneHashes = [] } = req.payload;
    // each save is up to CHOSEN_MAX scrypts
    await this.rateLimit(`discoverability:rate:${user.user_id}:h`, 20, 3600, 'user');
    const tokens = await Promise.all([...new Set(phoneHashes)].map(
      (hash) => discoveryToken(this.pepper, user.user_id, this.keyOfHash(hash))
    ));
    await this.profileDB.updateUser(user.user_id, {
      discoverability: mode,
      discoveryTokens: mode === 'chosen' ? tokens : null
    });
    return { mode, count: tokens.length };
  }

  async deleteMe(req, res) {
    const { user } = req.pre.auth;
    if (req.payload.confirmation !== `DELETE ${user.username}`) {
      return res
        .response(errorEnvelope('INVALID_CONFIRMATION', 'confirmation must be "DELETE <username>"'))
        .code(400);
    }
    await this.eraseAccount(user);
    return { status: true };
  }

  /** The in-app delete, run by the operator for an email request (decision 197). */
  async deleteByPhone(req, res) {
    const { phone, username } = req.payload;
    const user = await this.profileDB.getByPhoneKey(this.keyOfPhone(phone));
    if (!user || (user.username || '').toLowerCase() !== (username || '').toLowerCase()) {
      return res
        .response(errorEnvelope('USER_NOT_FOUND', 'no account with that phone and username'))
        .code(404);
    }
    await this.eraseAccount(user);
    return { status: true, user_id: user.user_id };
  }

  /**
   * AUTH_CONTRACT 8.2 — tombstone the account. The row keeps `user_id` and
   * `usernameLower` (both stay reserved by their unique indexes) and leaves
   * the partial phone index, which is what releases the number for a fresh
   * signup.
   */
  async eraseAccount(user) {
    // 8.2 steps 1-2: the row stays as the tombstone, only user_id and username
    await this.profileDB.updateUser(user.user_id, { ...ERASED, deletedAt: new Date() });
    await this.authProvider.revokeAll(user.user_id);
    await this.context.authDB.deleteDeviceKeys(user.user_id);
    await this.revokeGatewaySessions(user.user_id, 'revoked');
    // 8.2 step 4: every device's push endpoint goes with the account
    await this.revokePushTopics(user.user_id);
    await this.leaveAllGroups(user.user_id);
    await this.deleteProfilePhoto(user.user_id, user.avatarUrl);
    await this.timeline.eraseAuthor(user.user_id);
  }

  /** AUTH_CONTRACT 8.2 step 5 — channel-ms owns membership. Best effort, like the two above. */
  async leaveAllGroups(userId) {
    try {
      await this.channelClient.post('/_internal/members/remove', { user_id: userId });
    } catch (error) {
      this.log.error(`Group removal failed for ${userId}: ${error.message}`);
    }
  }

  /** media-ms deletes the photo only if [userId] uploaded it. Best effort. */
  async deleteProfilePhoto(userId, avatarUrl) {
    if (!avatarUrl) return;
    try {
      await this.mediaClient.post('/_internal/files/delete', {
        fileId: avatarUrl.split('#')[0],
        owner: userId
      });
    } catch (error) {
      this.log.error(`Profile photo delete failed for ${userId}: ${error.message}`);
    }
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
    const key = this.keyOfPhone(newPhone);
    if (key === user.phoneKey) {
      return res
        .response(errorEnvelope('SAME_PHONE', 'newPhone is already bound to this account'))
        .code(409);
    }
    // before the PHONE_TAKEN answer, which says whether a number has an account
    await this.otpRateLimits(key, clientIp(req));
    if (await this.profileDB.getByPhoneKey(key)) {
      return res
        .response(errorEnvelope('PHONE_TAKEN', 'newPhone is bound to another account'))
        .code(409);
    }
    const challenge = await this.sendOtp(
      () =>
        this.authProvider.startOtp({
          phone: newPhone,
          phoneKey: key,
          deviceId: session.deviceId,
          userId: user.user_id
        }),
      res
    );
    if (!challenge.sessionId) return challenge;
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
    if (await this.profileDB.getByPhoneKey(verified.phoneKey)) return phoneTaken();
    let updated;
    try {
      updated = await this.profileDB.updateUser(user.user_id, { phoneKey: verified.phoneKey });
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
      username: updated.username || null
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
   * @param {string} key the number's phone key, so the cache holds no number either
   * @param {string} remoteAddress
   */
  async otpRateLimits(key, remoteAddress) {
    const { otpRatePhoneHour, otpRatePhoneDay, otpRateIpHour } = this.options;
    const phone = key.slice(0, 32);
    await this.rateLimit(`otp:rate:phone:${phone}:h`, otpRatePhoneHour, 3600, 'phone');
    await this.rateLimit(`otp:rate:phone:${phone}:d`, otpRatePhoneDay, 86400, 'phone');
    await this.rateLimit(`otp:rate:ip:${remoteAddress}:h`, otpRateIpHour, 3600, 'ip');
  }

  /**
   * @param {string} key
   * @param {number} limit
   * @param {number} windowSec
   * @param {string} scope
   * @param {number} units how much of the budget this request spends
   */
  async rateLimit(key, limit, windowSec, scope) {
    const count = await this.memCache.incr(key, windowSec);
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
   * @param {string} key the phone key
   */
  async createUser(key) {
    for (let attempt = 0; attempt < USER_ID_MAX_RETRY; attempt += 1) {
      // eslint-disable-next-line no-bitwise
      const userId = crypto.randomInt(0, 2 ** 36).toString(16).padStart(9, '0');
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.profileDB.existsUserId(userId))) {
        // eslint-disable-next-line no-await-in-loop
        return await this.profileDB.createUser({
          user_id: userId,
          phoneKey: key,
          username: null,
          usernameLower: null,
          usernameKeyHash: null,
          usernameChangedAt: null,
          displayName: null,
          avatarUrl: null,
          statusText: null,
          discoverability: null,
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
    this.timeline.stop();
    this.crashReports.stop();
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
  initResource,
  isUsernameGated
};
