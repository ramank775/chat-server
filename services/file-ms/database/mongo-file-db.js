const { ObjectId } = require('mongodb');
const { IFileMetadataDB } = require('./file-metadata-db');
const { addMongodbOptions, initMongoClient } = require('../../../libs/mongo-utils');

class MongoFileStore extends IFileMetadataDB {
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
   * Create new File record
   * @param {{category: string; owner: string; contentType: string;}} payload
   * @returns {Promise<string>}
   */
  async createRecord(payload) {
    const fileRecord = {
      category: payload.category,
      owner: payload.owner,
      contentType: payload.contentType,
      createdAt: new Date(),
    };
    const record = await this.#collection.insertOne(fileRecord);
    return record.insertedId.toHexString();
  }

  /**
   * Get File record
   * @param {string} fileId
   */
  async getRecord(fileId) {
    const file = await this.#collection.findOne({
      _id: ObjectId.createFromHexString(fileId),
    });
    return file;
  }

  /**
   * Update File status
   */
  async updateFileStatus(fileId, status) {
    await this.#collection.updateOne(
      { _id: ObjectId.createFromHexString(fileId) },
      { $set: { status: !!status } }
    );
  }

  /**
   * Initialize the database instance
   */
  async init() {
    await this.#client.connect();
    const db = this.#client.db();
    this.#collection = db.collection('file_store');
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
  Implementation: MongoFileStore,
};
