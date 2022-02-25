/* eslint-disable class-methods-use-this */

/**
 * @typedef {Object} UserProfile
 * @property {string} username
 * @property {string} uid
 * @property {string?} name
 * @property {boolean} isActive
 * @property {Date} addedOn
 * @property {Date} updatedOn
 * @property {Date} syncAt
 */

/**
 * @abstract
 * Interface for Profile Database
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
   * Verify if user exits by username
   * @param {string} _username 
   * @returns {Promise<boolean>}
   */
  // eslint-disable-next-line no-unused-vars
  async isExits(username) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Create new user profile
   * @param {UserProfile} _profile 
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async create(profile) {
    throw new Error('Method not implemented')
  }

  /**
   * @abstract
   * Find active user by username
   * @param {string} username 
   * @param {{[key:string]: boolean}} projection 
   */
  // eslint-disable-next-line no-unused-vars
  async findActiveUser(username, projection) {
    throw new Error('Method not implemented')
  }

  /**
   * @abstract
   * Sync contact book
   * @param {string} username
   * @param {string[]} contacts 
   */
  // eslint-disable-next-line no-unused-vars
  async contactBookSyncByUsername(username, contacts) {
    throw new Error('Method not implemented')
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
}
