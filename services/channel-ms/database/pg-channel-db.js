const { IChannelDB } = require('./channel-db');
const {
  addPgOptions,
  initPgPool,
  ensureSchema,
  assignments
} = require('../../../libs/pg-utils');

/**
 * Members are their own table, keyed (channel, user), tombstoned by
 * `removed_at` exactly as the mongo array rows are. `pos` keeps the array's
 * push order: a revived member moves to the end, as mongo's pull-then-push does.
 * Times are ms since epoch, as channel-ms writes them.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS channels (
    channel_id text PRIMARY KEY,
    kind text,
    name text,
    avatar_url text,
    owner text,
    created_at bigint,
    updated_at bigint
  );
  -- who set avatar_url: only their own upload is deleted when it is replaced
  ALTER TABLE channels ADD COLUMN IF NOT EXISTS avatar_by text;
  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id text NOT NULL REFERENCES channels ON DELETE CASCADE,
    user_id text NOT NULL,
    role text,
    joined_at bigint,
    removed_at bigint,
    pos bigserial,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS channel_members_live_user
    ON channel_members (user_id) WHERE removed_at IS NULL;
  CREATE TABLE IF NOT EXISTS invites (
    channel_id text NOT NULL,
    to_user text NOT NULL,
    from_user text NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (channel_id, to_user)
  );
  CREATE INDEX IF NOT EXISTS invites_to ON invites (to_user);
  CREATE INDEX IF NOT EXISTS invites_from ON invites (from_user);
  CREATE TABLE IF NOT EXISTS connections (
    a text NOT NULL,
    b text NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (a, b)
  );
  CREATE INDEX IF NOT EXISTS connections_b ON connections (b);
  CREATE TABLE IF NOT EXISTS blocks (
    blocker text NOT NULL,
    blocked text NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (blocker, blocked)
  );
  CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks (blocked);
  CREATE TABLE IF NOT EXISTS reports (
    id bigserial PRIMARY KEY,
    reporter text NOT NULL,
    reported text NOT NULL,
    messages jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS reports_created ON reports (created_at);
`;

/** An invite row under the mongo field names. */
const INVITE = `SELECT channel_id AS "channelId", to_user AS "to", from_user AS "from",
  created_at AS "createdAt" FROM invites`;

/** The pair's key, low id first. */
const pairOf = (a, b) => (a < b ? [a, b] : [b, a]);

/** The fields `updateChannel` may set. */
const EDITABLE = ['name', 'avatarUrl', 'avatarBy', 'updatedAt'];

/** A channel as the mongo store returns it: only the live roster, in push order. */
const CHANNEL = `
  SELECT c.channel_id AS "channelId", c.kind, c.name, c.avatar_url AS "avatarUrl",
    c.avatar_by AS "avatarBy", c.owner,
    (SELECT COALESCE(json_agg(json_build_object(
        'user_id', m.user_id, 'role', m.role, 'joinedAt', m.joined_at, 'removedAt', m.removed_at
      ) ORDER BY m.pos), '[]')
     FROM channel_members m WHERE m.channel_id = c.channel_id AND m.removed_at IS NULL) AS members,
    c.created_at AS "createdAt"
  FROM channels c`;

/** `$n` names a user who must be a live member. */
const LIVE_MEMBER = (n) => `EXISTS (SELECT 1 FROM channel_members m
  WHERE m.channel_id = c.channel_id AND m.user_id = $${n} AND m.removed_at IS NULL)`;

