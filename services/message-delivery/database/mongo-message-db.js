const { DateTime } = require('luxon');
const { IMessageDB } = require('./message-db');
const { addMongodbOptions, initMongoClient } = require('../../../libs/mongo-utils');
const { MessageEvent } = require('../../../libs/event-args');

const MESSAGE_STATUS = {
  UNDELIVERED: 0,
  SENT: 1,
  DELIVERED: 2,
};

class MongoMessageDB extends IMessageDB {
  /** @type { import('mongodb').MongoClient } */
  #client;

  /** @type { import('mongodb').Collection } */
  #collection;

  /**
   * Group Database interface
   * @param {*} context
   */
  constructor(context) {
    super(context);
    this.#client = initMongoClient(context);
  }

  /**
   * Save messages in database
   * @param {string} user
   * @param {MessageEvent[]} messages
   */
  async save(user, messages) {
    const expireAt = DateTime.now().plus({ days: 30 }).toJSDate();
    const msgs = messages.map((msg) => ({
      id: msg.id,
      user,
      payload: msg.toBinary(),
      status: MESSAGE_STATUS.UNDELIVERED,
      expireAt,
    }));
    await this.#collection.insertMany(msgs);
  }

  async getUndeliveredMessage(userId) {
    const cursor = this.#collection.find(
      { user: userId, status: 0 },
      { projection: { payload: 1 } }
    );
    const messageEventCursor = cursor.map((doc) => {
      const binary = doc.payload.buffer;
      return MessageEvent.fromBinary(binary);
    });
    return await messageEventCursor.toArray();
  }

  async markMessageSent(userId, messageIds) {
    const expireAt = DateTime.now().plus({ days: 7 }).toJSDate();
    await this.#collection.updateMany(
      {
        user: userId,
        id: { $in: messageIds },
      },
      {
        $set: {
          status: MESSAGE_STATUS.SENT,
          expireAt,
        },
      }
    );
  }

  async markMessageDelivered(userId, messageIds) {
    await this.#collection.deleteMany({ user: userId, id: { $in: messageIds } });
  }

  /**
   * Initialize the database instance
   */
  async init() {
    await this.#client.connect();
    const db = this.#client.db();
    this.#collection = db.collection('ps_message');
  }

  /**
   * Dispose the database internal resources
   */
  async dispose() {
    await this.#client.close();
  }
}

function addDatabaseOptions(cmd) {
  cmd = addMongodbOptions(cmd);
  return cmd;
}

module.exports = {
  code: 'mongo',
  addOptions: addDatabaseOptions,
  Implementation: MongoMessageDB,
};
