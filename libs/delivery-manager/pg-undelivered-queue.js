const { TTL_SEC, PAGE } = require('./undelivered-queue');
const { ensureSchema } = require('../pg-utils');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = TTL_SEC * 1000;

/** Partitions exist this many days past today, so no insert waits on the daily job. */
const AHEAD_DAYS = 3;

/** The maintenance job's lock. */
const MAINTAIN_LOCK = "hashtext('vartalap.undelivered'), 0";

/**
 * `undelivered` is the timeline, append-only, one partition per UTC day of
 * `at`: nothing ever deletes a row, whole days are dropped past the 30-day
 * maximum instead, and reads leave out rows past their own `expires_at`. One
 * row per fanout, its readers in `recipients`.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS undelivered (
    ts bigint NOT NULL,
    op_id text NOT NULL,
    recipients text[] NOT NULL,
    sender text NOT NULL,
    sender_device text NOT NULL,
    frame bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  ) PARTITION BY RANGE (at);
  CREATE INDEX IF NOT EXISTS undelivered_recipients ON undelivered USING gin (recipients);
  CREATE INDEX IF NOT EXISTS undelivered_ts ON undelivered (ts, op_id);
  CREATE INDEX IF NOT EXISTS undelivered_op ON undelivered (op_id);
`;

/**
 * Once per op_id, as the mongo one: a unique index on a partitioned table must
 * include `at`, so the check is a lookup. Fanouts run one at a time, so two
 * never race it.
 */
const APPEND = `
  INSERT INTO undelivered (ts, op_id, recipients, sender, sender_device, frame, expires_at)
  SELECT $1, $2, $3, $4, $5, $6, $7
  WHERE NOT EXISTS (SELECT 1 FROM undelivered WHERE op_id = $2)`;

/** A page plus one (`$4`), to tell whether more wait past it. */
const PENDING = `
  SELECT frame FROM undelivered
  WHERE recipients @> ARRAY[$1]::text[] AND ts >= $2 AND expires_at > now()
    AND NOT (sender = $1 AND sender_device = $3)
  ORDER BY ts, op_id LIMIT $4`;

/** Every day partition, attached or left behind by a run that died mid-drop. */
const PARTITIONS = `
  SELECT c.relname AS name, i.inhrelid IS NOT NULL AS attached, i.inhdetachpending AS pending
  FROM pg_class c LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
  WHERE c.relkind = 'r' AND c.relname ~ '^undelivered_[0-9]{8}$'
    AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'undelivered'::regclass)`;

/** `undelivered_20261011` for the UTC day starting at `dayMs`. */
const partitionName = (dayMs) =>
  `undelivered_${new Date(dayMs).toISOString().slice(0, 10).replace(/-/g, '')}`;

/** The UTC day start a partition name stands for. */
const partitionDay = (name) =>
  Date.parse(name.replace(/^undelivered_(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3T00:00:00Z'));

const bound = (ms) => `'${new Date(ms).toISOString()}'`;

/**
 * The timeline of SYNC_PROTOCOL.md §10.6 on postgres (DECISIONS row 129): the
 * same surface and semantics as the mongo `UndeliveredQueue`.
 */
class PgUndeliveredQueue {
  /** @type {import('pg').Pool} */
  #pool;

  #log;

  /** @type {NodeJS.Timeout} */
  #timer;

  /**
   * @param {{pool: import('pg').Pool, log?: {error: Function}}} options
   */
  constructor({ pool, log }) {
    this.#pool = pool;
    this.#log = log;
  }

  /** Tables, today's partitions, and the daily job. `init` runs it at boot. */
  async init() {
    await ensureSchema(this.#pool, SCHEMA);
    await this.maintain();
    this.#timer = setInterval(() => {
      this.maintain().catch((error) =>
        this.#log?.error(`undelivered partition job failed: ${error.message}`));
    }, DAY_MS);
    this.#timer.unref();
  }

  /**
   * Create the partitions for `now`'s day and the next `AHEAD_DAYS`, and drop
   * every day that ended more than the retention ago (detach concurrently,
   * then drop, so enqueues and pulls never wait on it). Every process runs
   * it; the session lock queues them, and whoever comes second finds it done.
   * @param {Date} [now]
   */
  async maintain(now = new Date()) {
    const client = await this.#pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(${MAINTAIN_LOCK})`);
      const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
      const days = Array.from({ length: AHEAD_DAYS + 1 }, (_, n) => today + n * DAY_MS);
      await client.query(days.map((day) => `
        CREATE TABLE IF NOT EXISTS ${partitionName(day)} PARTITION OF undelivered
        FOR VALUES FROM (${bound(day)}) TO (${bound(day + DAY_MS)})`).join(';'));

      const { rows } = await client.query(PARTITIONS);
      const expired = rows.filter(({ name }) =>
        partitionDay(name) + DAY_MS <= now.getTime() - RETENTION_MS);
      // DETACH ... CONCURRENTLY refuses a transaction block: one statement each
      // eslint-disable-next-line no-restricted-syntax
      for (const { name, attached, pending } of expired) {
        if (attached) {
          // eslint-disable-next-line no-await-in-loop
          await client.query(`ALTER TABLE undelivered DETACH PARTITION ${name} ${
            pending ? 'FINALIZE' : 'CONCURRENTLY'
          }`);
        }
        // eslint-disable-next-line no-await-in-loop
        await client.query(`DROP TABLE IF EXISTS ${name}`);
      }
    } finally {
      // closing the session releases its advisory lock, whatever happened above
      client.release(true);
    }
  }

  /**
   * Store one fanout (see the mongo `append`).
   * @param {{opId: string, ts: number, expiresAt: Date, recipients: string[],
   *   sender: string, senderDevice: string, frame: Buffer}} entry
   */
  async append({ opId, ts, expiresAt, recipients, sender, senderDevice, frame }) {
    const values = [ts, opId, recipients, sender, senderDevice, frame, expiresAt];
    try {
      await this.#pool.query(APPEND, values);
    } catch (error) {
      // 23514: no partition holds `now()`. The daily job is behind or the
      // clock jumped; make the partitions and insert once more.
      if (error.code !== '23514') throw error;
      await this.maintain();
      await this.#pool.query(APPEND, values);
    }
  }

  /**
   * A page of `userId`'s timeline from `since` on (see the mongo `pending`).
   * @param {string} userId
   * @param {string} deviceId
   * @param {number} [since]
   * @param {number} [limit]
   * @returns {Promise<{frames: Buffer[], more: boolean}>}
   */
  async pending(userId, deviceId, since = 0, limit = PAGE) {
    const { rows } = await this.#pool.query(PENDING, [userId, since, deviceId, limit + 1]);
    return { frames: rows.slice(0, limit).map((row) => row.frame), more: rows.length > limit };
  }

  async dispose() {
    clearInterval(this.#timer);
    await this.#pool.end();
  }
}

module.exports = {
  PgUndeliveredQueue,
  APPEND,
  partitionName
};
