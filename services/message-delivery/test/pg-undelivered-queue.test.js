const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { TTL_SEC } = require('../../../libs/delivery-manager/undelivered-queue');
const { partitionName } = require('../../../libs/delivery-manager/pg-undelivered-queue');
const { initPgPool } = require('../../../libs/pg-utils');
const { TEST_DB, pgUrlFor } = require('../../../test/helpers/db');
const { emptyQueue, reopenQueue, closeQueues } = require('./helper');

const DB = 'pg-undelivered-queue-test';
const DAY_MS = 24 * 60 * 60 * 1000;
const ALICE = '00000000b';

const range = (n) => Array.from({ length: n }, (_, index) => index);
const dayOf = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

/** DECISIONS row 129: the append-only, day-partitioned timeline. `TEST_DB=pg` only. */
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

  const entry = (opId, ts, recipients) => ({
    opId,
    ts,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    recipients,
    sender: '00000000a',
    senderDevice: 'd1',
    frame: Buffer.from(opId)
  });

  test('one row per fanout, and a read deletes nothing', async () => {
    const queue = await emptyQueue(DB);
    await queue.append(entry('group', 1, ['00000000b', '00000000c', '00000000d']));
    await queue.append(entry('dm', 2, ['00000000b', '00000000a']));

    assert.deepStrictEqual((await queue.pending('00000000b', 'd1', 2)).frames.map(String), ['dm']);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM undelivered');
    assert.strictEqual(rows[0].n, 2);
  });

  test('retention drops the days older than thirty, concurrently and idempotently', async () => {
    const queue = await emptyQueue(DB);
    const old = new Date(Date.now() - (TTL_SEC * 1000 + 10 * DAY_MS));
    await queue.maintain(old);
    await pool.query(
      `INSERT INTO undelivered (ts, op_id, recipients, sender, sender_device, frame, expires_at, at)
       VALUES (1, 'stale', $1, '', '', $2, $3, $3)`,
      [[ALICE], Buffer.from('stale'), old]
    );
    await queue.append(entry('fresh', 2, [ALICE]));
    assert.ok((await partitions()).includes(partitionName(dayOf(old.getTime()))));

    // every process runs the job: three at once, on connections of their own
    const others = range(3).map(() => reopenQueue(DB));
    await Promise.all(others.map((other) => other.maintain()));
    await Promise.all(others.map((other) => other.dispose()));

    const day = dayOf(Date.now());
    assert.deepStrictEqual(await partitions(), range(4).map((n) => partitionName(day + n * DAY_MS)));
    assert.deepStrictEqual((await queue.pending(ALICE, 'd2')).frames.map(String), ['fresh']);
  });

  test('a store never fails for want of a partition', async () => {
    const queue = await emptyQueue(DB);
    const name = partitionName(dayOf(Date.now()));
    await pool.query(`ALTER TABLE undelivered DETACH PARTITION ${name}; DROP TABLE ${name}`);

    await queue.append(entry('after the gap', 1, [ALICE]));
    assert.deepStrictEqual((await queue.pending(ALICE, 'd2')).frames.map(String), ['after the gap']);
  });
});
