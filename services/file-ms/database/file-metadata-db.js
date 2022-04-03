/* eslint-disable class-methods-use-this */

/**
 * @abstract
 * Interface for File Database
 */
 class IFileMetadataDB {

  /**
   * Group Database interface
   * @param {*} context 
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IFileMetadataDB) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * @abstract
   * Create new File record
   * @param {{fileName: string; owner: string; contentType: string; type: string}} payload
   * @returns {Promise<string>}
   */
  // eslint-disable-next-line no-unused-vars
  async createRecord(payload) {
    throw new Error('Method not implemented')
  }

  /**
   * Get File record
   * @param {string} fileId 
   */
  // eslint-disable-next-line no-unused-vars
  async getRecord(fileId) {
    throw new Error('Method not implemented')
  }

  /**
   * Update File status
   */
  // eslint-disable-next-line no-unused-vars
  async updateFileStatus(fileId, status){
    throw new Error('Method not implemented')
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
  IFileMetadataDB
}
