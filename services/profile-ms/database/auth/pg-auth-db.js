const { IAuthDB } = require('./auth-db');
const { OTP_SESSION_TTL_SEC } = require('./mongo-auth-db');
const {
  addPgOptions,
  initPgPool,
  ensureSchema,
  selectList,
  assignments,
  insertSql
} = require('../../../../libs/pg-utils');

/** How often the OTP sweep runs: the TTL index's job, done by hand. */
const SWEEP_MS = 60 * 1000;

/** Document fields; each column is the field's snake_case (libs/pg-utils `column`). */
const OTP_FIELDS = [
  'sessionId',
  'phone',
  'deviceId',
  'userId',
  'codeHash',
  'encryptedCode',
  'attempts',
  'consumed',
  'resendAfter',
  'expiresAt',
  'createdAt'
];
const SESSION_FIELDS = [
  'user_id',
  'deviceId',
  'accesskey',
  'refreshTokenHash',
  'createdAt',
  'expiresAt',
  'refreshTokenExpiresAt',
  'revokedAt'
];
const OTP = selectList(OTP_FIELDS);
const SESSION = selectList(SESSION_FIELDS);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS device_keys (
    user_id text NOT NULL,
    device_id text NOT NULL,
    record jsonb NOT NULL,
    PRIMARY KEY (user_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS otp_sessions (
    session_id text PRIMARY KEY,
    phone text,
    device_id text,
    user_id text,
    code_hash text,
    encrypted_code text,
    attempts integer,
    consumed boolean,
    resend_after timestamptz,
    expires_at timestamptz,
    created_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS otp_sessions_phone_device ON otp_sessions (phone, device_id);
  CREATE TABLE IF NOT EXISTS sessions (
    user_id text,
    device_id text,
    accesskey text,
    refresh_token_hash text,
    created_at timestamptz,
    expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    revoked_at timestamptz,
    PRIMARY KEY (user_id, device_id)
  );
  CREATE INDEX IF NOT EXISTS sessions_accesskey ON sessions (accesskey);
  CREATE INDEX IF NOT EXISTS sessions_refresh_token_hash ON sessions (refresh_token_hash);
`;

class PgAuthDB extends IAuthDB {
  /** @type {import('pg').Pool} */
  #pool;

  #log;

  /** @type {NodeJS.Timeout} */
  #sweep;

  constructor(context) {
    super(context);
    this.#pool = initPgPool(context);
    this.#log = context.log;
  }

  async #one(sql, params) {
    const { rows } = await this.#pool.query(sql, params);
    return rows[0] || null;
  }

  async createOtpSession(session) {
    await this.#pool.query(
      insertSql('otp_sessions', OTP_FIELDS),
      OTP_FIELDS.map((field) => session[field])
    );
  }

  async getOtpSession(sessionId) {
    return this.#one(`SELECT ${OTP} FROM otp_sessions WHERE session_id = $1`, [sessionId]);
  }

  async getActiveOtpSession(phone, deviceId, now) {
    return this.#one(
      `SELECT ${OTP} FROM otp_sessions
       WHERE phone = $1 AND device_id = $2 AND NOT consumed AND resend_after > $3 AND expires_at > $3
       LIMIT 1`,
      [phone, deviceId, now]
    );
  }

  async updateOtpSession(sessionId, updates) {
    return this.#one(
      `UPDATE otp_sessions SET ${assignments(OTP_FIELDS, updates, 2)}
       WHERE session_id = $1 RETURNING ${OTP}`,
      [sessionId, ...Object.values(updates)]
    );
  }

  async incrementOtpAttempts(sessionId) {
    return this.#one(
      `UPDATE otp_sessions SET attempts = attempts + 1 WHERE session_id = $1 RETURNING ${OTP}`,
      [sessionId]
    );
  }

  async consumeOtpSession(sessionId) {
    return this.#one(
      `UPDATE otp_sessions SET consumed = true
       WHERE session_id = $1 AND NOT consumed RETURNING ${OTP}`,
      [sessionId]
    );
  }

  async upsertSession(session) {
    // the whole row is replaced, like mongo's replaceOne
    await this.#pool.query(
      `${insertSql('sessions', SESSION_FIELDS)}
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         accesskey = EXCLUDED.accesskey,
         refresh_token_hash = EXCLUDED.refresh_token_hash,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at,
         refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
         revoked_at = EXCLUDED.revoked_at`,
      SESSION_FIELDS.map((field) => session[field])
    );
  }

  async getLiveSessionByAccesskey(accesskey, now) {
    return this.#one(
      `SELECT ${SESSION} FROM sessions
       WHERE accesskey = $1 AND revoked_at IS NULL AND expires_at > $2 LIMIT 1`,
      [accesskey, now]
    );
  }

  async rotateSession(refreshTokenHash, deviceId, next, now) {
    return this.#one(
      `UPDATE sessions SET ${assignments(SESSION_FIELDS, next, 4)}
       WHERE refresh_token_hash = $1 AND device_id = $2
         AND revoked_at IS NULL AND refresh_token_expires_at > $3
       RETURNING ${SESSION}`,
      [refreshTokenHash, deviceId, now, ...Object.values(next)]
    );
  }

  async revokeSessionByAccesskey(accesskey) {
    await this.#pool.query(
      'UPDATE sessions SET revoked_at = $2 WHERE accesskey = $1 AND revoked_at IS NULL',
      [accesskey, new Date()]
    );
  }

  async revokeAllSessions(userId, exceptDeviceId) {
    await this.#pool.query(
      `UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL
       AND device_id IS DISTINCT FROM $3`,
      [userId, new Date(), exceptDeviceId || null]
    );
  }

  async devicesOf(userIds, revokedSince) {
    const { rows } = await this.#pool.query(
      `SELECT ${selectList(['user_id', 'deviceId'])} FROM sessions
       WHERE user_id = ANY($1) AND (revoked_at IS NULL OR revoked_at >= $2)`,
      [userIds, revokedSince]
    );
    return rows;
  }

  async getDeviceKeys(userId, deviceId) {
    const row = await this.#one(
      'SELECT record FROM device_keys WHERE user_id = $1 AND device_id = $2',
      [userId, deviceId]
    );
    return row?.record || null;
  }

  async saveDeviceKeys(record, expectedRevision) {
    const params = [record.user_id, record.deviceId, JSON.stringify(record)];
    const result = expectedRevision === null
      ? await this.#pool.query(
        'INSERT INTO device_keys (user_id, device_id, record) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING', params
      )
      : await this.#pool.query(
        `UPDATE device_keys SET record = $3::jsonb
         WHERE user_id = $1 AND device_id = $2 AND record->>'revision' = $4`,
        [...params, expectedRevision]
      );
    return result.rowCount === 1;
  }

  async listDeviceKeys(userId) {
    const { rows } = await this.#pool.query('SELECT record FROM device_keys WHERE user_id = $1', [userId]);
    return rows.map((row) => row.record);
  }

  async deleteDeviceKeys(userId, { deviceId, exceptDeviceId } = {}) {
    await this.#pool.query(
      `DELETE FROM device_keys WHERE user_id = $1
       AND ($2::text IS NULL OR device_id = $2) AND device_id IS DISTINCT FROM $3`,
      [userId, deviceId || null, exceptDeviceId || null]
    );
  }

  /**
   * Every read already filters on `expiresAt`, so expired OTP sessions only
   * take space: a periodic delete does the mongo TTL index's job.
   */
  async sweepOtpSessions() {
    await this.#pool.query('DELETE FROM otp_sessions WHERE created_at < $1', [
      new Date(Date.now() - OTP_SESSION_TTL_SEC * 1000)
    ]);
  }

  async init() {
    await ensureSchema(this.#pool, SCHEMA);
    this.#sweep = setInterval(() => {
      this.sweepOtpSessions().catch((error) =>
        this.#log?.error(`otp session sweep failed: ${error.message}`));
    }, SWEEP_MS);
    this.#sweep.unref();
  }

  async dispose() {
    clearInterval(this.#sweep);
    await this.#pool.end();
  }
}

module.exports = {
  code: 'pg',
  addOptions: addPgOptions,
  Implementation: PgAuthDB,
  OTP_FIELDS,
  SESSION_FIELDS
};
