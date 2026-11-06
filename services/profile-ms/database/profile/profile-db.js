/* eslint-disable class-methods-use-this */

/**
 * @typedef {Object} User
 * @property {string} user_id 9 lowercase hex chars (36 bit), server assigned, immutable
 * @property {string} phoneKey HMAC-SHA256(pepper, sha256 hex of the E.164 phone); the
 *   only form of the number the server keeps (decision 223, services/profile-ms/phone-key.js)
 * @property {string?} username null until the mandatory username pick step (AUTH_CONTRACT 2.4)
 * @property {string?} usernameLower lower cased `username`, carries the unique index
 * @property {string?} usernameKeyHash hashed 4 digit discovery key
 * @property {Date?} usernameChangedAt null until the first rename/clear (first set is exempt)
 * @property {string?} displayName
 * @property {string?} avatarUrl
 * @property {string?} statusText
 * @property {('everyone'|'chosen'|'nobody')?} discoverability who may find this account by
 *   phone; null = never chosen = `everyone`
 * @property {string[]?} discoveryTokens the `chosen` list as scrypt tokens. Written through
 *   `updateUser`, never read back by the other methods: `hasDiscoveryToken` checks one
 * @property {Date} createdAt
 * @property {Date?} deletedAt tombstone; every lookup filters it out
 */

/**
 * @abstract
 * Interface for Profile Database (AUTH_CONTRACT 2, `users` collection)
 */
class IProfileDB {
  /**
   * Profile Database interface
   * @param {*} context
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IProfileDB) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * @abstract
   * Check if a user_id is already assigned (active or tombstoned).
   * Used by the collision retry loop in AUTH_CONTRACT 2.3.
   * @param {string} _userId
   * @returns {Promise<boolean>}
   */
  // eslint-disable-next-line no-unused-vars
  async existsUserId(_userId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Create a new user
   * @param {User} _user
   * @returns {Promise<User>}
   */
  // eslint-disable-next-line no-unused-vars
  async createUser(_user) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Find an active user by user_id
   * @param {string} _userId
   * @returns {Promise<User|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async getByUserId(_userId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Find an active user by phone key
   * @param {string} _phoneKey
   * @returns {Promise<User|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async getByPhoneKey(_phoneKey) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Find an active user by lower cased username
   * @param {string} _usernameLower
   * @returns {Promise<User|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async getByUsername(_usernameLower) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Find the holder of a lower cased username, tombstones included. A deleted
   * account keeps its handle reserved forever (AUTH_CONTRACT 8.3).
   * @param {string} _usernameLower
   * @returns {Promise<User|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async getUsernameHolder(_usernameLower) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Find the active users behind a batch of phone keys (AUTH_CONTRACT 7.2).
   * Keys with no account are simply absent from the result.
   * @param {string[]} _phoneKeys
   * @returns {Promise<User[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async getByPhoneKeys(_phoneKeys) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Is `_token` on the active user's `chosen` list?
   * @param {string} _userId
   * @param {string} _token
   * @returns {Promise<boolean>}
   */
  // eslint-disable-next-line no-unused-vars
  async hasDiscoveryToken(_userId, _token) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Boot step (decision 223). Records the pepper's fingerprint on first run
   * and throws if the database was keyed with another pepper. Then turns
   * every row still holding the plain number (`phone`, `phoneHash`) into its
   * phone key and erases the plain fields.
   * @param {(phoneHash: string) => string} _keyOf
   * @param {string} _fingerprint
   */
  // eslint-disable-next-line no-unused-vars
  async migratePhones(_keyOf, _fingerprint) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Update an active user.
   * @param {string} _userId
   * @param {Partial<User>} _updates
   * @returns {Promise<User|null>} updated user, null when not found
   * @throws {Error} with `code === 'USERNAME_TAKEN'` / `'PHONE_TAKEN'` on a
   *   unique index collision
   */
  // eslint-disable-next-line no-unused-vars
  async updateUser(_userId, _updates) {
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
  IProfileDB
};
