/* eslint-disable class-methods-use-this, no-unused-vars */

/**
 * @typedef {object} Member
 * @property {string} user_id 9 lowercase hex chars
 * @property {'owner'|'admin'|'member'} role
 * @property {number} joinedAt ms since epoch
 * @property {number|null} removedAt ms since epoch, null while the member is active
 */

/**
 * @typedef {object} Channel
 * @property {string} channelId client-generated UUIDv7 (SYNC_PROTOCOL 11.3)
 * @property {'group'} kind — trim 4: a DM id is derived, never a row
 * @property {string|null} name
 * @property {string|null} avatarUrl
 * @property {string} owner creator's user_id
 * @property {Member[]} members active members only on every read
 * @property {number} createdAt
 */

/**
 * @abstract
 * Interface for Channel Database
 */
class IChannelDB {
  /**
   * @param {*} context
   */
  constructor(context) {
    if (this.constructor === IChannelDB) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * @abstract
   * Every channel `memberId` is currently a member of
   * @param {string} memberId
   * @returns {Promise<Channel[]>}
   */
  async getMemberChannels(memberId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Insert a channel at its client-supplied id.
   * @param {Channel} channel
   * @throws an error with `code === 'CHANNEL_EXISTS'` when the id is taken
   * @returns {Promise<Channel>}
   */
  async create(channel) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * @param {string} channelId
   * @param {string|null} memberId when set, only matches if they are an active member
   * @returns {Promise<Channel|null>}
   */
  async getChannelInfo(channelId, memberId = null) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Add members, reviving any row a previous removal tombstoned.
   * @param {string} channelId
   * @param {Member[]} members
   */
  async addMembers(channelId, members) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Tombstone a member (keeps the row so `removedAt` survives).
   * @param {string} channelId
   * @param {string} userId
   * @param {number} at
   */
  async removeMember(channelId, userId, at) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Set one member's role (DECISIONS row 80 promote/demote, row 9 succession).
   * @param {string} channelId
   * @param {string} userId
   * @param {'owner'|'admin'|'member'} role
   */
  async setMemberRole(channelId, userId, role) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * @param {string} channelId
   * @param {{name?: string, avatarUrl?: string}} updates
   * @returns {Promise<Channel|null>}
   */
  async updateChannel(channelId, updates) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Hard delete: the owner's DELETE, or the last member leaving (row 9).
   * @param {string} channelId
   */
  async deleteChannel(channelId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Initialize the database instance
   */
  async init() {
    throw new Error('Not implemented Exception');
  }

  /**
   * @abstract
   * Dispose the database internal resources
   */
  async dispose() {
    throw new Error('Method not implemented');
  }
}

module.exports = {
  IChannelDB
};
