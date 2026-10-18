const { TTL_SEC, PAGE } = require('./undelivered-queue');
const { ensureSchema } = require('../pg-utils');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = TTL_SEC * 1000;

/** Partitions exist this many days past today, so no insert waits on the daily job. */
const AHEAD_DAYS = 3;

/** The maintenance job's lock. */
const MAINTAIN_LOCK = "hashtext('vartalap.undelivered'), 0";

/**
 * `undelivered` is append-only, one partition per UTC day of `at`: nothing
 * ever deletes a row, whole days are dropped past the retention instead.
 * `seq` is the fanout's offset from `undelivered_seq`, shared by every
 * recipient's row of one fanout (`offset` is a reserved word).
 */
const SCHEMA = `
  CREATE SEQUENCE IF NOT EXISTS undelivered_seq;
  CREATE TABLE IF NOT EXISTS undelivered (
    subject text NOT NULL,
    seq bigint NOT NULL,
    frame bytea NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  ) PARTITION BY RANGE (at);
  CREATE INDEX IF NOT EXISTS undelivered_subject_seq ON undelivered (subject, seq);
`;

const ENQUEUE = 'INSERT INTO undelivered (subject, seq, frame) VALUES ($1, $2, $3)';

/** A page plus one (`$3`), to tell whether more wait past it. */
const PENDING = `
  SELECT frame FROM undelivered WHERE subject = $1 AND seq > $2 ORDER BY seq LIMIT $3`;

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
 * The device logs of SYNC_PROTOCOL.md §10.6 on postgres (DECISIONS row 129):
 * the same surface and semantics as the mongo `UndeliveredQueue`, and the
 * same one-fanout-at-a-time ceiling.
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

  /** The next offset: strictly increasing, one per fanout. */
  async nextOffset() {
    const { rows } = await this.#pool.query("SELECT nextval('undelivered_seq') AS seq");
    return Number(rows[0].seq);
  }

  /**
   * Append one push frame to a subject's log.
   * @param {string} subject
   * @param {number} offset from `nextOffset`, stamped on the frame's envelope
   * @param {Buffer} frame serialized WsEnvelope{type: WS_PUSH}
   */
  async enqueue(subject, offset, frame) {
    try {
      await this.#pool.query(ENQUEUE, [subject, offset, frame]);
    } catch (error) {
      // 23514: no partition holds `now()`. The daily job is behind or the
      // clock jumped; make the partitions and insert once more.
      if (error.code !== '23514') throw error;
      await this.maintain();
      await this.#pool.query(ENQUEUE, [subject, offset, frame]);
    }
  }

  /**
   * The frames in a subject's log past `after`, oldest first, and whether
   * more wait (§10.6). Removes nothing.
   * @param {string} subject
   * @param {number} [after]
   * @param {number} [limit]
   * @returns {Promise<{frames: Buffer[], more: boolean}>}
   */
  async pending(subject, after = 0, limit = PAGE) {
    const { rows } = await this.#pool.query(PENDING, [subject, after, limit + 1]);
    return { frames: rows.slice(0, limit).map((row) => row.frame), more: rows.length > limit };
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
