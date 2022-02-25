const { IAuthDB } = require('./auth-db')
const { addMongodbOptions, initMongoClient } = require('../../../../libs/mongo-utils');

 class MongoAuthDB extends IAuthDB {

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
   * Verify if accesskey is exits for the username
   * @param {string} username 
   * @param {string} accesskey
   * @returns {Promise<boolean>}
   */
  async isExits(username, accesskey) {
    const count = await this.#collection.countDocuments({ username, accesskey });
    return count > 0;
  }

  /**
   * Create new accesskey for the username
   * @param {string} username
   * @param {string} accesskey
   * @returns {Promise<void>}
   */
  async create(username, accesskey) {
    await this.#collection.insertOne({
      username,
      accesskey,
      addedOn: new Date(),
      updatedOn: new Date()
    })
  }

  /**
   * Revoke the accesskey for username
   * @param {string} username 
   * @param {string} accesskey
   */
  async revoke(username, accesskey) {
    await this.#collection.deleteOne({
      username,
      accesskey
    })
  }

  /**
   * @abstract
   * Initialize the database instance
   */
  async init() {
    await this.#client.connect();
    const db = this.#client.db();
    this.#collection = db.collection('session_auth');
  }

  /**
   * @abstract
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
  Implementation: MongoAuthDB,
}
