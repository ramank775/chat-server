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
   *  Log the wake instead of publishing it
   * @param {{endpoint: string}} subscription
   */
  async push({ endpoint }) {
    this.#logger.info(`new push notification for ${new URL(endpoint).origin}`);
    return 201;
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
