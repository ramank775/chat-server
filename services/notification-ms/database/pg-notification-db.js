const { INotificationDB } = require('./notification-db');
const { addPgOptions, initPgPool, ensureSchema } = require('../../../libs/pg-utils');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS push_topics (
    user_id text,
    device_id text,
    endpoint text,
    p256dh text,
    auth text,
    updated_at timestamptz,
    PRIMARY KEY (user_id, device_id)
  );
`;

class PgNotificationDB extends INotificationDB {
  /** @type {import('pg').Pool} */
  #pool;

  constructor(context) {
    super(context);
    this.#pool = initPgPool(context);
  }

  async upsertTopic(userId, options) {
    const { deviceId, endpoint, p256dh, auth } = options;
    await this.#pool.query(
      `INSERT INTO push_topics (user_id, device_id, endpoint, p256dh, auth, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, device_id) DO UPDATE SET endpoint = EXCLUDED.endpoint,
         p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, updated_at = EXCLUDED.updated_at`,
      [userId, deviceId, endpoint, p256dh, auth, new Date()]
    );
  }

  async removeTopic(userId, options = {}) {
    const params = [userId];
    let sql = 'DELETE FROM push_topics WHERE user_id = $1';
    if (options.deviceId) {
      params.push(options.deviceId);
      sql += ` AND device_id = $${params.length}`;
    }
    if (options.endpoint) {
      params.push(options.endpoint);
      sql += ` AND endpoint = $${params.length}`;
    }
    await this.#pool.query(sql, params);
  }

  async getTopics(userId) {
    const { rows } = await this.#pool.query(
      `SELECT device_id AS "deviceId", endpoint, p256dh, auth FROM push_topics WHERE user_id = $1`,
      [userId]
    );
    return rows;
  }

  async init() {
    await ensureSchema(this.#pool, SCHEMA);
  }

  async dispose() {
    await this.#pool.end();
  }
}

module.exports = {
  code: 'pg',
  addOptions: addPgOptions,
  Implementation: PgNotificationDB
};
