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
   *  Publish a wake notification on the recipient topic
   * @param {string} topicUrl
   */
  async push(topicUrl) {
    this.#logger.info('new push notification', topicUrl);
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
