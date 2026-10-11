const { MAX_FRAMES, TTL_SEC } = require('./undelivered-queue');
const { ensureSchema } = require('../pg-utils');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = TTL_SEC * 1000;

/** Partitions exist this many days past today, so no insert waits on the daily job. */
const AHEAD_DAYS = 3;

/** The maintenance job's lock: the two-key space never meets the per-subject locks. */
const MAINTAIN_LOCK = "hashtext('vartalap.undelivered'), 0";

/**
 * `undelivered` is append-only, one partition per UTC day of `at`; nothing
 * ever deletes a row, whole days are dropped past the retention instead. The
 * id sequence must keep its default cache of 1, or ids stop following
 * nextval order across sessions. `undelivered_cursor` is one row per subject,
 * the last id handed out; `last_id` is unindexed and the pages keep 30% free,
 * so each drain's update stays HOT.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS undelivered (
    id bigserial,
    subject text NOT NULL,
    frame bytea NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  ) PARTITION BY RANGE (at);
  CREATE INDEX IF NOT EXISTS undelivered_subject_id ON undelivered (subject, id);
  CREATE TABLE IF NOT EXISTS undelivered_cursor (
    subject text PRIMARY KEY,
    last_id bigint NOT NULL
  ) WITH (fillfactor = 70);
`;

/**
 * Lock, then draw the id, then commit, all in one statement: the lock is held
 * from before `nextval` until the commit, so a subject's ids commit in order
 * and a drain (same lock) never sees a higher id while a lower one is in flight.
 */
const ENQUEUE = `
  WITH locked AS (SELECT pg_advisory_xact_lock(hashtext($1)))
  INSERT INTO undelivered (subject, frame) SELECT $1, $2 FROM locked`;

/**
 * Everything past the cursor, capped to the newest `$2`, and the cursor moved
 * to the newest id read. Whatever the cap skipped is past the cursor's
 * reach for good: drop-oldest, as the mongo queue does at enqueue.
 */
const DRAIN = `
  WITH batch AS (
    SELECT id, frame FROM undelivered
    WHERE subject = $1
      AND id > COALESCE((SELECT last_id FROM undelivered_cursor WHERE subject = $1), 0)
    ORDER BY id DESC
    LIMIT $2
  ), advanced AS (
    INSERT INTO undelivered_cursor (subject, last_id)
    SELECT $1, max(id) FROM batch HAVING count(*) > 0
    ON CONFLICT (subject) DO UPDATE SET last_id = EXCLUDED.last_id
  )
  SELECT frame FROM batch ORDER BY id`;

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
 * The undelivered queue of SYNC_PROTOCOL.md §10.6 on postgres (DECISIONS row
 * 129): the same surface and drain semantics as the mongo `UndeliveredQueue`,
 * as an append-only log read through a per-subject cursor.
 */
class PgUndeliveredQueue {
  /** @type {import('pg').Pool} */
  #pool;

  #maxFrames;

  #log;

  /** @type {NodeJS.Timeout} */
  #timer;

  /**
   * @param {{pool: import('pg').Pool, maxFrames?: number, log?: {error: Function}}} options
   */
  constructor({ pool, maxFrames = MAX_FRAMES, log }) {
    this.#pool = pool;
    this.#maxFrames = maxFrames;
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
   * then drop, so enqueues and drains never wait on it). Every process runs
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
   * Append one push frame for a `user_id:device_id` subject. The cap is
   * applied when the queue is read.
   * @param {string} subject
   * @param {Buffer} frame serialized WsEnvelope{type: WS_PUSH}
   */
  async enqueue(subject, frame) {
    try {
      await this.#pool.query(ENQUEUE, [subject, frame]);
    } catch (error) {
      // 23514: no partition holds `now()`. The daily job is behind or the
      // clock jumped; make the partitions and insert once more.
      if (error.code !== '23514') throw error;
      await this.maintain();
      await this.#pool.query(ENQUEUE, [subject, frame]);
    }
  }

  /**
   * Hand back everything queued for a subject since its last drain, in
   * enqueue order, and move the cursor past it in the same transaction:
   * at-most-once, as the mongo queue. Drains of one subject queue on its lock,
   * so two never return the same frame, and a frame enqueued meanwhile waits
   * for the next drain.
   * @param {string} subject
   * @returns {Promise<Buffer[]>}
   */
  async drain(subject) {
    const client = await this.#pool.connect();
    try {
      // READ COMMITTED: the drain's snapshot is taken after the lock is granted
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [subject]);
      const { rows } = await client.query(DRAIN, [subject, this.#maxFrames]);
      await client.query('COMMIT');
      client.release();
      return rows.map((row) => row.frame);
    } catch (error) {
      // dropping the connection rolls back the transaction and its lock
      client.release(error);
      throw error;
    }
  }

  async dispose() {
    clearInterval(this.#timer);
    await this.#pool.end();
  }
}

module.exports = {
  PgUndeliveredQueue,
  ENQUEUE,
  partitionName
};
