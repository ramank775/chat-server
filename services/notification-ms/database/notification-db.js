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
   * Register or replace the ntfy topic of a (user_id, deviceId) pair
   * @param {string} userId
   * @param {{deviceId: string, topicUrl: string}} options
   */
  // eslint-disable-next-line no-unused-vars
  async upsertTopic(userId, options) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Deregister the ntfy topic of a (user_id, deviceId) pair
   * @param {string} userId
   * @param {{deviceId: string}} options
   */
  // eslint-disable-next-line no-unused-vars
  async removeTopic(userId, options) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Get every registered ntfy topic of a user
   * @param {string} userId
   * @returns {Promise<{deviceId: string, topicUrl: string}[]>}
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
