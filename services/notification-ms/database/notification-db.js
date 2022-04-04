/* eslint-disable class-methods-use-this */

class INotificationDB {

  /**
   * Notification Database interface
   * @param {*} context 
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === INotificationDB) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * @abstract
   * Upsert Notification Token
   * @param {string} username 
   * @param {{deviceId: string|null, token: string}} options 
   */
  // eslint-disable-next-line no-unused-vars
  async upsertToken(username, options) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Get Notification Token
   * @param {string} username 
   * @param {{deviceId: string|null}} options 
   */
  // eslint-disable-next-line no-unused-vars
  async getToken(username, options) {
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
  INotificationDB
}
