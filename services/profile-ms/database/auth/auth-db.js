/* eslint-disable class-methods-use-this */

/**
 * @typedef {Object} OtpSession
 * @property {string} sessionId
 * @property {string} phone E.164
 * @property {string} deviceId
 * @property {string} codeHash
 * @property {number} attempts wrong code counter, locked at 5 (AUTH_CONTRACT 10.3)
 * @property {boolean} consumed
 * @property {Date} resendAfter
 * @property {Date} expiresAt
 * @property {Date} createdAt carries the TTL index
 */

/**
 * @typedef {Object} Session
 * @property {string} user_id
 * @property {string} deviceId
 * @property {string} accesskey UUID v4
 * @property {string} refreshTokenHash sha256 of the `rt_` prefixed token
 * @property {Date} createdAt
 * @property {Date} expiresAt accesskey expiry (30d)
 * @property {Date} refreshTokenExpiresAt (90d)
 * @property {Date?} revokedAt
 */

/**
 * @abstract
 * Interface for Auth Database (AUTH_CONTRACT 3 and 4: `otp_sessions` + `sessions`)
 */
class IAuthDB {
  /**
   * Auth Database interface
   * @param {*} context
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IAuthDB) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * @abstract
   * @param {OtpSession} _session
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async createOtpSession(_session) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * @param {string} _sessionId
   * @returns {Promise<OtpSession|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async getOtpSession(_sessionId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Find the live OTP session of a (phone, deviceId) pair whose resend window has
   * not elapsed; used for the AUTH_CONTRACT 3.1 idempotency rule.
   * @param {string} _phone
   * @param {string} _deviceId
   * @param {Date} _now
   * @returns {Promise<OtpSession|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async getActiveOtpSession(_phone, _deviceId, _now) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * @param {string} _sessionId
   * @param {Partial<OtpSession>} _updates
   * @returns {Promise<OtpSession|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async updateOtpSession(_sessionId, _updates) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Atomically record a wrong code attempt
   * @param {string} _sessionId
   * @returns {Promise<OtpSession|null>} the session after the increment
   */
  // eslint-disable-next-line no-unused-vars
  async incrementOtpAttempts(_sessionId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Atomically mark an OTP session consumed (one shot, AUTH_CONTRACT 3.2)
   * @param {string} _sessionId
   * @returns {Promise<OtpSession|null>} null when it was already consumed
   */
  // eslint-disable-next-line no-unused-vars
  async consumeOtpSession(_sessionId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Create or replace the session of a (user_id, deviceId) pair
   * @param {Session} _session
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async upsertSession(_session) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Resolve a live (not expired, not revoked) accesskey
   * @param {string} _accesskey
   * @param {Date} _now
   * @returns {Promise<Session|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async getLiveSessionByAccesskey(_accesskey, _now) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Single use refresh token rotation: match and replace in one atomic write so a
   * replayed token can never match twice (AUTH_CONTRACT 4.3).
   * @param {string} _refreshTokenHash
   * @param {string} _deviceId
   * @param {Partial<Session>} _next
   * @param {Date} _now
   * @returns {Promise<Session|null>} the rotated session, null on replay/expiry/mismatch
   */
  // eslint-disable-next-line no-unused-vars
  async rotateSession(_refreshTokenHash, _deviceId, _next, _now) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Revoke by accesskey. Idempotent.
   * @param {string} _accesskey
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async revokeSessionByAccesskey(_accesskey) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Revoke every live session of a user (AUTH_CONTRACT 8.2 step 3).
   * @param {string} _userId
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async revokeAllSessions(_userId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Initialize the database instance
   */
  async init() {
    throw new Error('Not implemented Exception');
  }

  /**
   * @abstract
   * Dispose the database internal resources
   */
  async dispose() {
    throw new Error('Method not implemented');
  }
}

module.exports = {
  IAuthDB
};
