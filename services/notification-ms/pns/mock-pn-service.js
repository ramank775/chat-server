const { IPushNotificationService } = require("./pn-service");

class MockPushNotificationService extends IPushNotificationService {

  #logger;

  /**
   * Mock push notification service
   * @param {*} context 
   */
  constructor(context) {
    super(context);
    this.#logger = context.log;
  }

  /**
   *  Push the notification
   * @param {string} token 
   * @param {Object} payload 
   */
  async push(token, payload) {
    this.#logger.info('new push notification', token, payload);
  }
}

function addOptions(cmd) {
  return cmd;
}

module.exports = {
  code: 'mock',
  addOptions,
  Implementation: MockPushNotificationService
}
