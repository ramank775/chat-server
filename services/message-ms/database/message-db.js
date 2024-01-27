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
   * @param {MessageEvent[]} messages
   */
  // eslint-disable-next-line no-unused-vars
  async save(messages) {
    throw new Error('Method not implemented')
  }

  /**
   * @abstract
   * Get Pending Messages
   * @param {{id: string, since: number, until: number }} chats
   * @param {string} source
   * @return {Promise<MessageEvent[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async getUndeliveredMessage(chats, source) {
    throw new Error('Method not implemented')
  }

  /**
   * @abstract
   * Mark message as delivered
   * @param {string[]} messageIds
   * @param {string} source
   */
  // eslint-disable-next-line no-unused-vars
  async markMessageDelivered(messageIds, source) {
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
