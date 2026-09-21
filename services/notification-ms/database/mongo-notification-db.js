
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
   * Register or replace the ntfy topic of a (user_id, deviceId) pair
   * @param {string} userId
   * @param {{deviceId: string, topicUrl: string}} options
   */
  async upsertTopic(userId, options) {
    await this.#collection.updateOne(
      { user_id: userId, deviceId: options.deviceId },
      {
        $set: {
          topicUrl: options.topicUrl,
          updatedAt: new Date()
        },
        $setOnInsert: {
          user_id: userId,
          deviceId: options.deviceId,
        }
      },
      {
        upsert: true
      }
    );
  }

  /**
   * Deregister the ntfy topic of a (user_id, deviceId) pair. No `deviceId`
   * removes every topic registered for the user (AUTH_CONTRACT 8.2).
   * @param {string} userId
   * @param {{deviceId?: string}} options
   */
  async removeTopic(userId, options = {}) {
    const filter = { user_id: userId };
    if (options.deviceId) filter.deviceId = options.deviceId;
    await this.#collection.deleteMany(filter);
  }

  /**
   * Get every registered ntfy topic of a user
   * @param {string} userId
   * @returns {Promise<{deviceId: string, topicUrl: string}[]>}
   */
  async getTopics(userId) {
    const records = await this.#collection.find(
      { user_id: userId },
      { projection: { _id: 0, deviceId: 1, topicUrl: 1 } }
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
