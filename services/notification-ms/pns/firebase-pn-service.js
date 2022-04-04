const admin = require('firebase-admin');
const { IPushNotificationService } = require("./pn-service");

class FirebasePushNotificationService extends IPushNotificationService {

  #ttl = 30;

  #credFilePath;

  /** @type {import('firebase-admin').messaging.Messaging} */
  #messaging;

  #logger;

  /**
   * Firebase push notification service
   * @param {*} context 
   */
  constructor(context) {
    super(context);
    this.#credFilePath = context.options.firebaseAdminCredentialJsonPath;
    this.#ttl = context.options.firebasePnTtl || this.#ttl;
    this.#logger = context.log;
  }

  /**
   *  Push the notification
   * @param {string} token 
   * @param {Object} payload 
   */
  async push(token, payload) {
    const chatPayload = {
      data: {
        message: JSON.stringify(payload)
      }
    };
    const options = {
      priority: 'high',
      timeToLive: this.#ttl
    };
    await this.#messaging.sendToDevice(token, chatPayload, options)
      .then((response) => {
        this.#logger.info('Push notification sent successfully', response)
      })
  }

  /**
   * Initialize the PN service instance
   */
  async init() {
    /* eslint-disable-next-line import/no-dynamic-require, global-require */
    const serviceAccount = require(this.#credFilePath);
    const app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    this.#messaging = app.messaging();
  }
}

function addOptions(cmd) {
  cmd.option(
    '--firebase-admin-credential-json-path <firebaes-admin-cred-file>',
    'Path to the firebase admin credentials file'
  );
  cmd.option(
    '--firebase-pn-ttl <firebase-pn-ttl>',
    'Firebase pushing notification Time to live (30 sec)',
    (c) => Number(c),
    30);
  return cmd;
}

module.exports = {
  code: 'firebase',
  addOptions,
  Implementation: FirebasePushNotificationService
}
