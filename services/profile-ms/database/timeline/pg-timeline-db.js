const { initPgPool, ensureSchema } = require('../../../../libs/pg-utils');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS timeline_posts (
    post_id uuid PRIMARY KEY,
    author text NOT NULL,
    text text,
    photos jsonb NOT NULL,
    audience text[] NOT NULL,
    reactions jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS timeline_posts_audience ON timeline_posts USING gin (audience);
  CREATE INDEX IF NOT EXISTS timeline_posts_author ON timeline_posts (author, created_at DESC, post_id DESC);
  CREATE INDEX IF NOT EXISTS timeline_posts_created ON timeline_posts (created_at);
`;

const POST = `post_id::text AS "postId", author, text, photos, audience, reactions,
  created_at AS "createdAt"`;

class PgTimelineDB {
  /** @type {import('pg').Pool} */
  #pool;

  constructor(context) {
    this.#pool = initPgPool(context);
  }

  async init() {
    await ensureSchema(this.#pool, SCHEMA);
  }

  async insertPost({ postId, author, text, photos, audience, createdAt }) {
    const { rowCount } = await this.#pool.query(
      `INSERT INTO timeline_posts (post_id, author, text, photos, audience, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (post_id) DO NOTHING`,
      [postId, author, text, JSON.stringify(photos), audience, createdAt]
    );
    return rowCount === 1;
  }

  async getPost(postId) {
    const { rows } = await this.#pool.query(
      `SELECT ${POST} FROM timeline_posts WHERE post_id = $1`,
      [postId]
    );
    return rows[0] || null;
  }

  /** Newest first, from after `before` on; `where` takes $1. */
  async #list(where, value, before, limit) {
    const params = [value, limit];
    let after = '';
    if (before) {
      params.push(before.createdAt, before.postId);
      after = 'AND (created_at, post_id) < ($3, $4)';
    }
    const { rows } = await this.#pool.query(
      `SELECT ${POST} FROM timeline_posts WHERE ${where} ${after}
       ORDER BY created_at DESC, post_id DESC LIMIT $2`,
      params
    );
    return rows;
  }

  feed(userId, before, limit) {
    return this.#list('audience @> ARRAY[$1::text]', userId, before, limit);
  }

  postsBy(author, before, limit) {
    return this.#list('author = $1', author, before, limit);
  }

  async deletePost(postId, author) {
    const { rows } = await this.#pool.query(
      `DELETE FROM timeline_posts WHERE post_id = $1 AND author = $2 RETURNING ${POST}`,
      [postId, author]
    );
    return rows[0] || null;
  }

  async setReaction(postId, userId, emoji, at) {
    const { rowCount } = await this.#pool.query(
      emoji
        ? `UPDATE timeline_posts SET reactions = reactions || jsonb_build_object($2::text,
             jsonb_build_object('emoji', $3::text, 'at', $4::bigint))
           WHERE post_id = $1 AND audience @> ARRAY[$2::text]`
        : `UPDATE timeline_posts SET reactions = reactions - $2::text
           WHERE post_id = $1 AND audience @> ARRAY[$2::text]`,
      emoji ? [postId, userId, emoji, at] : [postId, userId]
    );
    return rowCount === 1;
  }

  async takeExpired(cutoff, limit) {
    const { rows } = await this.#pool.query(
      `DELETE FROM timeline_posts WHERE post_id IN (
         SELECT post_id FROM timeline_posts WHERE created_at < $1 LIMIT $2)
       RETURNING ${POST}`,
      [cutoff, limit]
    );
    return rows;
  }

  async deleteAllBy(author) {
    const { rows } = await this.#pool.query(
      `DELETE FROM timeline_posts WHERE author = $1 RETURNING ${POST}`,
      [author]
    );
    return rows;
  }

  async dispose() {
    await this.#pool.end();
  }
}

module.exports = { code: 'pg', Implementation: PgTimelineDB };
