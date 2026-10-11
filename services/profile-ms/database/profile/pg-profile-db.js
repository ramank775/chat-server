const { IProfileDB } = require('./profile-db');
const {
  addPgOptions,
  initPgPool,
  ensureSchema,
  selectList,
  assignments,
  insertSql
} = require('../../../../libs/pg-utils');

/** The `users` fields; the column of each is its snake_case (libs/pg-utils `column`). */
const FIELDS = [
  'user_id',
  'phone',
  'phoneHash',
  'username',
  'usernameLower',
  'usernameKeyHash',
  'usernameChangedAt',
  'displayName',
  'avatarUrl',
  'statusText',
  'createdAt',
  'updatedAt',
  'deletedAt'
];
const USER = selectList(FIELDS);

/** The live-phone unique index: its name is how a 23505 says which field collided. */
const PHONE_INDEX = 'users_phone_live';

// user_id is the primary key and rows are only ever tombstoned, so a deleted
// id is never reassigned. A deleted account releases its phone, so the phone
// is unique among live users only. username_lower is a plain unique index:
// postgres never counts NULLs as duplicates, so unset usernames never collide.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    user_id text PRIMARY KEY,
    phone text,
    phone_hash text,
    username text,
    username_lower text UNIQUE,
    username_key_hash text,
    username_changed_at timestamptz,
    display_name text,
    avatar_url text,
    status_text text,
    created_at timestamptz,
    updated_at timestamptz,
    deleted_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ${PHONE_INDEX} ON users (phone) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS users_phone_hash ON users (phone_hash);
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

  async getByPhone(phone) {
    return this.#one(`SELECT ${USER} FROM users WHERE phone = $1 AND deleted_at IS NULL`, [phone]);
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

  async getByPhoneHashes(phoneHashes) {
    const { rows } = await this.#pool.query(
      `SELECT ${USER} FROM users WHERE phone_hash = ANY($1) AND deleted_at IS NULL`,
      [phoneHashes]
    );
    return rows;
  }

  async updateUser(userId, updates) {
    const values = { ...updates, updatedAt: new Date() };
    try {
      return await this.#one(
        `UPDATE users SET ${assignments(FIELDS, values, 2)}
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
