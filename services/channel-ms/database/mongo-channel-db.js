const { IChannelDB } = require('./channel-db');
const { addMongodbOptions, initMongoClient } = require('../../../libs/mongo-utils');

const PROJECTION = {
  projection: {
    _id: 0,
    channelId: 1,
    kind: 1,
    name: 1,
    avatarUrl: 1,
    owner: 1,
    initiatedVia: 1,
    members: 1,
    createdAt: 1
  }
};

/** Reads only ever expose the live roster; tombstoned rows stay for `removedAt`. */
function active(channel) {
  if (channel) channel.members = channel.members.filter((member) => !member.removedAt);
  return channel;
}

class MongoChannelDB extends IChannelDB {
  /** @type { import('mongodb').MongoClient } */
  #client;

  /** @type { import('mongodb').Collection } */
  #collection;

  /**
   * ponytail: channel-ms and profile-ms are deployed against the same
   * `--mongo-url` (deployment/docker-compose.yml), so the username-key gate
   * reads profile-ms' `users` collection directly rather than adding an HTTP
   * client + endpoint + option for one hash lookup. Split the databases and
   * this becomes a call to profile-ms.
   * @type { import('mongodb').Collection }
   */
  #users;

  /**
   * @param {*} context
   */
  constructor(context) {
    super(context);
    this.#client = initMongoClient(context);
  }

  async getMemberChannels(memberId, kind = null) {
    const query = { members: { $elemMatch: { user_id: memberId, removedAt: null } } };
    if (kind) query.kind = kind;
    const channels = await this.#collection.find(query, PROJECTION).toArray();
    return channels.map(active);
  }

  async create(channel) {
    try {
      await this.#collection.insertOne({ ...channel });
    } catch (error) {
      if (error.code === 11000) {
        const taken = new Error(`channel ${channel.channelId} already exists`);
        taken.code = 'CHANNEL_EXISTS';
        throw taken;
      }
      throw error;
    }
    return this.getChannelInfo(channel.channelId);
  }

  async getChannelInfo(channelId, memberId = null) {
    const query = { channelId };
    if (memberId) query.members = { $elemMatch: { user_id: memberId, removedAt: null } };
    return active(await this.#collection.findOne(query, PROJECTION));
  }

  async findOneToOne(userIds) {
    const channel = await this.#collection.findOne(
      {
        kind: 'one_to_one',
        // exactly this pair, both still active
        $and: userIds.map((id) => ({ members: { $elemMatch: { user_id: id, removedAt: null } } }))
      },
      PROJECTION
    );
    return active(channel);
  }

  async addMembers(channelId, members) {
    // pull-then-push so re-adding a removed member revives one row rather
    // than leaving the tombstone next to a duplicate.
    const ids = members.map((member) => member.user_id);
    await this.#collection.updateOne(
      { channelId },
      { $pull: { members: { user_id: { $in: ids } } } }
    );
    await this.#collection.updateOne({ channelId }, { $push: { members: { $each: members } } });
  }

  async removeMember(channelId, userId, at) {
    await this.#collection.updateOne(
      { channelId, 'members.user_id': userId },
      { $set: { 'members.$.removedAt': at } }
    );
  }

  async updateChannel(channelId, updates) {
    const channel = await this.#collection.findOneAndUpdate(
      { channelId },
      { $set: { ...updates, updatedAt: Date.now() } },
      { returnDocument: 'after', ...PROJECTION }
    );
    return active(channel);
  }

  async deleteChannel(channelId) {
    await this.#collection.deleteOne({ channelId });
  }

  async usernameKeyHash(userId) {
    const user = await this.#users.findOne(
      { user_id: userId, deletedAt: null },
      { projection: { _id: 0, usernameKeyHash: 1 } }
    );
    return user ? user.usernameKeyHash || null : null;
  }

  async init() {
    await this.#client.connect();
    const db = this.#client.db();
    this.#collection = db.collection('channels');
    this.#users = db.collection('users');
    // client-supplied ids: the unique index is what turns a collision into 409.
    await this.#collection.createIndex({ channelId: 1 }, { unique: true });
    await this.#collection.createIndex({ 'members.user_id': 1 });
  }

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
  Implementation: MongoChannelDB
};
