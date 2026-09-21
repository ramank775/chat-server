/* eslint-disable class-methods-use-this */

/**
 * @typedef {Object} User
 * @property {string} user_id 9 lowercase hex chars (36 bit), server assigned, immutable
 * @property {string} phone E.164
 * @property {string} phoneHash sha256 of the canonical E.164 phone (contact discovery key)
 * @property {string?} username null until the mandatory username pick step (AUTH_CONTRACT 2.4)
 * @property {string?} usernameLower lower cased `username`, carries the unique index
 * @property {string?} usernameKeyHash hashed 4 digit discovery key
 * @property {Date?} usernameChangedAt null until the first rename/clear (first set is exempt)
 * @property {string?} displayName
 * @property {string?} avatarUrl
 * @property {string?} statusText
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
   * Find an active user by phone (E.164)
   * @param {string} _phone
   * @returns {Promise<User|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async getByPhone(_phone) {
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
   * Find the active users behind a batch of phone hashes (AUTH_CONTRACT 7.2).
   * Hashes with no account are simply absent from the result.
   * @param {string[]} _phoneHashes
   * @returns {Promise<User[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async getByPhoneHashes(_phoneHashes) {
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
