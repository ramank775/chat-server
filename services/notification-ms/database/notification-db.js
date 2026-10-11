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
   * Register or replace the push endpoint of a (user_id, deviceId) pair
   * @param {string} userId
   * @param {{deviceId: string, endpoint: string, p256dh: string, auth: string}} options
   */
  // eslint-disable-next-line no-unused-vars
  async upsertTopic(userId, options) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Deregister the push endpoint of a (user_id, deviceId) pair. No `deviceId`
   * removes every endpoint registered for the user (AUTH_CONTRACT 8.2). With
   * `endpoint`, only while that endpoint is still the registered one.
   * @param {string} userId
   * @param {{deviceId?: string, endpoint?: string}} options
   */
  // eslint-disable-next-line no-unused-vars
  async removeTopic(userId, options) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Get every registered push endpoint of a user
   * @param {string} userId
   * @returns {Promise<{deviceId: string, endpoint: string, p256dh: string, auth: string}[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async getTopics(userId) {
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
