const { IChannelDB } = require('./channel-db');
const { addMongodbOptions, initMongoClient } = require('../../../libs/mongo-utils');
const { uuidv4, } = require('../../../helper');

class MongoChannelDB extends IChannelDB {

  /** @type { import('mongodb').MongoClient } */
  #client;

  /** @type { import('mongodb').Collection } */
  #collection;

  /**
   * Channel Database interface
   * @param {*} context 
   */
  constructor(context) {
    super(context);
    this.#client = initMongoClient(context);
  }

  /**
   * Get all the channels of a member
   * @param {string} memberId
   * @param {string|null} type
   */
  async getMemberChannels(memberId, type = null) {
    const query = { 'members.username': memberId };
    if (type) {
      query.type = type.toLowerCase()
    }
    const channels = await this.#collection.find(
      query,
      {
        projection: {
          _id: 0,
          channelId: 1,
          name: 1,
          type: 1,
          members: 1,
          profilePic: 1
        }
      }
    )
      .toArray();
    return channels || []
  }

  /**
   * Create new Channel
   * @param {{name: string; type: string; members: {username: string, role: string; since: number;}[]; profilePic: string|null}} payload
   * @returns {Promise<string>}
   */
  async create(payload) {
    const channelDoc = {
      channelId: uuidv4(),
      type: payload.type.toLowerCase(),
      name: payload.name,
      members: payload.members,
      profilePic: payload.profilePic,
      addedOn: new Date()
    }
    await this.#collection.insertOne(channelDoc);
    return channelDoc.channelId
  }

  /**
   * Get Channel info
   * @param {string} channelId 
   * @param {string|null} memberId
   */
  async getChannelInfo(channelId, memberId) {
    const query = {
      channelId,
    };
    if (memberId) {
      query['members.username']  = memberId;
    }
    const channel = await this.#collection.findOne(query, {
      projection: {
        channelId: 1,
        name: 1,
        type: 1,
        members: 1,
        profilePic: 1
      }
    })
    return channel;
  }

  /**
   * Add Members to existing channel
   * @param {string} channelId
   * @param {string} memberId
   * @param {{username: string; role: string; since: number;}[]} members
   */
  async addMember(channelId, newMembers) {
    await this.#collection.updateOne({
      channelId,
    }, {
      $addToSet: { members: { $each: newMembers } }
    })
  }

  /**
   * Remove member from the channel
   * @param {string} channelId 
   * @param {string} memberId
   * @param {string[]} exitMemberIds
   */
  async removeMember(channelId, exitMemberIds) {
    await this.#collection.updateOne({
      channelId,
    }, {
      $pull: {
        members: {
          username: {
            $in: exitMemberIds
          }
        }
      }
    })
  }

  /**
   * Update Member role
   * @param {string} channelId 
   * @param {string} memberId 
   * @param {string} role 
   */
  async updateMemberRole(channelId, role) {
    await this.#collection.updateOne({
      channelId,
    }, {
      $set: { 'members.$.role': role }
    })
  }

  /**
   * Initialize the database instance
   */
  async init() {
    await this.#client.connect();
    const db = this.#client.db();
    this.#collection = db.collection('channels');
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
  Implementation: MongoChannelDB,
}
