const { IProfileDB } = require('./profile-db');
const {
  addPgOptions,
  initPgPool,
  ensureSchema,
  selectList,
  assignments,
  insertSql
} = require('../../../../libs/pg-utils');
const { sha256 } = require('../../../../helper');

/** The `users` fields; the column of each is its snake_case (libs/pg-utils `column`). */
const FIELDS = [
  'user_id',
  'phoneKey',
  'username',
  'usernameLower',
  'usernameKeyHash',
  'usernameChangedAt',
  'displayName',
  'avatarUrl',
  'statusText',
  'discoverability',
  'presence',
  'lastSeenAt',
  'createdAt',
  'updatedAt',
  'deletedAt'
];
const USER = selectList(FIELDS);
// the chosen list is written with the rest, only ever checked one token at a time
const WRITABLE = [...FIELDS, 'discoveryTokens'];

/** The live-phone unique index: its name is how a 23505 says which field collided. */
const PHONE_INDEX = 'users_phone_key_live';

// user_id is the primary key and rows are only ever tombstoned, so a deleted
// id is never reassigned. A deleted account releases its phone, so the phone
// key is unique among live users only. username_lower is a plain unique index:
// postgres never counts NULLs as duplicates, so unset usernames never collide.
// The ALTERs bring a table from before decision 223 up; migratePhones then
// drops its plain `phone` and `phone_hash`.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    user_id text PRIMARY KEY,
    phone_key text,
    username text,
    username_lower text UNIQUE,
    username_key_hash text,
    username_changed_at timestamptz,
    display_name text,
    avatar_url text,
    status_text text,
    discoverability text,
    discovery_tokens text[],
    created_at timestamptz,
    updated_at timestamptz,
    deleted_at timestamptz
  );
  ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_key text,
    ADD COLUMN IF NOT EXISTS discoverability text,
    ADD COLUMN IF NOT EXISTS discovery_tokens text[];
  CREATE UNIQUE INDEX IF NOT EXISTS ${PHONE_INDEX} ON users (phone_key) WHERE deleted_at IS NULL;
  CREATE TABLE IF NOT EXISTS profile_meta (key text PRIMARY KEY, value text);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS presence text;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
`;

class PgProfileDB extends IProfileDB {
  /** @type {import('pg').Pool} */
  #pool;

  constructor(context) {
    super(context);
    this.#pool = initPgPool(context);
  }

  async #one(sql, params) {
    const { rows } = await this.#pool.query(sql, params);
    return rows[0] || null;
  }

  async existsUserId(userId) {
    return !!(await this.#one('SELECT 1 FROM users WHERE user_id = $1', [userId]));
  }

  async createUser(user) {
    await this.#pool.query(insertSql('users', FIELDS), FIELDS.map((field) => user[field]));
    return this.getByUserId(user.user_id);
  }

  async getByUserId(userId) {
    return this.#one(`SELECT ${USER} FROM users WHERE user_id = $1 AND deleted_at IS NULL`, [
      userId
    ]);
  }

  async getByPhoneKey(phoneKey) {
    return this.#one(`SELECT ${USER} FROM users WHERE phone_key = $1 AND deleted_at IS NULL`, [
      phoneKey
    ]);
  }

  async getByUsername(usernameLower) {
    return this.#one(
      `SELECT ${USER} FROM users WHERE username_lower = $1 AND deleted_at IS NULL`,
      [usernameLower]
    );
  }

  async getUsernameHolder(usernameLower) {
    return this.#one(`SELECT ${USER} FROM users WHERE username_lower = $1`, [usernameLower]);
  }

  async getByPhoneKeys(phoneKeys) {
    const { rows } = await this.#pool.query(
      `SELECT ${USER} FROM users WHERE phone_key = ANY($1) AND deleted_at IS NULL`,
      [phoneKeys]
    );
    return rows;
  }

  async hasDiscoveryToken(userId, token) {
    return !!(await this.#one(
      'SELECT 1 FROM users WHERE user_id = $1 AND deleted_at IS NULL AND $2 = ANY(discovery_tokens)',
      [userId, token]
    ));
  }

  async migratePhones(keyOf, fingerprint) {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // the boot DDL's lock: one service at a time migrates
      await client.query("SELECT pg_advisory_xact_lock(hashtext('vartalap.schema'), 0)");
      await client.query(
        'INSERT INTO profile_meta (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        ['phone_pepper', fingerprint]
      );
      const { rows: [stamp] } = await client.query(
        'SELECT value FROM profile_meta WHERE key = $1',
        ['phone_pepper']
      );
      if (stamp.value !== fingerprint) {
        throw new Error('PHONE_PEPPER differs from the one this database was keyed with');
      }
      const { rows: [legacy] } = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'phone'`
      );
      if (legacy) {
        const { rows } = await client.query(
          `SELECT user_id, phone, phone_hash FROM users
           WHERE deleted_at IS NULL AND (phone IS NOT NULL OR phone_hash IS NOT NULL)`
        );
        await client.query(
          `UPDATE users SET phone_key = keyed.key
           FROM unnest($1::text[], $2::text[]) AS keyed(id, key) WHERE users.user_id = keyed.id`,
          [
            rows.map((row) => row.user_id),
            rows.map((row) => keyOf(row.phone_hash || sha256(row.phone)))
          ]
        );
        // their indexes go with them
        await client.query('ALTER TABLE users DROP COLUMN phone, DROP COLUMN IF EXISTS phone_hash');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateUser(userId, updates) {
    const values = { ...updates, updatedAt: new Date() };
    try {
      return await this.#one(
        `UPDATE users SET ${assignments(WRITABLE, values, 2)}
         WHERE user_id = $1 AND deleted_at IS NULL RETURNING ${USER}`,
        [userId, ...Object.values(values)]
      );
    } catch (error) {
      if (error.code === '23505') {
        // which unique index rejected us: the live phone on a rebind, the username on a rename
        const field = error.constraint === PHONE_INDEX ? 'phone' : 'usernameLower';
        const taken = new Error(`${field} already taken`);
        taken.code = field === 'phone' ? 'PHONE_TAKEN' : 'USERNAME_TAKEN';
        throw taken;
      }
      throw error;
    }
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
  Implementation: PgProfileDB,
  FIELDS
};
