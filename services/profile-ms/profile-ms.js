const crypto = require('crypto');
const Joi = require('joi');
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
const { validateUsername } = require('./username');
const { hashSecret, sha256 } = require('../../helper');

const asMain = require.main === module;

const E164 = /^\+\d{8,15}$/;
const USERNAME_CHANGE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const USER_ID_MAX_RETRY = 10;

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
  cmd.option('--otp-rate-phone-hour <count>', 'OTP sends per phone per hour', (c) => Number(c), 5);
  cmd.option('--otp-rate-phone-day <count>', 'OTP sends per phone per day', (c) => Number(c), 15);
  cmd.option('--otp-rate-ip-hour <count>', 'OTP sends per ip per hour', (c) => Number(c), 20);
  cmd.option(
    '--profile-rate-hour <count>',
    'Profile field updates per user per hour',
    (c) => Number(c),
    50
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
    const { otpRatePhoneHour, otpRatePhoneDay, otpRateIpHour } = this.options;
    const phoneKey = sha256(phone).slice(0, 32);
    await this.rateLimit(`otp:rate:phone:${phoneKey}:h`, otpRatePhoneHour, 3600, 'phone');
    await this.rateLimit(`otp:rate:phone:${phoneKey}:d`, otpRatePhoneDay, 86400, 'phone');
    await this.rateLimit(`otp:rate:ip:${req.info.remoteAddress}:h`, otpRateIpHour, 3600, 'ip');

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
    await this.authProvider.revoke(accesskey);
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
        const taken = await this.profileDB.getByUsername(next);
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

    try {
      const updated = await this.profileDB.updateUser(user.user_id, updates);
      return selfProfile(updated);
    } catch (error) {
      if (error.code === 'USERNAME_TAKEN') {
        return res
          .response(errorEnvelope('USERNAME_TAKEN', 'That username is already taken'))
          .code(409);
      }
      throw error;
    }
  }

  async usernameCheck(req) {
    const username = req.payload.username.toLowerCase();
    const invalid = validateUsername(username);
    if (invalid) {
      return { available: false, reason: invalid === 'USERNAME_RESERVED' ? 'reserved' : 'invalid' };
    }
    const owner = await this.profileDB.getByUsername(username);
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
   * @param {string} key
   * @param {number} limit
   * @param {number} windowSec
   * @param {string} scope
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
