const crypto = require('crypto');
const { uuidv4, hashSecret, verifySecret, sha256 } = require('../../../helper');
const { IAuthProvider, AuthError } = require('./auth-provider');

const OTP_EXPIRES_IN_SEC = 600;
const OTP_RESEND_AFTER_SEC = 30;
const OTP_MAX_ATTEMPTS = 5;
const ACCESSKEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function sixDigitCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function secondsUntil(date, now) {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 1000));
}

/**
 * Phone + OTP auth, no third party identity provider (AUTH_CONTRACT 1.2).
 */
class SelfHostedOtpAuthProvider extends IAuthProvider {
  /** @type {import('../database/auth/auth-db').IAuthDB} */
  #db;

  /** @type {import('./sms-sender/sms-sender').ISmsSender} */
  #sms;

  constructor(context) {
    super(context);
    this.#db = context.authDB;
    this.#sms = context.smsSender;
  }

  async startOtp({ phone, deviceId, userId = null }) {
    const now = new Date();
    const active = await this.#db.getActiveOtpSession(phone, deviceId, now);
    // a login challenge is never reused as a rebind challenge (or the other
    // way round): the binding is what 9.3 step 1 checks
    if (active && (active.userId || null) === userId) {
      // 3.1 idempotency: no second code, no second SMS, no second gateway bill
      return {
        sessionId: active.sessionId,
        resendAfterSec: secondsUntil(active.resendAfter, now),
        expiresInSec: secondsUntil(active.expiresAt, now),
        phone
      };
    }
    const sessionId = uuidv4();
    const code = sixDigitCode();
    // send before the insert so a gateway failure leaves no phantom session (12)
    await this.#sms.send({ phone, code });
    await this.#db.createOtpSession({
      sessionId,
      phone,
      deviceId,
      userId,
      codeHash: await hashSecret(code),
      attempts: 0,
      consumed: false,
      resendAfter: new Date(now.getTime() + OTP_RESEND_AFTER_SEC * 1000),
      expiresAt: new Date(now.getTime() + OTP_EXPIRES_IN_SEC * 1000),
      createdAt: now
    });
    return {
      sessionId,
      resendAfterSec: OTP_RESEND_AFTER_SEC,
      expiresInSec: OTP_EXPIRES_IN_SEC,
      phone
    };
  }

  async resendOtp(sessionId) {
    const now = new Date();
    const session = await this.#liveOtpSession(sessionId, now);
    if (session.resendAfter > now) {
      return {
        sessionId,
        resendAfterSec: secondsUntil(session.resendAfter, now),
        expiresInSec: secondsUntil(session.expiresAt, now),
        phone: session.phone
      };
    }
    const code = sixDigitCode();
    await this.#sms.send({ phone: session.phone, code });
    // the prior code becomes invalid immediately; the attempt count carries forward (3.3)
    await this.#db.updateOtpSession(sessionId, {
      codeHash: await hashSecret(code),
      resendAfter: new Date(now.getTime() + OTP_RESEND_AFTER_SEC * 1000)
    });
    return {
      sessionId,
      resendAfterSec: OTP_RESEND_AFTER_SEC,
      expiresInSec: secondsUntil(session.expiresAt, now),
      phone: session.phone
    };
  }

  async verifyOtp({ sessionId, code, deviceId }) {
    const now = new Date();
    const session = await this.#liveOtpSession(sessionId, now, deviceId);
    if (session.attempts >= OTP_MAX_ATTEMPTS) {
      throw this.#lockedError(session, now);
    }
    if (!(await verifySecret(code, session.codeHash))) {
      const updated = await this.#db.incrementOtpAttempts(sessionId);
      if (updated && updated.attempts >= OTP_MAX_ATTEMPTS) {
        throw this.#lockedError(session, now);
      }
      throw new AuthError(401, 'INVALID_CODE', 'The code is not valid');
    }
    const consumed = await this.#db.consumeOtpSession(sessionId);
    if (!consumed) {
      throw new AuthError(410, 'SESSION_CONSUMED', 'This session was already verified');
    }
    return { phone: session.phone, deviceId: session.deviceId, userId: session.userId || null };
  }

  async issueSession(userId, deviceId) {
    const now = new Date();
    const accesskey = uuidv4();
    const refreshToken = `rt_${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(now.getTime() + ACCESSKEY_TTL_MS);
    const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
    // one session per (user_id, deviceId): issuing invalidates the prior accesskey (4.1)
    await this.#db.upsertSession({
      user_id: userId,
      deviceId,
      accesskey,
      refreshTokenHash: sha256(refreshToken),
      createdAt: now,
      expiresAt,
      refreshTokenExpiresAt,
      revokedAt: null
    });
    return {
      accesskey,
      refreshToken,
      accesskeyExpiresAt: expiresAt.getTime(),
      refreshTokenExpiresAt: refreshTokenExpiresAt.getTime()
    };
  }

  async refreshSession(refreshToken, deviceId) {
    const now = new Date();
    const accesskey = uuidv4();
    const nextToken = `rt_${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(now.getTime() + ACCESSKEY_TTL_MS);
    const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
    // match and replace in a single atomic write: a replayed token matches nothing (4.3)
    const rotated = await this.#db.rotateSession(
      sha256(refreshToken),
      deviceId,
      {
        accesskey,
        refreshTokenHash: sha256(nextToken),
        expiresAt,
        refreshTokenExpiresAt
      },
      now
    );
    if (!rotated) {
      throw new AuthError(401, 'INVALID_REFRESH_TOKEN', 'refresh token is not valid');
    }
    return {
      user_id: rotated.user_id,
      accesskey,
      refreshToken: nextToken,
      accesskeyExpiresAt: expiresAt.getTime(),
      refreshTokenExpiresAt: refreshTokenExpiresAt.getTime()
    };
  }

  async verifyAccessKey(accesskey) {
    // ponytail: one indexed mongo read per authenticated request. Add a shared
    // (redis) accesskey cache when the read shows up in the latency budget; an
    // in-process cache would keep revoked keys alive on the other replicas.
    const session = await this.#db.getLiveSessionByAccesskey(accesskey, new Date());
    if (!session) {
      throw new AuthError(401, 'INVALID_ACCESSKEY', 'accesskey is not valid');
    }
    return session;
  }

  async revoke(accesskey) {
    await this.#db.revokeSessionByAccesskey(accesskey);
  }

  async revokeAll(userId) {
    await this.#db.revokeAllSessions(userId);
  }

  async #liveOtpSession(sessionId, now, deviceId) {
    const session = await this.#db.getOtpSession(sessionId);
    if (!session || (deviceId && session.deviceId !== deviceId)) {
      throw new AuthError(404, 'SESSION_NOT_FOUND', 'Unknown session');
    }
    if (session.consumed) {
      throw new AuthError(410, 'SESSION_CONSUMED', 'This session was already verified');
    }
    if (session.expiresAt <= now) {
      throw new AuthError(410, 'SESSION_EXPIRED', 'This session has expired');
    }
    return session;
  }

  // eslint-disable-next-line class-methods-use-this
  #lockedError(session, now) {
    return new AuthError(423, 'SESSION_LOCKED', 'Too many wrong codes, request a new code', {
      retryAfterSec: secondsUntil(session.expiresAt, now),
      scope: 'session'
    });
  }

  async dispose() {
    await this.#sms.dispose();
    await this.#db.dispose();
  }
}

function addOptions(cmd) {
  return cmd;
}

module.exports = {
  code: 'self-hosted-otp',
  addOptions,
  Implementation: SelfHostedOtpAuthProvider,
  OTP_EXPIRES_IN_SEC,
  OTP_RESEND_AFTER_SEC,
  OTP_MAX_ATTEMPTS
};
