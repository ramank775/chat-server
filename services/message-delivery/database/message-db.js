/* eslint-disable class-methods-use-this */

/** @typedef {import('../../../libs/event-args').MessageEvent} MessageEvent */

/**
 * @abstract
 * Interface for Auth Database
 */
class IMessageDB {

  /**
   * Group Database interface
   * @param {*} context 
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IMessageDB) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * @abstract
   * Save messages
   * @param {string} user
   * @param {MessageEvent[]} messages
   */
  // eslint-disable-next-line no-unused-vars
  async save(user, messages) {
    throw new Error('Method not implemented')
  }

  /**
   * @abstract
   * Get Pending Messages
   * @param {string} userId
   * @return {Promise<MessageEvent[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async getUndeliveredMessage(userId) {
    throw new Error('Method not implemented')
  }

  /**
   * @abstract
   * Mark message as delivered
   * @param {string} userId
   * @param {string[]} messageIds
   */
  // eslint-disable-next-line no-unused-vars
  async markMessageDelivered(userId, messageIds) {
    throw new Error('Method not implemented')
  }

  /**
   * @abstract
   * Mark message as Sent
   * @param {string} userId
   * @param {string[]} messageIds
   */
  // eslint-disable-next-line no-unused-vars
  async markMessageSent(userId, messageIds) {
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
  IMessageDB
}
