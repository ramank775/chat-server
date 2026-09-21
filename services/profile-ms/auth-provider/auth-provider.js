/* eslint-disable max-classes-per-file */
/* eslint-disable class-methods-use-this */

/**
 * @typedef {import('../database/auth/auth-db').Session} Session
 */

/**
 * @typedef {Object} IssuedSession
 * @property {string} accesskey
 * @property {string} refreshToken
 * @property {number} accesskeyExpiresAt ms epoch
 * @property {number} refreshTokenExpiresAt ms epoch
 */

/**
 * @typedef {Object} OtpChallenge
 * @property {string} sessionId
 * @property {number} resendAfterSec
 * @property {number} expiresInSec
 * @property {string} phone
 */

/**
 * @abstract
 * Owns the OTP challenge and the session credentials (AUTH_CONTRACT 3 and 4).
 */
class IAuthProvider {
  /**
   * @param {{authDB: import('../database/auth/auth-db').IAuthDB; options: {[key: string]: *}}} context
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IAuthProvider) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * Start an OTP challenge, sending the code over SMS
   * @param {{phone: string, deviceId: string}} _args
   * @returns {Promise<OtpChallenge>}
   */
  // eslint-disable-next-line no-unused-vars
  async startOtp(_args) {
    throw new Error('Method not implemented');
  }

  /**
   * Re-send the code of an existing challenge
   * @param {string} _sessionId
   * @returns {Promise<OtpChallenge>}
   */
  // eslint-disable-next-line no-unused-vars
  async resendOtp(_sessionId) {
    throw new Error('Method not implemented');
  }

  /**
   * Verify an OTP code. One shot: a verified session can never be verified again.
   * @param {{sessionId: string, code: string, deviceId: string}} _args
   * @returns {Promise<{phone: string, deviceId: string}>}
   * @throws {AuthError}
   */
  // eslint-disable-next-line no-unused-vars
  async verifyOtp(_args) {
    throw new Error('Method not implemented');
  }

  /**
   * Issue (and replace) the session of a (user_id, deviceId) pair
   * @param {string} _userId
   * @param {string} _deviceId
   * @returns {Promise<IssuedSession>}
   */
  // eslint-disable-next-line no-unused-vars
  async issueSession(_userId, _deviceId) {
    throw new Error('Method not implemented');
  }

  /**
   * Single use refresh token rotation
   * @param {string} _refreshToken
   * @param {string} _deviceId
   * @returns {Promise<IssuedSession & {user_id: string}>}
   * @throws {AuthError}
   */
  // eslint-disable-next-line no-unused-vars
  async refreshSession(_refreshToken, _deviceId) {
    throw new Error('Method not implemented');
  }

  /**
   * Resolve an accesskey to its live session
   * @param {string} _accesskey
   * @returns {Promise<Session>}
   * @throws {AuthError}
   */
  // eslint-disable-next-line no-unused-vars
  async verifyAccessKey(_accesskey) {
    throw new Error('Method not implemented');
  }

  /**
   * Revoke a session by accesskey. Idempotent.
   * @param {string} _accesskey
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async revoke(_accesskey) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Initialize the auth provider instance
   */
  // eslint-disable-next-line no-empty-function
  async init() {}

  /**
   * @abstract
   * Dispose the auth provider internal resources
   */
  // eslint-disable-next-line no-empty-function
  async dispose() {}
}

/**
 * An error carrying the AUTH_CONTRACT 11 envelope.
 */
class AuthError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code UPPER_SNAKE_CASE contract code
   * @param {string} message
   * @param {{retryAfterSec?: number, scope?: string}} extra
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

module.exports = {
  IAuthProvider,
  AuthError
};
