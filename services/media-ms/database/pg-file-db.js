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
`;

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
      `INSERT INTO file_store (id, category, owner, content_type, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [fileId, payload.category, payload.owner, payload.contentType, new Date()]
    );
    return fileId;
  }

  async getRecord(fileId) {
    const { rows } = await this.#pool.query(
      `SELECT id AS "_id", category, owner, content_type AS "contentType",
         created_at AS "createdAt", status
       FROM file_store WHERE id = $1`,
      [fileId]
    );
    return rows[0] || null;
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
