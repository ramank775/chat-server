/* eslint-disable class-methods-use-this */

/**
 * @abstract
 * Interface for Channel Database
 */
 class IChannelDB {

  /**
   * Channel Database interface
   * @param {*} context 
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IChannelDB) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

   /**
    * @abstract
   * Get all the channels of a member
   * @param {string} memberId
   * @param {string|null} type
   * @returns {Promise<[]>}
   */
  // eslint-disable-next-line no-unused-vars
    async getMemberChannels(memberId, type = null) {
      throw new Error('Method not implemented')
    }
  
  /**
   * @abstract
   * Create new Channel
   * @param {{name: string; type: string; members: {username: string, role: string}[]; profilePic: string|null}} payload
   * @returns {Promise<string>}
   */
  // eslint-disable-next-line no-unused-vars
  async create(payload) {
    throw new Error('Method not implemented')
  }

  /**
   * Get Channel info
   * @param {string} channelId 
   * @param {string|null} memberId
   * @returns {Promise<{name: string; type: string; members: {username: string, role: string}[]; profilePic: string|null}>}
   */
  // eslint-disable-next-line no-unused-vars
  async getChannelInfo(channelId, memberId) {
    throw new Error('Method not implemented')
  }

  /**
   * @abstract
   * Add Member to existing channel
   * @param {string} channelId
   * @param {{username: string; role: string}} newMembers
   */
  // eslint-disable-next-line no-unused-vars
  async addMember(channelId, newMembers) {
    throw new Error('Method not implemented')
  }

  /**
   * Remove member from the channel
   * @param {string} channelId 
   * @param {string[]} exitMemberIds
   */
  // eslint-disable-next-line no-unused-vars
  async removeMember(channelId, exitMemberIds) {
    throw new Error('Method not implemented')
  }


  /**
   * @abstract
   * Update Member role
   * @param {string} channelId 
   * @param {string} role 
   */
  // eslint-disable-next-line no-unused-vars
   async updateMemberRole(channelId, role) {
     throw new Error('Not implemented Exception')
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
}
