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
   * @param {MessageEvent[]} messages 
   */
  async save(messages) {
    const expireAt = moment().add(30, 'days').toDate()
    const msgs = messages.map(msg => ({
      id: msg.id,
      chat: msg.destination,
      payload: msg.toBinary({
        ignore: ['recipients']
      }),
      delivery: {
        [msg.source]: new Date(),
      },
      recievedAt: msg.server_timestamp,
      expireAt
    }))
    await this.#collection.insertMany(msgs)
  }

  /**
   * Get Pending Messages
   * @param {{id: string, since: number, until: number }} chats
   * @param {string} source
   * @return {Promise<MessageEvent[]>}
   */
  async getUndeliveredMessage(chats, source) {
    const query = chats.map((chat) => ({
      chat: chat.id,
      recievedAt: {
        $gte: chat.since || -1,
        $lte: chat.until || Date.now()
      },
      [`delivery.${source}`]: { $exists: false },
    }))
    const cursor = this.#collection.find({
      $or: query,
    }, {
      sort: {
        _id: 1,
      },
      projection: { payload: 1 }
    });
    const messageEventCursor = cursor.map((doc) => {
      const binary = doc.payload.buffer
      return MessageEvent.fromBinary(binary)
    })
    return await messageEventCursor.toArray()
  }

  /**
   * @abstract
   * Mark message as delivered
   * @param {string} source
   * @param {string[]} messageIds
   */
  async markMessageDelivered(messageIds, source) {
    await this.#collection.updateMany({
      id: { $in: messageIds }
    }, {
      $set: { [`delivery.${source}`]: new Date() }
    });
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
