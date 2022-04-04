const { IProfileDB } = require('./profile-db')
const { addMongodbOptions, initMongoClient } = require('../../../../libs/mongo-utils');


class MongoProfileDB extends IProfileDB {
  /** @type { import('mongodb').MongoClient } */
  #client;

  /** @type { import('mongodb').Collection } */
  #collection;

  constructor(context) {
    super(context);
    this.#client = initMongoClient(context);
  }

  /**
   * Verify if user exits by username
   * @param {string} _username 
   * @returns {Promise<boolean>}
   */
  async isExits(username) {
    const count = await this.#collection.countDocuments({ username });
    return count > 0;
  }

  /**
   * Create new user profile
   * @param {UserProfile} _profile 
   * @returns {Promise<void>}
   */
  async create(profile) {
    this.#collection.insertOne(profile);
  }

  /**
   * Find active user by username
   * @param {string} username 
   * @param {{[key:string]: 0|1}} projection 
   */
  async findActiveUser(username, projection) {
    const result = await this.#collection.findOne({
      username,
      isActive: true
    }, { projection: { ...projection, _id: 0 } });
    return result;
  }

  /**
   * Sync contact book with username
   * @param {string} username
   * @param {string[]} contacts 
   */
  async contactBookSyncByUsername(username, contacts) {
    const availableUsers = await this.#collection
      .find({ username: { $in: contacts }, isActive: true }, { projection: { _id: 0, username: 1 } })
      .toArray();
    const result = {};
    availableUsers.forEach((u) => {
      result[u.username] = true;
    });
    await this.#collection.updateOne(
      { username },
      { $set: { syncAt: new Date() } }
    );
    const response = availableUsers.reduce((acc, user) => {
      acc[user.username] = true;
      return acc;
    }, {});
    return response
  }

  /**
   * Initialize the database instance
   */
  async init() {
    await this.#client.connect();
    const db = this.#client.db();
    this.#collection = db.collection('profile');
  }

  /**
   * Dispose the database internal resources
   */
  async dispose() {
    await this.#client.close();
  }
}

function addOptions(cmd) {
  cmd = addMongodbOptions(cmd)
  return cmd;
}

module.exports = {
  code: 'mongo',
  addOptions,
  Implementation: MongoProfileDB
}
