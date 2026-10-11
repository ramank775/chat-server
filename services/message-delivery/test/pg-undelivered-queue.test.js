const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { MAX_FRAMES, TTL_SEC } = require('../../../libs/delivery-manager/undelivered-queue');
const { ENQUEUE, partitionName } = require('../../../libs/delivery-manager/pg-undelivered-queue');
const { initPgPool } = require('../../../libs/pg-utils');
const { TEST_DB, pgUrlFor } = require('../../../test/helpers/db');
const { emptyQueue, reopenQueue, closeQueues, eachSeries } = require('./helper');

const DB = 'pg-undelivered-queue-test';
const DAY_MS = 24 * 60 * 60 * 1000;
const ALICE_1 = '00000000b:device-1';

const range = (n) => Array.from({ length: n }, (_, index) => index);
const pause = () => new Promise((resolve) => { setTimeout(resolve, 200); });
const dayOf = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

/** DECISIONS row 129: the append-only, day-partitioned queue. `TEST_DB=pg` only. */
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

  test('a drain never passes an enqueue still in flight', async () => {
    const queue = await emptyQueue(DB);
    // an enqueue that has drawn its id but not committed: it holds the subject's lock
    const inflight = await pool.connect();
    try {
      await inflight.query('BEGIN');
      await inflight.query(ENQUEUE, [ALICE_1, Buffer.from('first')]);
      // without the lock, 'second' commits a higher id right away, the drain
      // moves the cursor past it, and 'first' commits behind the cursor: lost.
      const later = queue.enqueue(ALICE_1, Buffer.from('second'));
      await pause();
      const drained = queue.drain(ALICE_1);
      await pause();
      await inflight.query('COMMIT');
      await later;
      const handedOut = [...(await drained), ...(await queue.drain(ALICE_1))].map(String);
      assert.deepStrictEqual(handedOut, ['first', 'second']);
    } finally {
      inflight.release();
    }
  });

  test('racing enqueues and drains hand out every frame once, in order per subject', async () => {
    const queue = await emptyQueue(DB);
    const subjects = ['00000000b:d1', '00000000c:d1', '00000000d:d1'];
    const PRODUCERS = 4;
    const FRAMES = 60;
    /** subject -> what each drain returned, in the order the drains returned */
    const drains = new Map(subjects.map((subject) => [subject, []]));
    let producing = true;

    const producers = subjects.flatMap((subject) => range(PRODUCERS).map((producer) =>
      eachSeries(range(FRAMES), (n) => queue.enqueue(subject, Buffer.from(`${producer}:${n}`)))));
    const drainers = subjects.flatMap((subject) => range(2).map(async () => {
      while (producing) {
        // eslint-disable-next-line no-await-in-loop
        drains.get(subject).push(await queue.drain(subject));
      }
    }));
    await Promise.all(producers);
    producing = false;
    await Promise.all(drainers);
    await Promise.all(subjects.map(async (subject) => {
      drains.get(subject).push(await queue.drain(subject));
    }));

    subjects.forEach((subject) => {
      const handedOut = drains.get(subject).flat().map(String);
      assert.strictEqual(new Set(handedOut).size, handedOut.length, `${subject}: a frame went twice`);
      range(PRODUCERS).forEach((producer) => {
        const sequence = handedOut
          .filter((frame) => frame.startsWith(`${producer}:`))
          .map((frame) => Number(frame.split(':')[1]));
        assert.deepStrictEqual(sequence, range(FRAMES), `${subject} producer ${producer}`);
      });
    });
  });

  test('the cap keeps the newest 10,000 past the cursor, the rest are gone for good', async () => {
    const queue = await emptyQueue(DB);
    await pool.query(
      `INSERT INTO undelivered (subject, frame)
       SELECT $1, convert_to('f-' || n, 'UTF8') FROM generate_series(1, $2::int) n`,
      [ALICE_1, MAX_FRAMES + 5]
    );

    const frames = (await queue.drain(ALICE_1)).map(String);
    assert.strictEqual(frames.length, MAX_FRAMES);
    assert.strictEqual(frames[0], 'f-6');
    assert.strictEqual(frames[frames.length - 1], `f-${MAX_FRAMES + 5}`);
    assert.deepStrictEqual(await queue.drain(ALICE_1), []);
  });

  test('retention drops the days older than thirty, concurrently and idempotently', async () => {
    const queue = await emptyQueue(DB);
    const old = new Date(Date.now() - (TTL_SEC * 1000 + 10 * DAY_MS));
    await queue.maintain(old);
    await pool.query('INSERT INTO undelivered (subject, frame, at) VALUES ($1, $2, $3)', [
      ALICE_1,
      Buffer.from('stale'),
      old
    ]);
    await queue.enqueue(ALICE_1, Buffer.from('fresh'));
    assert.ok((await partitions()).includes(partitionName(dayOf(old.getTime()))));

    // every process runs the job: three at once, on connections of their own
    const others = range(3).map(() => reopenQueue(DB));
    await Promise.all(others.map((other) => other.maintain()));
    await Promise.all(others.map((other) => other.dispose()));

    const day = dayOf(Date.now());
    assert.deepStrictEqual(await partitions(), range(4).map((n) => partitionName(day + n * DAY_MS)));
    assert.deepStrictEqual((await queue.drain(ALICE_1)).map(String), ['fresh']);
  });

  test('an enqueue never fails for want of a partition', async () => {
    const queue = await emptyQueue(DB);
    const name = partitionName(dayOf(Date.now()));
    await pool.query(`ALTER TABLE undelivered DETACH PARTITION ${name}; DROP TABLE ${name}`);

    await queue.enqueue(ALICE_1, Buffer.from('after the gap'));
    assert.deepStrictEqual((await queue.drain(ALICE_1)).map(String), ['after the gap']);
  });
});
