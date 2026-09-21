/* eslint-disable class-methods-use-this */
class IPushNotificationService {

  /**
   * Notification Database interface
   * @param {*} context 
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IPushNotificationService) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   *  Publish a wake notification on the recipient topic.
   *  No payload by design, a wake never carries message content.
   * @param {string} topicUrl
   */
  // eslint-disable-next-line no-unused-vars
  async push(topicUrl) {
    throw new Error("Method is not implemented");
  }

  /**
   * @abstract
   * Initialize the database instance
   */
  async init() {
    // Do nothing as this is just a placeholder function
  }

  /**
   * @abstract
   * Dispose the database internal resources
   */
  async dispose() {
    // Do nothing as this is just a placeholder function
  }
}

module.exports = {
  IPushNotificationService
}
