const admin = require('firebase-admin');
const { uuidv4 } = require('../../../helper');
const { IAuthProvider, UnAuthorizedError } = require('./auth-provider');

class FirebaseAuthProvider extends IAuthProvider {

  /** @type {import('../database/auth/auth-db').IAuthDB} */
  #db;

  /** @type {Map<string, Set<string>>} */
  #cache = new Map();

  #projectId;

  /** @type {admin.auth.Auth} */
  #firebaseAuth;

  /**
   * Auth provider interface
   * @param {{authDB: import('../database/auth/auth-db').IAuthDB; options: {[key: string]: *}}} context 
   */
  constructor(context) {
    super(context);
    this.#db = context.authDB;
    this.#projectId = context.options.firebaseProjectId;
    
  }

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
    const exits = await this.#db.isExits(username, accesskey);
    if (exits) {
      accessKeys.add(accesskey);
      this.#cache.set(username, accessKeys);
      return;
    }

    throw new UnAuthorizedError();
  }

  /**
   * Decode the external token supplied
   * @param {string} token 
   * @returns {Promise<{uid: string; [key:string]: *}>}
   */
  async decodeExternalToken(token) {
    const decodedToken = await this.#firebaseAuth.verifyIdToken(token, false);
    return decodedToken;
  }

  /**
   * Generate new access key
   * @param {string} username 
   * @returns {Promise<string>}
   */
  async generateAccessKey(username) {
    const newAccessKey = uuidv4()
    await this.#db.create(username, newAccessKey)
    let accessKeys = new Set();
    if (this.#cache.has(username)) {
      accessKeys = this.#cache.get(username);
    }
    accessKeys.add(newAccessKey);
    this.#cache.set(username, accessKeys);
    return newAccessKey;
  }

  /**
   * Revoke user's session
   * @param {string} username 
   * @param {string} accesskey 
   */
  async revoke(username, accesskey) {
    await this.#db.revoke(username, accesskey);
    if (this.#cache.has(username)) {
      const accessKeys = this.#cache.get(username);
      accessKeys.delete(accesskey);
      this.#cache.set(username, accesskey);
    }
  }

  async init() {
    const app = admin.initializeApp({
      projectId: this.#projectId
    });
    this.#firebaseAuth = app.auth();
  }

  async dispose() {
    await this.#db.dispose();
  }
}

function firebaseProjectOptions(cmd) {
  return cmd.option('--firebase-project-id <firebaseProjectId>', 'Firebase Project Id');
}

module.exports = {
  code: 'firebase',
  addOptions: firebaseProjectOptions,
  Implementation: FirebaseAuthProvider
}