/** `($2, $3, $4, $5, $6), ...` rows of (channel, user, role, joinedAt, removedAt) after `$1`. */
function memberRows(channelId, members) {
  const params = [channelId];
  const rows = members.map((member) => {
    params.push(member.user_id, member.role, member.joinedAt, member.removedAt);
    const n = params.length;
    return `($1, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
  });
  return { values: rows.join(', '), params };
}

class PgChannelDB extends IChannelDB {
  /** @type {import('pg').Pool} */
  #pool;

  constructor(context) {
    super(context);
    this.#pool = initPgPool(context);
  }

  async getMemberChannels(memberId) {
    // `kind = 'group'` is what leaves any pre-trim-4 DM row unread.
    const { rows } = await this.#pool.query(
      `${CHANNEL} WHERE c.kind = 'group' AND ${LIVE_MEMBER(1)} ORDER BY c.created_at, c.channel_id`,
      [memberId]
    );
    return rows;
  }

  async create(channel) {
    const { values, params } = memberRows(channel.channelId, channel.members);
    const first = params.length + 1;
    try {
      await this.#pool.query(
        `WITH created AS (
           INSERT INTO channels (channel_id, kind, name, avatar_url, avatar_by, owner, created_at)
           VALUES ($1, $${first}, $${first + 1}, $${first + 2}, $${first + 3}, $${first + 4},
             $${first + 5})
         )
         INSERT INTO channel_members (channel_id, user_id, role, joined_at, removed_at)
         VALUES ${values}`,
        [
          ...params,
          channel.kind,
          channel.name,
          channel.avatarUrl,
          channel.avatarBy,
          channel.owner,
          channel.createdAt
        ]
      );
    } catch (error) {
      // the channel's key or, first, its creator's member row: either way the id is taken
      if (error.code === '23505') {
        const taken = new Error(`channel ${channel.channelId} already exists`);
        taken.code = 'CHANNEL_EXISTS';
        throw taken;
      }
      throw error;
    }
    return this.getChannelInfo(channel.channelId);
  }

  async getChannelInfo(channelId, memberId = null) {
    const { rows } = await this.#pool.query(
      `${CHANNEL} WHERE c.channel_id = $1${memberId ? ` AND ${LIVE_MEMBER(2)}` : ''}`,
      memberId ? [channelId, memberId] : [channelId]
    );
    return rows[0] || null;
  }

  async addMembers(channelId, members) {
    // one statement: a removed member's row is revived in place, and moves to
    // the end of the roster like mongo's pull-then-push.
    const { values, params } = memberRows(channelId, members);
    await this.#pool.query(
      `INSERT INTO channel_members (channel_id, user_id, role, joined_at, removed_at)
       VALUES ${values}
       ON CONFLICT (channel_id, user_id) DO UPDATE SET
         role = EXCLUDED.role, joined_at = EXCLUDED.joined_at,
         removed_at = EXCLUDED.removed_at, pos = EXCLUDED.pos`,
      params
    );
  }

  async removeMember(channelId, userId, at) {
    await this.#pool.query(
      'UPDATE channel_members SET removed_at = $3 WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId, at]
    );
  }

  async setMemberRole(channelId, userId, role) {
    // `owner` is denormalised on the channel, so succession has to move it too.
    await this.#pool.query(
      `WITH member AS (
         UPDATE channel_members SET role = $3 WHERE channel_id = $1 AND user_id = $2 RETURNING 1
       )
       UPDATE channels SET owner = $2
       WHERE channel_id = $1 AND $3 = 'owner' AND EXISTS (SELECT 1 FROM member)`,
      [channelId, userId, role]
    );
  }

  async updateChannel(channelId, updates) {
    const values = { ...updates, updatedAt: Date.now() };
    await this.#pool.query(
      `UPDATE channels SET ${assignments(EDITABLE, values, 2)} WHERE channel_id = $1`,
      [channelId, ...Object.values(values)]
    );
    return this.getChannelInfo(channelId);
  }

  async deleteChannel(channelId) {
    // the member rows go with it (ON DELETE CASCADE), its invites by hand
    await this.#pool.query(
      `WITH i AS (DELETE FROM invites WHERE channel_id = $1)
       DELETE FROM channels WHERE channel_id = $1`,
      [channelId]
    );
  }

  async addInvite(invite) {
    const { rowCount } = await this.#pool.query(
      `INSERT INTO invites (channel_id, to_user, from_user, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [invite.channelId, invite.to, invite.from, invite.createdAt]
    );
    return rowCount === 1;
  }

  async getInvite(channelId, to) {
    const { rows } = await this.#pool.query(
      `${INVITE} WHERE channel_id = $1 AND to_user = $2`, [channelId, to]
    );
    return rows[0] || null;
  }

  async deleteInvite(channelId, to) {
    const { rowCount } = await this.#pool.query(
      'DELETE FROM invites WHERE channel_id = $1 AND to_user = $2', [channelId, to]
    );
    return rowCount === 1;
  }

  async findInvites(userId, channelIds = []) {
    const { rows } = await this.#pool.query(
      `${INVITE} WHERE from_user = $1 OR to_user = $1 OR channel_id = ANY($2)
       ORDER BY created_at, channel_id, to_user`,
      [userId, channelIds]
    );
    return rows;
  }

  async connect(a, b, at) {
    await this.#pool.query(
      'INSERT INTO connections (a, b, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [...pairOf(a, b), at]
    );
  }

  async connectionsOf(userId) {
    const { rows } = await this.#pool.query(
      `SELECT b AS id FROM connections WHERE a = $1
       UNION ALL SELECT a FROM connections WHERE b = $1`,
      [userId]
    );
    return rows.map((row) => row.id);
  }

  async anyConnection() {
    const { rows } = await this.#pool.query('SELECT 1 FROM connections LIMIT 1');
    return rows.length > 0;
  }

  async setBlocked(blocker, blocked, on) {
    await this.#pool.query(
      on
        ? `INSERT INTO blocks (blocker, blocked, created_at) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`
        : 'DELETE FROM blocks WHERE blocker = $1 AND blocked = $2',
      on ? [blocker, blocked, Date.now()] : [blocker, blocked]
    );
  }

  async blockedBy(blocker) {
    const { rows } = await this.#pool.query(
      'SELECT blocked FROM blocks WHERE blocker = $1 ORDER BY created_at', [blocker]
    );
    return rows.map((row) => row.blocked);
  }

  async pair(a, b) {
    const [low, high] = pairOf(a, b);
    const { rows } = await this.#pool.query(
      `SELECT
         EXISTS (SELECT 1 FROM connections WHERE a = $3 AND b = $4) AS connected,
         EXISTS (SELECT 1 FROM blocks WHERE blocker = $1 AND blocked = $2) AS "aBlockedB",
         EXISTS (SELECT 1 FROM blocks WHERE blocker = $2 AND blocked = $1) AS "bBlockedA",
         EXISTS (SELECT 1 FROM channels c WHERE c.kind = 'group'
           AND ${LIVE_MEMBER(1)} AND ${LIVE_MEMBER(2)}) AS "shareGroup"`,
      [a, b, low, high]
    );
    return rows[0];
  }

  async forget(userId) {
    await this.#pool.query(
      `WITH i AS (DELETE FROM invites WHERE from_user = $1 OR to_user = $1),
       c AS (DELETE FROM connections WHERE a = $1 OR b = $1)
       DELETE FROM blocks WHERE blocker = $1 OR blocked = $1`,
      [userId]
    );
  }

  async addReport(report) {
    await this.#pool.query(
      'INSERT INTO reports (reporter, reported, messages) VALUES ($1, $2, $3)',
      [report.reporter, report.reported, JSON.stringify(report.messages)]
    );
  }

  async purgeReports(before) {
    await this.#pool.query('DELETE FROM reports WHERE created_at < $1', [before]);
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
  Implementation: PgChannelDB
};
