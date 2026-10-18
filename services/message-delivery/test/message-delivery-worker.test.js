const assert = require('node:assert');
const { test, describe, after } = require('node:test');
const { MongoClient } = require('mongodb');
const { COLLECTION, TTL_SEC } = require('../../../libs/delivery-manager/undelivered-queue');
const { decodeWsEnvelope, WS_TYPE } = require('../../../libs/v3-envelope');
const {
  envelopeEvent,
  startWorker,
  settle,
  eachSeries,
  DB,
  mongoUrlFor,
  emptyQueue,
  reopenQueue,
  closeQueues
} = require('./helper');
const { TEST_DB } = require('../../../test/helpers/db');

const SENDER = '00000000a';
const ALICE = '00000000b';
const BOB = '00000000c';
/** Delivery is keyed per `(user_id, device_id)` — TRIM_4_12_CONTRACT §7. */
const ALICE_1 = `${ALICE}:device-1`;
const BOB_1 = `${BOB}:device-1`;

after(closeQueues);

/** op_ids on `userId`'s timeline as `deviceId` would pull it from `since`. */
const opIdsFor = async (queue, userId, deviceId = 'device-1', since = 0) =>
  (await queue.pending(userId, deviceId, since)).frames.map((frame) => decodeWsEnvelope(frame).push.opId);

describe('message-delivery fanout (SYNC_PROTOCOL §10.3)', () => {
  test('an online device is pushed to its gateway, and the envelope is on the timeline', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.online(ALICE);

    const event = envelopeEvent();
    await harness.worker.onMessage(event);
    await settle();

    assert.strictEqual(harness.redis.published.length, 1);
    assert.strictEqual(harness.redis.published[0].channel, 'msg:gateway-1:0');
    const { frames } = await harness.queue.pending(ALICE, 'device-1');
    assert.strictEqual(frames.length, 1, 'a push into a dead socket must not be lost');
    assert.ok(frames[0].equals(event.toPushFrame()));
    assert.deepStrictEqual(harness.wakeEvents(), [], 'online: no wake');
  });

  test('the sending device is left out, its user\'s other devices are not', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(SENDER, 'device-1');
    await harness.offline(SENDER, 'device-2');
    await harness.offline(ALICE);

    const event = envelopeEvent({ senderDevice: 'device-1' });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients.sort(), [ALICE_1, `${SENDER}:device-2`].sort());
    assert.deepStrictEqual(await opIdsFor(harness.queue, SENDER, 'device-1'), []);
    assert.deepStrictEqual(await opIdsFor(harness.queue, SENDER, 'device-2'), ['op-1']);
    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE), ['op-1']);
  });

  test('a server-authored event is not on its actor\'s timeline at all', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(SENDER, 'device-1');
    await harness.offline(SENDER, 'device-2');
    await harness.offline(ALICE);

    const event = envelopeEvent({ senderDevice: '' });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients, [ALICE_1]);
    assert.deepStrictEqual(await opIdsFor(harness.queue, SENDER, 'device-2'), []);
    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE), ['op-1']);
  });

  test('an offline device is woken; the timeline holds the exact push-frame bytes', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    const event = envelopeEvent();
    await harness.worker.onMessage(event);

    const { frames } = await harness.queue.pending(ALICE, 'device-1');
    assert.strictEqual(frames.length, 1);
    assert.ok(frames[0].equals(event.toPushFrame()));

    const wakes = harness.wakeEvents();
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(wakes[0].key, ALICE_1, 'the wake is keyed per (user, device)');
  });

  test('every device of a reader reads the same timeline', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE, 'device-1');
    await harness.offline(ALICE, 'device-2');

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE, 'device-1'), ['op-1']);
    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE, 'device-2'), ['op-1']);
    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE, 'a-device-signed-in-later'), ['op-1']);
  });

  test('a reader with no device yet still has it on the timeline', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(harness.wakeEvents(), []);
    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE), ['op-1']);
  });

  test('ephemeral envelopes are never stored, online or not', async () => {
    const harness = await startWorker({
      members: new Map([['channel-1', [SENDER, ALICE, BOB]]])
    });
    await harness.offline(ALICE);
    await harness.online(BOB);

    await harness.worker.onMessage(envelopeEvent({ ephemeral: true }));
    await settle();

    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE), []);
    assert.deepStrictEqual(await opIdsFor(harness.queue, BOB), []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
    assert.strictEqual(harness.redis.published.length, 1, 'still pushed live to BOB');
  });

  test('a DM or server event with explicit recipients bypasses membership', async () => {
    // channel-ms knows nothing about this channel: an empty member set would
    // mean no fanout at all if the explicit recipients were not honoured.
    const harness = await startWorker({ members: new Map() });
    await harness.offline(ALICE);
    await harness.offline(BOB);

    const event = envelopeEvent({ channelId: 'channel-gone', recipients: [ALICE, BOB] });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients, [ALICE_1, BOB_1]);
    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE), ['op-1']);
    assert.deepStrictEqual(await opIdsFor(harness.queue, BOB), ['op-1']);
  });

  test('a channel with no members other than the sender fans out to nobody', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER]]]) });
    await harness.offline(SENDER);

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(harness.redis.published, []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
  });
});

/** One stored fanout, as message-delivery appends it. */
const entry = (opId, ts, recipients, extra = {}) => ({
  opId,
  ts,
  recipients,
  sender: SENDER,
  senderDevice: 'device-1',
  frame: Buffer.from(opId),
  ...extra
});
const names = async (queue, userId, since = 0, limit = undefined) => {
  const { frames, more } = await queue.pending(userId, 'device-1', since, limit);
  return { frames: frames.map(String), more };
};

