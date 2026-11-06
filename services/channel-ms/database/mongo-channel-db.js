const { IChannelDB } = require('./channel-db');
const { addMongodbOptions, initMongoClient } = require('../../../libs/mongo-utils');
const { REPORT_RETENTION_SEC } = require('./channel-db');

const PROJECTION = {
  projection: {
    _id: 0,
    channelId: 1,
    kind: 1,
    name: 1,
    avatarUrl: 1,
    owner: 1,
    members: 1,
    createdAt: 1
  }
};

const INVITE = { projection: { _id: 0, channelId: 1, to: 1, from: 1, createdAt: 1 } };

/** The pair's key, low id first. */
const pairOf = (a, b) => (a < b ? { a, b } : { a: b, b: a });

/** A live member `userId`, inside `members`. */
const liveMember = (userId) => ({ $elemMatch: { user_id: userId, removedAt: null } });

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

  /** @type {{[name: string]: import('mongodb').Collection}} */
  #c = {};

  /**
   * @param {*} context
   */
  constructor(context) {
    super(context);
    this.#client = initMongoClient(context);
  }

  async getMemberChannels(memberId) {
    // `kind: 'group'` is what leaves any pre-trim-4 DM row unread.
    const query = { kind: 'group', members: { $elemMatch: { user_id: memberId, removedAt: null } } };
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

  async setMemberRole(channelId, userId, role) {
    // `owner` is denormalised on the doc, so succession has to move it too.
    const update = { 'members.$.role': role };
    if (role === 'owner') update.owner = userId;
    await this.#collection.updateOne({ channelId, 'members.user_id': userId }, { $set: update });
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
    await this.#c.invites.deleteMany({ channelId });
  }

  async addInvite(invite) {
    const { upsertedCount } = await this.#c.invites.updateOne(
      { channelId: invite.channelId, to: invite.to },
      { $setOnInsert: { ...invite } },
      { upsert: true }
    );
    return upsertedCount === 1;
  }

  async getInvite(channelId, to) {
    return this.#c.invites.findOne({ channelId, to }, INVITE);
  }

  async deleteInvite(channelId, to) {
    const { deletedCount } = await this.#c.invites.deleteOne({ channelId, to });
    return deletedCount === 1;
  }

  async findInvites(userId, channelIds = []) {
    const or = [{ channelId: { $in: channelIds } }];
    if (userId) or.push({ from: userId }, { to: userId });
    return this.#c.invites.find({ $or: or }, INVITE).sort({ createdAt: 1 }).toArray();
  }

  async connect(a, b, at) {
    await this.#c.connections.updateOne(
      pairOf(a, b), { $setOnInsert: { createdAt: at } }, { upsert: true }
    );
  }

  async connectionsOf(userId) {
    const rows = await this.#c.connections.find({ $or: [{ a: userId }, { b: userId }] }).toArray();
    return rows.map((row) => (row.a === userId ? row.b : row.a));
  }

  async anyConnection() {
    return !!(await this.#c.connections.findOne({}));
  }

  async setBlocked(blocker, blocked, on) {
    if (!on) {
      await this.#c.blocks.deleteOne({ blocker, blocked });
      return;
    }
    await this.#c.blocks.updateOne(
      { blocker, blocked }, { $setOnInsert: { createdAt: Date.now() } }, { upsert: true }
    );
  }

  async blockedBy(blocker) {
    return (await this.#c.blocks.find({ blocker }).toArray()).map((row) => row.blocked);
  }

  async pair(a, b) {
    const { blocks } = this.#c;
    const [connected, aBlockedB, bBlockedA, shareGroup] = await Promise.all([
      this.#c.connections.findOne(pairOf(a, b)),
      blocks.findOne({ blocker: a, blocked: b }),
      blocks.findOne({ blocker: b, blocked: a }),
      this.#collection.findOne(
        { kind: 'group', members: { $all: [liveMember(a), liveMember(b)] } },
        { projection: { _id: 1 } }
      )
    ]);
    return {
      connected: !!connected, aBlockedB: !!aBlockedB, bBlockedA: !!bBlockedA, shareGroup: !!shareGroup
    };
  }

  async forget(userId) {
    await Promise.all([
      this.#c.invites.deleteMany({ $or: [{ from: userId }, { to: userId }] }),
      this.#c.connections.deleteMany({ $or: [{ a: userId }, { b: userId }] }),
      this.#c.blocks.deleteMany({ $or: [{ blocker: userId }, { blocked: userId }] })
    ]);
  }

  async addReport(report) {
    await this.#c.reports.insertOne({ ...report, createdAt: new Date() });
  }

  async purgeReports(before) {
    // the TTL index does this on its own; kept for the store's contract
    await this.#c.reports.deleteMany({ createdAt: { $lt: before } });
  }

  async init() {
    await this.#client.connect();
    const db = this.#client.db();
    this.#collection = db.collection('channels');
    // client-supplied ids: the unique index is what turns a collision into 409.
    await this.#collection.createIndex({ channelId: 1 }, { unique: true });
    await this.#collection.createIndex({ 'members.user_id': 1 });
    ['invites', 'connections', 'blocks', 'reports'].forEach((name) => {
      this.#c[name] = db.collection(name);
    });
    await this.#c.invites.createIndex({ channelId: 1, to: 1 }, { unique: true });
    await this.#c.invites.createIndex({ to: 1 });
    await this.#c.invites.createIndex({ from: 1 });
    await this.#c.connections.createIndex({ a: 1, b: 1 }, { unique: true });
    await this.#c.connections.createIndex({ b: 1 });
    await this.#c.blocks.createIndex({ blocker: 1, blocked: 1 }, { unique: true });
    await this.#c.blocks.createIndex({ blocked: 1 });
    // 90-day retention, by mongo's TTL monitor
    await this.#c.reports.createIndex(
      { createdAt: 1 }, { expireAfterSeconds: REPORT_RETENTION_SEC }
    );
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
