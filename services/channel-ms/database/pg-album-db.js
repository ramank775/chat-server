const { initPgPool, ensureSchema } = require('../../../libs/pg-utils');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS albums (
    album_id uuid PRIMARY KEY,
    channel_id text NOT NULL,
    members text[],
    creator text NOT NULL,
    title text NOT NULL,
    date text,
    created_at timestamptz NOT NULL,
    kept_until timestamptz,
    photos jsonb NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS albums_channel ON albums (channel_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS albums_kept_until ON albums (kept_until);
  CREATE INDEX IF NOT EXISTS albums_members ON albums USING gin (members);
  CREATE INDEX IF NOT EXISTS albums_photos ON albums USING gin (photos jsonb_path_ops);
`;

const HEAD = `album_id::text AS "albumId", channel_id AS "channelId", members, creator,
  title, date, created_at AS "createdAt", kept_until AS "keptUntil"`;
const ALBUM = `${HEAD}, photos`;

/** `photos` without the ones `keep` (a condition on `p`) leaves out, in order. */
const photosWhere = (keep) => `COALESCE((
  SELECT jsonb_agg(p ORDER BY n) FROM jsonb_array_elements(photos) WITH ORDINALITY AS t(p, n)
  WHERE ${keep}), '[]'::jsonb)`;

/** Occasion albums (decision 233), photos inside their album; see index.js. */
class PgAlbumDB {
  /** @type {import('pg').Pool} */
  #pool;

  constructor(context) {
    this.#pool = initPgPool(context);
  }

  async init() {
    await ensureSchema(this.#pool, SCHEMA);
  }

  async #rows(sql, params) {
    return (await this.#pool.query(sql, params)).rows;
  }

  async insertAlbum(album) {
    const { rowCount } = await this.#pool.query(
      `INSERT INTO albums (album_id, channel_id, members, creator, title, date, created_at,
         kept_until, photos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (album_id) DO NOTHING`,
      [album.albumId, album.channelId, album.members, album.creator, album.title, album.date,
        album.createdAt, album.keptUntil, JSON.stringify(album.photos)]
    );
    return rowCount === 1;
  }

  async getAlbum(albumId) {
    return (await this.#rows(`SELECT ${ALBUM} FROM albums WHERE album_id = $1`, [albumId]))[0]
      || null;
  }

  listAlbums(channelId, now) {
    return this.#rows(
      `SELECT ${HEAD}, jsonb_array_length(photos) AS "photoCount", photos->-1 AS cover
       FROM albums WHERE channel_id = $1 AND (kept_until IS NULL OR kept_until > $2)
       ORDER BY created_at DESC, album_id DESC`,
      [channelId, now]
    );
  }

  async countAlbums(channelId) {
    const [{ n }] = await this.#rows(
      'SELECT count(*)::int AS n FROM albums WHERE channel_id = $1', [channelId]
    );
    return n;
  }

  async updateAlbum(albumId, changes) {
    // the keys are the route's own (title, date), never the caller's
    const keys = Object.keys(changes);
    const sets = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
    return (await this.#rows(
      `UPDATE albums SET ${sets} WHERE album_id = $1 RETURNING ${ALBUM}`,
      [albumId, ...keys.map((key) => changes[key])]
    ))[0] || null;
  }

  async deleteAlbum(albumId) {
    return (await this.#rows(`DELETE FROM albums WHERE album_id = $1 RETURNING ${ALBUM}`,
      [albumId]))[0] || null;
  }

  async addPhotos(albumId, photos, max) {
    const { rowCount } = await this.#pool.query(
      `UPDATE albums SET photos = photos || $2::jsonb
       WHERE album_id = $1 AND jsonb_array_length(photos) + $3 <= $4`,
      [albumId, JSON.stringify(photos), photos.length, max]
    );
    return rowCount === 1;
  }

  async removePhoto(albumId, fileId) {
    await this.#pool.query(
      `UPDATE albums SET photos = ${photosWhere("p->>'fileId' <> $2")} WHERE album_id = $1`,
      [albumId, fileId]
    );
  }

  takeExpired(now, limit) {
    return this.#rows(
      `DELETE FROM albums WHERE album_id IN (
         SELECT album_id FROM albums WHERE kept_until < $1 LIMIT $2)
       RETURNING ${ALBUM}`,
      [now, limit]
    );
  }

  takeChat(channelId) {
    return this.#rows(`DELETE FROM albums WHERE channel_id = $1 RETURNING ${ALBUM}`, [channelId]);
  }

  takeMember(userId) {
    return this.#rows(
      `DELETE FROM albums WHERE members @> ARRAY[$1::text] RETURNING ${ALBUM}`, [userId]
    );
  }

  async takePhotosBy(uploader) {
    const has = JSON.stringify([{ uploader }]);
    const rows = await this.#rows('SELECT photos FROM albums WHERE photos @> $1::jsonb', [has]);
    if (!rows.length) return [];
    await this.#pool.query(
      `UPDATE albums SET photos = ${photosWhere("p->>'uploader' <> $2")}
       WHERE photos @> $1::jsonb`,
      [has, uploader]
    );
    return rows.flatMap((row) => row.photos.filter((p) => p.uploader === uploader));
  }

  async dispose() {
    await this.#pool.end();
  }
}

module.exports = { code: 'pg', Implementation: PgAlbumDB };
