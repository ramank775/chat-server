
const { INotificationDB } = require('./notification-db');
const { addMongodbOptions, initMongoClient } = require('../../../libs/mongo-utils');

class MongoNotificationDB extends INotificationDB {

  /** @type { import('mongodb').MongoClient } */
  #client;

  /** @type { import('mongodb').Collection } */
  #collection;

  /**
   * Profile Database interface
   * @param {*} context 
   */
  constructor(context) {
    super(context);
    this.#client = initMongoClient(context);
  }

  /**
   * Upsert Notification Token
   * @param {string} username 
   * @param {{deviceId: string|null, token: string}} options 
   */
  async upsertToken(username, options) {
    await this.#collection.updateOne(
      { username, deviceId: options.deviceId },
      {
        $set: {
          notificationToken: options.token
        },
        $setOnInsert: {
          username,
          deviceId: options.deviceId,
        }
      },
      {
        upsert: true
      }
    );
  }

  /**
   * Get Notification Token
   * @param {string} username 
   * @param {{deviceId: string|null}} options 
   */
  async getToken(username, options) {
    const record = await this.#collection.findOne(
      { username, deviceId: options.deviceId },
      { projection: { _id: 0, notificationToken: 1, messageVersion: 1 } }
    );
    return record;
  }

  /**
   * Initialize the database instance
   */
  async init() {
    await this.#client.connect();
    const db = this.#client.db();
    this.#collection = db.collection('notification_tokens');
  }

  /**
   * Dispose the database internal resources
   */
  async dispose() {
    await this.#client.close();
  }

}

function addOptions(cmd) {
  cmd = addMongodbOptions(cmd);
  return cmd;
}

module.exports = {
  code: 'mongo',
  addOptions,
  Implementation: MongoNotificationDB
}
