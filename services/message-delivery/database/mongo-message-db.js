const moment = require('moment');
const { IMessageDB } = require('./message-db');
const { addMongodbOptions, initMongoClient } = require('../../../libs/mongo-utils');

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

  async save(messages) {
    const expireAt = moment().add(30, 'days').toDate()
    const msgs = messages.map(msg => ({ ...msg, expireAt }))
    await this.#collection.insertMany(msgs)
  }

  async getUndeliveredMessageByUser(userId) {
    const messages = this.#collection.find({ 'META.to': userId }, { projection: { META: 1, payload: 1 } });
    return await messages.toArray()
  }

  async markMessageDeliveredByUser(userId, messages) {
    await this.#collection.deleteMany(
      { 'META.to': userId, 'META.id': { $in: messages } }
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
