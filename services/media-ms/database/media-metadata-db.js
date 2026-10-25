/* eslint-disable class-methods-use-this */

/**
 * @abstract
 * Interface for File Database
 */
 class IMediaMetadataDB {

  /**
   * Group Database interface
   * @param {*} context 
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IMediaMetadataDB) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * @abstract
   * Create new File record
   * @param {{category: string; owner: string; contentType: string; md5?: string}} payload
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
   * @abstract
   * A completed file stored under a signed Content-MD5 of [md5] (hex), in
   * [category]: what a convergent upload can reuse. Null if none.
   * @param {string} _md5
   * @param {string} _category
   */
  // eslint-disable-next-line no-unused-vars
  async findByMd5(_md5, _category) {
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
  IMediaMetadataDB
}
