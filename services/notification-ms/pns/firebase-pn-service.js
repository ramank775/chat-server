const admin = require('firebase-admin');
const { IPushNotificationService } = require('./pn-service');

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
    const options = {
      priority: 'high',
      ttl: this.#ttl,
    };
    await this.#messaging
      .send({
        token: token,
        data: {
          message: payload,
        },
        android: options,
      })
      .then((response) => {
        this.#logger.info('Push notification sent successfully', response);
      });
  }

  /**
   * Initialize the PN service instance
   */
  async init() {
    const serviceAccount = require(this.#credFilePath);
    const app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
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
    30
  );
  return cmd;
}

module.exports = {
  code: 'firebase',
  addOptions,
  Implementation: FirebasePushNotificationService,
};
