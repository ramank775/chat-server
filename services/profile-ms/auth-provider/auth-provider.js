/* eslint-disable max-classes-per-file */
/* eslint-disable class-methods-use-this */

class IAuthProvider {
  
  /**
   * Auth provider interface
   * @param {{authDB: import('../database/auth/auth-db').IAuthDB; options: {[key: string]: *}}} context 
   */
  // eslint-disable-next-line no-unused-vars
  constructor(context) {
    if (this.constructor === IAuthProvider) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  /**
   * Verify Access key for the user
   * @param {string} username 
   * @param {string} accesskey 
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async verifyAccessKey(username, accesskey) {
    throw new Error('Method not implemented');
  }

  /**
   * Decode the external token supplied
   * @param {string} token
   * @returns {Promise<{uid: string; [key:string]: *}>}
   */
  // eslint-disable-next-line no-unused-vars
  async decodeExternalToken(token) {
    throw new Error('Method not implemented');
  }

  /**
   * Generate new access key
   * @param {string} username 
   * @returns {Promise<string>}
   */
  // eslint-disable-next-line no-unused-vars
  async generateAccessKey(username) {
    throw new Error('Method not implemented');
  }

  /**
   * Revoke user's session
   * @param {string} username 
   * @param {string} accesskey 
   */
  // eslint-disable-next-line no-unused-vars
  async revoke(username, accesskey) {
    throw new Error('Method not implemented');
  }

  /**
   * @abstract
   * Initialize the auth provider instance
   */
   // eslint-disable-next-line no-empty-function
   async init() {}

  /**
   * @abstract
   * Dispose the auth provider internal resources
   */
  // eslint-disable-next-line no-empty-function
  async dispose() {}
}

class UnAuthorizedError extends Error {
  code = 'error.unauthorized'

  constructor() {
    super('UnAuthorized');
  }
}

module.exports = {
  IAuthProvider,
  UnAuthorizedError
}
