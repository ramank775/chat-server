const { IAuthDB } = require('./auth-db');
const { addMongodbOptions, initMongoClient } = require('../../../../libs/mongo-utils');

const OTP_SESSION_TTL_SEC = 600;
const PROJECTION = { projection: { _id: 0 } };

class MongoAuthDB extends IAuthDB {
  /** @type { import('mongodb').MongoClient } */
  #client;

  /** @type { import('mongodb').Collection } */
  #otpSessions;

  /** @type { import('mongodb').Collection } */
  #sessions;

  /**
   * Auth Database interface
   * @param {*} context
   */
  constructor(context) {
    super(context);
    this.#client = initMongoClient(context);
  }

  async createOtpSession(session) {
    await this.#otpSessions.insertOne({ ...session });
  }

  async getOtpSession(sessionId) {
    return this.#otpSessions.findOne({ sessionId }, PROJECTION);
  }

  async getActiveOtpSession(phone, deviceId, now) {
    return this.#otpSessions.findOne(
      { phone, deviceId, consumed: false, resendAfter: { $gt: now }, expiresAt: { $gt: now } },
      PROJECTION
    );
  }

  async updateOtpSession(sessionId, updates) {
    return this.#otpSessions.findOneAndUpdate(
      { sessionId },
      { $set: updates },
      { returnDocument: 'after', ...PROJECTION }
    );
  }

  async incrementOtpAttempts(sessionId) {
    return this.#otpSessions.findOneAndUpdate(
      { sessionId },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after', ...PROJECTION }
    );
  }

  async consumeOtpSession(sessionId) {
    return this.#otpSessions.findOneAndUpdate(
      { sessionId, consumed: false },
      { $set: { consumed: true } },
      { returnDocument: 'after', ...PROJECTION }
    );
  }

  async upsertSession(session) {
    const { user_id: userId, deviceId } = session;
    await this.#sessions.replaceOne({ user_id: userId, deviceId }, { ...session }, { upsert: true });
  }

  async getLiveSessionByAccesskey(accesskey, now) {
    return this.#sessions.findOne(
      { accesskey, revokedAt: null, expiresAt: { $gt: now } },
      PROJECTION
    );
  }

  async rotateSession(refreshTokenHash, deviceId, next, now) {
    return this.#sessions.findOneAndUpdate(
      {
        refreshTokenHash,
        deviceId,
        revokedAt: null,
        refreshTokenExpiresAt: { $gt: now }
      },
      { $set: next },
      { returnDocument: 'after', ...PROJECTION }
    );
  }

  async revokeSessionByAccesskey(accesskey) {
    await this.#sessions.updateOne(
      { accesskey, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
  }

  async revokeAllSessions(userId) {
    await this.#sessions.updateMany(
      { user_id: userId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
  }

  async init() {
    await this.#client.connect();
    const db = this.#client.db();
    this.#otpSessions = db.collection('otp_sessions');
    this.#sessions = db.collection('sessions');
    await this.#otpSessions.createIndex({ sessionId: 1 }, { unique: true });
    await this.#otpSessions.createIndex({ phone: 1, deviceId: 1 });
    await this.#otpSessions.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: OTP_SESSION_TTL_SEC }
    );
    await this.#sessions.createIndex({ user_id: 1, deviceId: 1 }, { unique: true });
    await this.#sessions.createIndex({ accesskey: 1 });
    await this.#sessions.createIndex({ refreshTokenHash: 1 });
  }

  async dispose() {
    await this.#client.close();
  }
}

function addDatabaseOptions(cmd) {
  cmd = addMongodbOptions(cmd);
  return cmd;
}

module.exports = {
  code: 'mongo',
  addOptions: addDatabaseOptions,
  Implementation: MongoAuthDB,
  OTP_SESSION_TTL_SEC
};
