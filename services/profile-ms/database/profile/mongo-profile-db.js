const { IProfileDB } = require('./profile-db');
const { addMongodbOptions, initMongoClient } = require('../../../../libs/mongo-utils');

const PROJECTION = { projection: { _id: 0 } };

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
   * Check if a user_id is already assigned (tombstoned users keep their row)
   * @param {string} userId
   * @returns {Promise<boolean>}
   */
  async existsUserId(userId) {
    const count = await this.#collection.countDocuments({ user_id: userId }, { limit: 1 });
    return count > 0;
  }

  /**
   * Create a new user
   * @param {import('./profile-db').User} user
   * @returns {Promise<import('./profile-db').User>}
   */
  async createUser(user) {
    await this.#collection.insertOne({ ...user });
    return this.getByUserId(user.user_id);
  }

  async getByUserId(userId) {
    return this.#collection.findOne({ user_id: userId, deletedAt: null }, PROJECTION);
  }

  async getByPhone(phone) {
    return this.#collection.findOne({ phone, deletedAt: null }, PROJECTION);
  }

  async getByUsername(usernameLower) {
    return this.#collection.findOne({ usernameLower, deletedAt: null }, PROJECTION);
  }

  /**
   * Update an active user
   * @param {string} userId
   * @param {Partial<import('./profile-db').User>} updates
   * @returns {Promise<import('./profile-db').User|null>}
   */
  async updateUser(userId, updates) {
    try {
      return await this.#collection.findOneAndUpdate(
        { user_id: userId, deletedAt: null },
        { $set: { ...updates, updatedAt: new Date() } },
        { returnDocument: 'after', ...PROJECTION }
      );
    } catch (error) {
      if (error.code === 11000) {
        const taken = new Error('username already taken');
        taken.code = 'USERNAME_TAKEN';
        throw taken;
      }
      throw error;
    }
  }

  async init() {
    await this.#client.connect();
    this.#collection = this.#client.db().collection('users');
    // user_id stays unique across tombstones: a deleted id is never reassigned
    await this.#collection.createIndex({ user_id: 1 }, { unique: true });
    // a deleted account releases its phone, so the phone is only unique among live users
    await this.#collection.createIndex(
      { phone: 1 },
      { unique: true, partialFilterExpression: { deletedAt: { $type: 'null' } } }
    );
    await this.#collection.createIndex({ phoneHash: 1 });
    // partial index so the many `null` usernames do not collide with each other
    await this.#collection.createIndex(
      { usernameLower: 1 },
      { unique: true, partialFilterExpression: { usernameLower: { $type: 'string' } } }
    );
  }

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
  Implementation: MongoProfileDB
};
