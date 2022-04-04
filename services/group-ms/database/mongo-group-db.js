const { IGroupDB } = require("./group-db");
const { addMongodbOptions, initMongoClient } = require('../../../libs/mongo-utils');
const { uuidv4, } = require('../../../helper');

class MongoGroupDB extends IGroupDB {

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
   * Get all the groups of a member
   * @param {string} memberId
   */
  async getMemberGroups(memberId) {
    const groups = await this.#collection.find(
        { 'members.username': memberId },
        {
          projection: { _id: 0, groupId: 1, name: 1, members: 1, profilePic: 1 }
        }
      )
      .toArray();
    return groups || []
  }

  /**
   * Create new User group
   * @param {{name: string; members: {username: string, role: string}[]; profilePic: string|null}} payload
   * @returns {Promise<string>}
   */
  async create(payload) {
    const groupDoc = {
      groupId: uuidv4(),
      name: payload.name,
      members: payload.members,
      profilePic: payload.profilePic,
      addedOn: new Date()
    }
    await this.#collection.insertOne(groupDoc);
    return groupDoc.groupId
  }

  /**
   * Get Group info
   * @param {string} groupId 
   * @param {string} memberId
   */
  async getGroupInfo(groupId, memberId) {
    const group = await this.#collection.findOne({
      groupId, 'members.username': memberId
    }, {
      projection: {
        groupId: 1,
        name: 1,
        members: 1,
        profilePic: 1
      }
    })
    return group;
  }

  /**
   * Add Members to existing group
   * @param {string} groupId
   * @param {string} memberId
   * @param {{username: string; role: string}[]} members
   */
  async addMember(groupId, memberId, newMembers) {
    await this.#collection.updateOne({
      groupId, 'members.username': memberId
    }, {
      $addToSet: { members: { $each: newMembers } }
    })
  }

  /**
   * Remove member from the group
   * @param {string} groupId 
   * @param {string} memberId
   * @param {string[]} exitMemberIds
   */
  async removeMember(groupId, memberId, exitMemberIds) {
    await this.#collection.updateOne({
      groupId, 'members.username': memberId
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
   * @param {string} groupId 
   * @param {string} memberId 
   * @param {string} role 
   */
  async updateMemberRole(groupId, memberId, role) {
    await this.#collection.updateOne({
      groupId, 'members.username': memberId
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
    this.#collection = db.collection('groups');
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
  Implementation: MongoGroupDB,
}
