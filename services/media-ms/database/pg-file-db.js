const crypto = require('crypto');
const { IMediaMetadataDB } = require('./media-metadata-db');
const { addPgOptions, initPgPool, ensureSchema } = require('../../../libs/pg-utils');

/** `id` keeps the mongo store's fileId shape: 24 hex chars, unguessable. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS file_store (
    id text PRIMARY KEY,
    category text,
    owner text,
    content_type text,
    created_at timestamptz,
    status boolean
  );
  ALTER TABLE file_store ADD COLUMN IF NOT EXISTS md5 text;
  CREATE INDEX IF NOT EXISTS file_store_md5 ON file_store (md5) WHERE md5 IS NOT NULL;
  ALTER TABLE file_store ADD COLUMN IF NOT EXISTS last_shared_at timestamptz;
  ALTER TABLE file_store ADD COLUMN IF NOT EXISTS expiring boolean;
  CREATE INDEX IF NOT EXISTS file_store_last_shared ON file_store (category, last_shared_at);
`;

const RECORD = `id AS "_id", category, owner, content_type AS "contentType",
  created_at AS "createdAt", status, md5, last_shared_at AS "lastSharedAt"`;

class PgFileStore extends IMediaMetadataDB {
  /** @type {import('pg').Pool} */
  #pool;

  constructor(context) {
    super(context);
    this.#pool = initPgPool(context);
  }

  async createRecord(payload) {
    const fileId = crypto.randomBytes(12).toString('hex');
    await this.#pool.query(
      `INSERT INTO file_store (id, category, owner, content_type, created_at, md5, last_shared_at)
       VALUES ($1, $2, $3, $4, $5, $6, $5)`,
      [fileId, payload.category, payload.owner, payload.contentType, new Date(),
        payload.md5 || null]
    );
    return fileId;
  }

  async getRecord(fileId) {
    const { rows } = await this.#pool.query(`SELECT ${RECORD} FROM file_store WHERE id = $1`, [fileId]);
    return rows[0] || null;
  }

  async reuseByMd5(md5, category) {
    const { rows } = await this.#pool.query(
      `UPDATE file_store SET last_shared_at = $3
       WHERE id = (SELECT id FROM file_store
         WHERE md5 = $1 AND category = $2 AND status AND expiring IS NOT TRUE LIMIT 1)
       RETURNING ${RECORD}`,
      [md5, category, new Date()]
    );
    return rows[0] || null;
  }

  async markExpired(category, cutoff, limit) {
    // the outer condition is re-checked on a row a reuse just updated, so a
    // file shared since the inner select is left alone
    const due = '(last_shared_at < $2 OR expiring)';
    const { rows } = await this.#pool.query(
      `UPDATE file_store SET expiring = true
       WHERE id IN (SELECT id FROM file_store WHERE category = $1 AND ${due} LIMIT $3)
         AND ${due}
       RETURNING id AS "_id", category`,
      [category, cutoff, limit]
    );
    return rows;
  }

  async removeRecord(fileId) {
    await this.#pool.query('DELETE FROM file_store WHERE id = $1', [fileId]);
  }

  async updateFileStatus(fileId, status) {
    await this.#pool.query('UPDATE file_store SET status = $2 WHERE id = $1', [fileId, !!status]);
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
  Implementation: PgFileStore
};
