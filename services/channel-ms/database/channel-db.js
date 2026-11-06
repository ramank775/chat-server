/* eslint-disable class-methods-use-this, no-unused-vars */

/** How long a report is kept: 90 days. */
const REPORT_RETENTION_SEC = 90 * 24 * 60 * 60;

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
 * @typedef {object} Invite
 * @property {string} channelId a group's id, or the derived DM id of a 1:1 invite
 * @property {string} to who is invited
 * @property {string} from who invited
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
   * Its pending invites go too.
   * @param {string} channelId
   */
  async deleteChannel(channelId) {
    throw new Error('Method not implemented');
  }

  // ---- connecting (decisions 219-221) ----------------------------------
  // An invite is keyed (channelId, to): a group's id, or for a 1:1 invite
  // the pair's derived DM id. A connection is the pair (a < b); a block is
  // (blocker, blocked); both are user_ids.

  /**
   * @abstract
   * Store a pending invite. False when (channelId, to) is already pending.
   * @param {Invite} invite
   * @returns {Promise<boolean>}
   */
  async addInvite(invite) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * @param {string} channelId
   * @param {string} to
   * @returns {Promise<Invite|null>}
   */
  async getInvite(channelId, to) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * @param {string} channelId
   * @param {string} to
   * @returns {Promise<boolean>} whether one was pending
   */
  async deleteInvite(channelId, to) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Every pending invite from or to `userId` (null: none), or in one of
   * `channelIds`, oldest first.
   * @param {string|null} userId
   * @param {string[]} [channelIds]
   * @returns {Promise<Invite[]>}
   */
  async findInvites(userId, channelIds = []) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Connect the pair; a no-op when they are.
   * @param {string} a
   * @param {string} b
   * @param {number} at
   */
  async connect(a, b, at) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * @param {string} userId
   * @returns {Promise<string[]>} who `userId` is connected with
   */
  async connectionsOf(userId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * @returns {Promise<boolean>} whether any pair is connected at all
   */
  async anyConnection() {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Block (`on`) or unblock.
   * @param {string} blocker
   * @param {string} blocked
   * @param {boolean} on
   */
  async setBlocked(blocker, blocked, on) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * @param {string} blocker
   * @returns {Promise<string[]>} everyone `blocker` blocked
   */
  async blockedBy(blocker) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Everything the invite gate asks about a pair, in one call.
   * @param {string} a
   * @param {string} b
   * @returns {Promise<{connected: boolean, aBlockedB: boolean, bBlockedA: boolean,
   *   shareGroup: boolean}>}
   */
  async pair(a, b) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Account deletion: every invite from or to `userId`, their connections
   * and blocks either way.
   * @param {string} userId
   */
  async forget(userId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * @param {{reporter: string, reported: string, messages: object[]}} report
   */
  async addReport(report) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Drop the reports filed before `before` (90-day retention).
   * @param {Date} before
   */
  async purgeReports(before) {
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
  IChannelDB,
  REPORT_RETENTION_SEC
};
