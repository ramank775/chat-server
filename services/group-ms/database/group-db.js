/**
 * @abstract
 * Interface for Group Database
 */
class IGroupDB {
  /**
   * Group Database interface
   * @param {*} context
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IGroupDB) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * @abstract
   * Get all the groups of a member
   * @param {string} memberId
   * @returns {Promise<[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async getMemberGroups(memberId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Create new User group
   * @param {{name: string; members: {username: string, role: string}[]; profilePic: string|null}} payload
   * @returns {Promise<string>}
   */
  // eslint-disable-next-line no-unused-vars
  async create(payload) {
    throw new Error('Method not implemented');
  }

  /**
   * Get Group info
   * @param {string} groupId
   * @param {string} memberId
   */
  // eslint-disable-next-line no-unused-vars
  async getGroupInfo(groupId, memberId) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Add Member to existing group
   * @param {string} groupId
   * @param {string} memberId
   * @param {{username: string; role: string}} newMembers
   */
  // eslint-disable-next-line no-unused-vars
  async addMember(groupId, memberId, newMembers) {
    throw new Error('Method not implemented');
  }

  /**
   * Remove member from the group
   * @param {string} groupId
   * @param {string} memberId
   * @param {string[]} exitMemberIds
   */
  // eslint-disable-next-line no-unused-vars
  async removeMember(groupId, memberId, exitMemberIds) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Update Member role
   * @param {string} groupId
   * @param {string} memberId
   * @param {string} role
   */
  // eslint-disable-next-line no-unused-vars
  async updateMemberRole(groupId, memberId, role) {
    throw new Error('Not implemented Exception');
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
  IGroupDB,
};