describe('timeline (SYNC_PROTOCOL §10.6, §19 decision 1)', () => {
  test('pages come in timestamp order, channels interleaved as they were stamped', async () => {
    const members = new Map([['channel-1', [SENDER, ALICE]], ['channel-2', [SENDER, ALICE]]]);
    const harness = await startWorker({ members });
    await harness.offline(ALICE);

    const order = [['channel-1', 'op-3', 1], ['channel-2', 'op-1', 2], ['channel-1', 'op-2', 3]];
    await eachSeries(order, ([channelId, opId, ts]) => harness.worker.onMessage(
      envelopeEvent({ opId, channelId, serverTimestampMs: 1700000000000 + ts })
    ));

    const pulled = (await harness.queue.pending(ALICE, 'device-1')).frames
      .map((frame) => decodeWsEnvelope(frame).push)
      .map((push) => [push.channelId, push.opId]);
    assert.deepStrictEqual(pulled, order.map(([channelId, opId]) => [channelId, opId]));
  });

  test('every stored frame is a decodable WS_PUSH envelope', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    await harness.worker.onMessage(envelopeEvent({ payload: Buffer.from([0x53, 0x01]) }));

    const [frame] = (await harness.queue.pending(ALICE, 'device-1')).frames;
    const decoded = decodeWsEnvelope(frame);
    assert.strictEqual(decoded.type, WS_TYPE.WS_PUSH);
    assert.strictEqual(decoded.push.senderUserId, SENDER);
    assert.ok(decoded.push.payload.equals(Buffer.from([0x53, 0x01])));
  });

  test('a read removes nothing; `since` is the device\'s pointer, inclusive', async () => {
    const queue = await emptyQueue(DB);
    await queue.append(entry('a', 100, [ALICE]));
    await queue.append(entry('b', 200, [ALICE]));
    await queue.append(entry('c', 300, [ALICE]));

    assert.deepStrictEqual((await names(queue, ALICE)).frames, ['a', 'b', 'c']);
    assert.deepStrictEqual((await names(queue, ALICE)).frames, ['a', 'b', 'c']);
    assert.deepStrictEqual((await names(queue, ALICE, 200)).frames, ['b', 'c']);
    assert.deepStrictEqual((await names(queue, ALICE, 301)).frames, []);
  });

  test('an envelope stored after a pull, in the pointer\'s own millisecond, is not missed', async () => {
    const queue = await emptyQueue(DB);
    await queue.append(entry('op-b', 500, [ALICE]));
    const first = await names(queue, ALICE);
    assert.deepStrictEqual(first.frames, ['op-b']);

    // the device's pointer is now 500; another envelope stamped 500 lands
    await queue.append(entry('op-a', 500, [ALICE]));
    assert.deepStrictEqual((await names(queue, ALICE, 500)).frames, ['op-a', 'op-b']);
  });

  test('pages: at most `limit`, ordered by (timestamp, op_id), and whether more wait', async () => {
    const queue = await emptyQueue(DB);
    await eachSeries([['e', 1], ['d', 2], ['c', 2], ['b', 3], ['a', 4]],
      ([name, ts]) => queue.append(entry(name, ts, [ALICE])));

    assert.deepStrictEqual(await names(queue, ALICE, 0, 2), { frames: ['e', 'c'], more: true });
    assert.deepStrictEqual(await names(queue, ALICE, 2, 2), { frames: ['c', 'd'], more: true });
    assert.deepStrictEqual(await names(queue, ALICE, 3, 2), { frames: ['b', 'a'], more: false });
  });

  test('a timeline holds only what names its user', async () => {
    const queue = await emptyQueue(DB);
    await queue.append(entry('for-alice', 1, [ALICE]));
    await queue.append(entry('for-both', 2, [ALICE, BOB]));

    assert.deepStrictEqual((await names(queue, ALICE)).frames, ['for-alice', 'for-both']);
    assert.deepStrictEqual((await names(queue, BOB)).frames, ['for-both']);
  });

  test('a sender retry that fans out again is stored once', async () => {
    const queue = await emptyQueue(DB);
    await queue.append(entry('op-1', 1, [ALICE], { frame: Buffer.from('first') }));
    await queue.append(entry('op-1', 9, [ALICE], { frame: Buffer.from('retry') }));

    assert.deepStrictEqual((await names(queue, ALICE)).frames, ['first']);
  });

  test('the timeline survives a restart', async () => {
    const before = await emptyQueue(DB);
    await before.append(entry('frame-1', 1, [ALICE]));
    await before.append(entry('frame-2', 2, [ALICE]));

    // DECISIONS row 125: the in-process queue lost these on every deploy
    const restarted = reopenQueue(DB);
    try {
      assert.deepStrictEqual((await names(restarted, ALICE)).frames, ['frame-1', 'frame-2']);
    } finally {
      await restarted.dispose();
    }
  });

  test('stored once per fanout, a TTL of the §19 thirty days on the store time', {
    skip: TEST_DB !== 'mongo' && 'mongo only: pg drops day partitions instead'
  }, async () => {
    const queue = await emptyQueue(DB);
    await queue.createIndexes();
    await queue.createIndexes(); // idempotent: every boot runs it
    await queue.append(entry('op-group', 1, [ALICE, BOB, SENDER]));

    const client = new MongoClient(mongoUrlFor(DB), { auth: null });
    try {
      const collection = client.db().collection(COLLECTION);
      assert.strictEqual(await collection.countDocuments(), 1, 'one document, three readers');
      const indexes = await collection.indexes();
      const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);
      assert.deepStrictEqual(ttl.key, { at: 1 });
      assert.strictEqual(ttl.expireAfterSeconds, TTL_SEC);
      assert.ok(indexes.some((index) => index.key.recipients === 1 && index.key.ts === 1));
    } finally {
      await client.close();
    }
  });
});
