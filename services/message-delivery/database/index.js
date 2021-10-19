const { addMongodbOptions, initMongoClient } = require('../../../libs/mongo-utils'),
  mongo = require('mongodb'),
  moment = require('moment');


class MongodDbService {
  
  _client;
  /**
   * @type {mongo.Collection}
   */
  _collection;
  /**
   * 
   * @param {{client: mongo.MongoClient}} options 
   */
  constructor(options) {
    this._client = options.client;
    const db = this._client.db();
    this._collection = db.collection('ps_message');
  }

  async save(messages) {
    const expireAt = moment().add(30, 'days').toDate()
    const msgs = messages.map(msg => ({ ...msg, expireAt: expireAt }))
    await this._collection.insertMany(msgs)
  }

  async getUndeliveredMessageByUser(user_id) {
    const messages = this._collection.find({ 'META.to': user_id }, {projection: {META: 1, payload: 1}});
    return await messages.toArray()
  }

  async markMessageDeliveredByUser(user_id, messages) {
    await this._collection.deleteMany(
      { 'META.to': user_id, 'META.id': { $in: messages } }
    );
  }

  async close () {
    await this._client.close()
  }
}

function addDatabaseOptions(cmd) {
  cmd = addMongodbOptions(cmd)
  return cmd;
}

async function initDatabase(context) {
  const dbContext = await initMongoClient({options: context.options})
  context.db = new MongodDbService({client: dbContext.mongoClient});
  return context;
}

module.exports = {
  addDatabaseOptions,
  initDatabase
}
