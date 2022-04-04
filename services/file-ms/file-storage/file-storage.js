/* eslint-disable class-methods-use-this */

/**
 * @abstract
 * Interface for File Database
 */
 class IFileStorage {

  /**
   * Group Database interface
   * @param {*} context 
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IFileStorage) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * @abstract
   * Get Signed URL
   * @param {{fileId: string; type: string; contentType: string, operation: 'upload'|'download'}} payload
   * @returns {Promise<string>}
   */
   // eslint-disable-next-line no-unused-vars
  async getSignedUrl(payload) {
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
  IFileStorage
}
