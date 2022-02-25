const { uuidv4 } = require('../../../helper');
const { IAuthProvider, UnAuthorizedError } = require('./auth-provider');

class MockAuthProvider extends IAuthProvider {

  /** @type {Map<string, Set<string>>} */
  #cache = new Map();

  /**
   * Verify Access key for the user
   * @param {string} username 
   * @param {string} accesskey 
   * @returns {Promise<void>}
   */
  async verifyAccessKey(username, accesskey) {
    let accessKeys = new Set();
    if (this.#cache.has(username)) {
      accessKeys = this.#cache.get(username);
      if (accessKeys.has(accesskey)) {
        return;
      }
    }
    throw new UnAuthorizedError();
  }

  /**
   * Decode the external token supplied
   * @param {string} token 
   * @param {{verify: boolean}} _options 
   * @returns {Promise<{uid: string; [key:string]: *}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async decodeExternalToken(token, _options) {
    if(token == null) {
      throw new Error('invalid token');
    }
    return {uid: uuidv4()};
  }

  /**
   * Generate new access key
   * @param {string} username 
   * @returns {Promise<string>}
   */
  async generateAccessKey(username) {
    const newAccessKey = uuidv4()
    let accessKeys = new Set();
    if (this.#cache.has(username)) {
      accessKeys = this.#cache.get(username);
    }
    accessKeys.add(newAccessKey);
    this.#cache.set(username, accessKeys);
  }

  /**
   * Revoke user's session
   * @param {string} username 
   * @param {string} accesskey 
   */
  async revoke(username, accesskey) {
    if (this.#cache.has(username)) {
      const accessKeys = this.#cache.get(username);
      accessKeys.delete(accesskey);
      this.#cache.set(username, accesskey);
    }
  }

}

function addOptions(cmd) {
  return cmd;
}

module.exports = {
  code: 'mock',
  addOptions,
  Implementation: MockAuthProvider
}
