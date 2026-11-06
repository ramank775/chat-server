const { IProfileDB } = require('./profile-db');
const { addMongodbOptions, initMongoClient } = require('../../../../libs/mongo-utils');
const { sha256 } = require('../../../../helper');

// the chosen list is only ever checked one token at a time (hasDiscoveryToken)
const PROJECTION = { projection: { _id: 0, discoveryTokens: 0 } };

/** Drop an index that may not exist (fresh database, or already dropped). */
async function dropIndexIfAny(collection, name) {
  try {
    await collection.dropIndex(name);
  } catch (error) {
    // 26 NamespaceNotFound, 27 IndexNotFound
    if (![26, 27].includes(error.code)) throw error;
  }
}

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

  async getByPhoneKey(phoneKey) {
    return this.#collection.findOne({ phoneKey, deletedAt: null }, PROJECTION);
  }

  async getByUsername(usernameLower) {
    return this.#collection.findOne({ usernameLower, deletedAt: null }, PROJECTION);
  }

  async getUsernameHolder(usernameLower) {
    return this.#collection.findOne({ usernameLower }, PROJECTION);
  }

  async getByPhoneKeys(phoneKeys) {
    return this.#collection
      .find({ phoneKey: { $in: phoneKeys }, deletedAt: null }, PROJECTION)
      .toArray();
  }

  async hasDiscoveryToken(userId, token) {
    const count = await this.#collection.countDocuments(
      { user_id: userId, deletedAt: null, discoveryTokens: token },
      { limit: 1 }
    );
    return count > 0;
  }

  async migratePhones(keyOf, fingerprint) {
    const stamp = await this.#client.db().collection('profile_meta').findOneAndUpdate(
      { _id: 'phonePepper' },
      { $setOnInsert: { value: fingerprint } },
      { upsert: true, returnDocument: 'after' }
    );
    if (stamp.value !== fingerprint) {
      throw new Error('PHONE_PEPPER differs from the one this database was keyed with');
    }
    // ponytail: every plain row in one read, fine for a personal server's
    // user count; page it if a migration ever meets millions.
    const plain = await this.#collection
      .find(
        { deletedAt: null, $or: [{ phone: { $type: 'string' } }, { phoneHash: { $type: 'string' } }] },
        { projection: { _id: 0, user_id: 1, phone: 1, phoneHash: 1 } }
      )
      .toArray();
    if (plain.length) {
      await this.#collection.bulkWrite(plain.map((row) => ({
        updateOne: {
          filter: { user_id: row.user_id },
          update: {
            $set: { phoneKey: keyOf(row.phoneHash || sha256(row.phone)) },
            $unset: { phone: '', phoneHash: '' }
          }
        }
      })));
    }
    // tombstones kept them as nulls
    await this.#collection.updateMany(
      { $or: [{ phone: { $exists: true } }, { phoneHash: { $exists: true } }] },
      { $unset: { phone: '', phoneHash: '' } }
    );
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
        // which unique index rejected us: `phoneKey` on a rebind, `usernameLower` on a rename
        const field = Object.keys(error.keyPattern || {})[0];
        const taken = new Error(`${field} already taken`);
        taken.code = field === 'phoneKey' ? 'PHONE_TAKEN' : 'USERNAME_TAKEN';
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
    // decision 223: the plain number and its unsalted hash are gone (migratePhones)
    await dropIndexIfAny(this.#collection, 'phone_1');
    await dropIndexIfAny(this.#collection, 'phoneHash_1');
    // a deleted account releases its phone, so the key is only unique among
    // live users; rows awaiting migratePhones have none yet
    await this.#collection.createIndex(
      { phoneKey: 1 },
      {
        unique: true,
        partialFilterExpression: { deletedAt: { $type: 'null' }, phoneKey: { $type: 'string' } }
      }
    );
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
