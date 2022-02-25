/* eslint-disable class-methods-use-this */

/**
 * @abstract
 * Interface for Auth Database
 */
 class IAuthDB {

  /**
   * Profile Database interface
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
   * Verify if accesskey is exits for the username
   * @param {string} username 
   * @param {string} accesskey
   * @returns {Promise<boolean>}
   */
  // eslint-disable-next-line no-unused-vars
  async isExits(username, accesskey) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Create new accesskey for the username
   * @param {string} username
   * @param {string} accesskey
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async create(username, accesskey) {
    throw new Error('Method not implemented')
  }

  /**
   * @abstract
   * Revoke the accesskey for username
   * @param {string} username 
   * @param {string} accesskey
   */
  // eslint-disable-next-line no-unused-vars
  async revoke(username, accesskey) {
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
  IAuthDB
}
