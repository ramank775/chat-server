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
   *  Push the notification
   * @param {string} token 
   * @param {Object} payload 
   */
  // eslint-disable-next-line no-unused-vars
  async push(token, payload) {
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
