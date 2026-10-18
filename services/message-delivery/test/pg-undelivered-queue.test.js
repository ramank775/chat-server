const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { TTL_SEC } = require('../../../libs/delivery-manager/undelivered-queue');
const { partitionName } = require('../../../libs/delivery-manager/pg-undelivered-queue');
const { initPgPool } = require('../../../libs/pg-utils');
const { TEST_DB, pgUrlFor } = require('../../../test/helpers/db');
const { emptyQueue, reopenQueue, closeQueues } = require('./helper');

const DB = 'pg-undelivered-queue-test';
const DAY_MS = 24 * 60 * 60 * 1000;
const ALICE_1 = '00000000b:device-1';

const range = (n) => Array.from({ length: n }, (_, index) => index);
const dayOf = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

/** DECISIONS row 129: the append-only, day-partitioned log. `TEST_DB=pg` only. */
describe('pg undelivered queue (DECISIONS row 129)', { skip: TEST_DB !== 'pg' }, () => {
  /** The tests' own connections, for what the queue does not expose. */
  let pool;

  const partitions = async () => (await pool.query(
    "SELECT relname FROM pg_class WHERE relname ~ '^undelivered_[0-9]{8}$' ORDER BY relname"
  )).rows.map((row) => row.relname);

  before(async () => {
    await emptyQueue(DB);
    pool = initPgPool({ options: { pgUrl: pgUrlFor(DB) } });
  });

  after(async () => {
    await pool.end();
    await closeQueues();
  });

  test('nothing deletes a row: a read past the pointer leaves the log as it was', async () => {
    const queue = await emptyQueue(DB);
    const first = await queue.nextOffset();
    await queue.enqueue(ALICE_1, first, Buffer.from('one'));
    await queue.enqueue(ALICE_1, await queue.nextOffset(), Buffer.from('two'));

    assert.deepStrictEqual((await queue.pending(ALICE_1, first)).frames.map(String), ['two']);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM undelivered');
    assert.strictEqual(rows[0].n, 2);
  });

  test('retention drops the days older than thirty, concurrently and idempotently', async () => {
    const queue = await emptyQueue(DB);
    const old = new Date(Date.now() - (TTL_SEC * 1000 + 10 * DAY_MS));
    await queue.maintain(old);
    await pool.query('INSERT INTO undelivered (subject, seq, frame, at) VALUES ($1, $2, $3, $4)', [
      ALICE_1,
      await queue.nextOffset(),
      Buffer.from('stale'),
      old
    ]);
    await queue.enqueue(ALICE_1, await queue.nextOffset(), Buffer.from('fresh'));
    assert.ok((await partitions()).includes(partitionName(dayOf(old.getTime()))));

    // every process runs the job: three at once, on connections of their own
    const others = range(3).map(() => reopenQueue(DB));
    await Promise.all(others.map((other) => other.maintain()));
    await Promise.all(others.map((other) => other.dispose()));

    const day = dayOf(Date.now());
    assert.deepStrictEqual(await partitions(), range(4).map((n) => partitionName(day + n * DAY_MS)));
    assert.deepStrictEqual((await queue.pending(ALICE_1)).frames.map(String), ['fresh']);
  });

  test('an enqueue never fails for want of a partition', async () => {
    const queue = await emptyQueue(DB);
    const name = partitionName(dayOf(Date.now()));
    await pool.query(`ALTER TABLE undelivered DETACH PARTITION ${name}; DROP TABLE ${name}`);

    await queue.enqueue(ALICE_1, await queue.nextOffset(), Buffer.from('after the gap'));
    assert.deepStrictEqual((await queue.pending(ALICE_1)).frames.map(String), ['after the gap']);
  });
});
