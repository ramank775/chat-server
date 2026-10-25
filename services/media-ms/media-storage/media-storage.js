/* eslint-disable class-methods-use-this */

/**
 * @abstract
 * Interface for File Database
 */
 class IMediaStorage {

  /**
   * Group Database interface
   * @param {*} context 
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IMediaStorage) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * @abstract
   * Get Signed URL
   * @param {{fileId: string; category: string; contentType: string, contentMd5?: string, operation: 'upload'|'download'}} payload
   * @returns {Promise<string>}
   */
   // eslint-disable-next-line no-unused-vars
  async getSignedUrl(payload) {
    throw new Error('Method not implemented')
  }

  /**
   * @abstract
   * Whether the object was stored.
   * @param {{fileId: string; category: string}} _payload
   * @returns {Promise<boolean>}
   */
  // eslint-disable-next-line no-unused-vars
  async exists(_payload) {
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
  IMediaStorage
}
