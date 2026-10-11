
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
   * Register or replace the push endpoint of a (user_id, deviceId) pair
   * @param {string} userId
   * @param {{deviceId: string, endpoint: string, p256dh: string, auth: string}} options
   */
  async upsertTopic(userId, options) {
    const { deviceId, endpoint, p256dh, auth } = options;
    await this.#collection.updateOne(
      { user_id: userId, deviceId },
      {
        $set: { endpoint, p256dh, auth, updatedAt: new Date() },
        // the pre Web Push shape
        $unset: { topicUrl: '' },
        $setOnInsert: { user_id: userId, deviceId }
      },
      {
        upsert: true
      }
    );
  }

  /**
   * Deregister the push endpoint of a (user_id, deviceId) pair. No `deviceId`
   * removes every endpoint registered for the user (AUTH_CONTRACT 8.2). With
   * `endpoint`, only while that endpoint is still the registered one.
   * @param {string} userId
   * @param {{deviceId?: string, endpoint?: string}} options
   */
  async removeTopic(userId, options = {}) {
    const filter = { user_id: userId };
    if (options.deviceId) filter.deviceId = options.deviceId;
    if (options.endpoint) filter.endpoint = options.endpoint;
    await this.#collection.deleteMany(filter);
  }

  /**
   * Get every registered push endpoint of a user
   * @param {string} userId
   * @returns {Promise<{deviceId: string, endpoint: string, p256dh: string, auth: string}[]>}
   */
  async getTopics(userId) {
    const records = await this.#collection.find(
      { user_id: userId },
      { projection: { _id: 0, deviceId: 1, endpoint: 1, p256dh: 1, auth: 1 } }
    ).toArray();
    return records;
  }

  /**
   * Initialize the database instance
   */
  async init() {
    await this.#client.connect();
    const db = this.#client.db();
    this.#collection = db.collection('push_topics');
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
