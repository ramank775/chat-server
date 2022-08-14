const moment = require('moment');
const { IMessageDB } = require('./message-db');
const { addMongodbOptions, initMongoClient } = require('../../../libs/mongo-utils');
const { MessageEvent } = require('../../../libs/event-args')

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
    const expireAt = moment().add(30, 'days').toDate()
    const msgs = messages.map(msg => ({
      id: msg.id,
      user,
      payload: msg.toBinary(),
      expireAt
    }))
    await this.#collection.insertMany(msgs)
  }

  async getUndeliveredMessage(userId) {
    const cursor = this.#collection.find({ user: userId }, { projection: { payload: 1 } });
    const messageEventCursor = cursor.map((doc) => {
      const binary = doc.payload.buffer
      return MessageEvent.fromBinary(binary)
    })
    return await messageEventCursor.toArray()
  }

  async markMessageDelivered(userId, messageIds) {
    await this.#collection.deleteMany(
      { user: userId, id: { $in: messageIds } }
    );
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
  cmd = addMongodbOptions(cmd)
  return cmd;
}

module.exports = {
  code: 'mongo',
  addOptions: addDatabaseOptions,
  Implementation: MongoMessageDB,
}
