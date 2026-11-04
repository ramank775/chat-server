const { TTL_SEC, PAGE, userNumber } = require('./undelivered-queue');
const { ensureSchema } = require('../pg-utils');
const { isUuid } = require('../v3-envelope');

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
 * row per fanout, its readers in `recipients`, the wire Envelope in
 * `envelope`. Ids in their binary types (decision 218): user ids as the
 * 36-bit number, the others as uuid. `sender`/`sender_device` are null when
 * no user/device sent it (a server event).
 * The three indexes are the three lookups: a reader's rows (gin), their
 * order (ts, op_id), and the once-per-op_id check on append.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS undelivered (
    ts bigint NOT NULL,
    op_id uuid NOT NULL,
    recipients bigint[] NOT NULL,
    sender bigint,
    sender_device uuid,
    envelope bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  ) PARTITION BY RANGE (at);
  CREATE INDEX IF NOT EXISTS undelivered_recipients ON undelivered USING gin (recipients);
  CREATE INDEX IF NOT EXISTS undelivered_ts ON undelivered (ts, op_id);
  CREATE INDEX IF NOT EXISTS undelivered_op ON undelivered (op_id);
`;

/**
 * Decision 218: the text-id timeline of before goes, partitions and all.
 * It only ever held test data, and every frame in it is in the old wire.
 */
const DROP_OLD_SHAPE = `
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'undelivered'
        AND column_name = 'op_id' AND data_type = 'text') THEN
      DROP TABLE undelivered;
    END IF;
  END $$;
`;

/**
 * Once per op_id, as the mongo one: a unique index on a partitioned table must
 * include `at`, so the check is a lookup. Fanouts run one at a time, so two
 * never race it.
 */
const APPEND = `
  INSERT INTO undelivered (ts, op_id, recipients, sender, sender_device, envelope, expires_at)
  SELECT $1, $2::uuid, $3::bigint[], $4::bigint, $5::uuid, $6, $7
  WHERE NOT EXISTS (SELECT 1 FROM undelivered WHERE op_id = $2::uuid)`;

/** A page plus one (`$4`), to tell whether more wait past it. */
const PENDING = `
  SELECT envelope FROM undelivered
  WHERE recipients @> ARRAY[$1::bigint] AND ts >= $2 AND expires_at > now()
    AND (sender IS DISTINCT FROM $1 OR sender_device IS DISTINCT FROM $3::uuid)
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
    await ensureSchema(this.#pool, DROP_OLD_SHAPE + SCHEMA);
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
   *   sender: string, senderDevice: string, envelope: Buffer}} entry
   */
  async append({ opId, ts, expiresAt, recipients, sender, senderDevice, envelope }) {
    const values = [
      ts, opId, recipients.map(userNumber), sender ? userNumber(sender) : null,
      senderDevice || null, envelope, expiresAt
    ];
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
   * @returns {Promise<{envelopes: Buffer[], more: boolean}>}
   */
  async pending(userId, deviceId, since = 0, limit = PAGE) {
    // a device id that is no UUID never sent anything: nothing to leave out
    const device = isUuid(deviceId) ? deviceId : null;
    const { rows } = await this.#pool.query(PENDING, [userNumber(userId), since, device, limit + 1]);
    return {
      envelopes: rows.slice(0, limit).map((row) => row.envelope),
      more: rows.length > limit
    };
  }

  async dispose() {
    clearInterval(this.#timer);
    await this.#pool.end();
  }
}

module.exports = {
  PgUndeliveredQueue,
  partitionName
};
