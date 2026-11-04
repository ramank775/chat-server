const assert = require('node:assert');
const { test, describe, after } = require('node:test');
const { MongoClient } = require('mongodb');
const {
  COLLECTION, TTL_SEC, RECEIPT_TTL_SEC, expiryOf
} = require('../../../libs/delivery-manager/undelivered-queue');
const {
  FRAME_CLASS, classFlags, decodeEnvelope, decodeWsEnvelope, uuidBytes, uuidText
} = require('../../../libs/v3-envelope');
const { DEVICE_1, DEVICE_2 } = require('../../connection-gateway/test/helper');
const {
  idOf,
  nameOf,
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
const ALICE_1 = `${ALICE}:${DEVICE_1}`;
const BOB_1 = `${BOB}:${DEVICE_1}`;

after(closeQueues);

/** op_id names on `userId`'s timeline as `deviceId` would pull it from `since`. */
const opIdsFor = async (queue, userId, deviceId = DEVICE_1, since = 0) =>
  (await queue.pending(userId, deviceId, since)).envelopes
    .map((bytes) => nameOf(uuidText(decodeEnvelope(bytes).opId)));

describe('message-delivery fanout (SYNC_PROTOCOL §10.3)', () => {
  test('an online device is pushed to its gateway, and the envelope is on the timeline', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.online(ALICE);

    const event = envelopeEvent();
    await harness.worker.onMessage(event);
    await settle();

    assert.strictEqual(harness.redis.published.length, 1);
    assert.strictEqual(harness.redis.published[0].channel, 'msg:gateway-1:0');
    const { envelopes } = await harness.queue.pending(ALICE, DEVICE_1);
    assert.strictEqual(envelopes.length, 1, 'a push into a dead socket must not be lost');
    assert.ok(envelopes[0].equals(event.toEnvelopeBytes()));
    assert.deepStrictEqual(harness.wakeEvents(), [], 'online: no wake');
  });

  test('the sending device is left out, its user\'s other devices are not', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(SENDER, DEVICE_1);
    await harness.offline(SENDER, DEVICE_2);
    await harness.offline(ALICE);

    const event = envelopeEvent({ senderDevice: DEVICE_1 });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients.sort(), [ALICE_1, `${SENDER}:${DEVICE_2}`].sort());
    assert.deepStrictEqual(await opIdsFor(harness.queue, SENDER, DEVICE_1), []);
    assert.deepStrictEqual(await opIdsFor(harness.queue, SENDER, DEVICE_2), ['op-1']);
    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE), ['op-1']);
  });

  test('a server-authored event is not on its actor\'s timeline at all', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(SENDER, DEVICE_1);
    await harness.offline(SENDER, DEVICE_2);
    await harness.offline(ALICE);

    const event = envelopeEvent({ senderDevice: '' });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients, [ALICE_1]);
    assert.deepStrictEqual(await opIdsFor(harness.queue, SENDER, DEVICE_2), []);
    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE), ['op-1']);
  });

  test('an offline device is woken; the timeline holds the exact wire Envelope bytes', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    const event = envelopeEvent();
    await harness.worker.onMessage(event);

    const { envelopes } = await harness.queue.pending(ALICE, DEVICE_1);
    assert.strictEqual(envelopes.length, 1);
    assert.ok(envelopes[0].equals(event.toEnvelopeBytes()));

    const wakes = harness.wakeEvents();
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(wakes[0].key, ALICE_1, 'the wake is keyed per (user, device)');
  });

  test('every device of a reader reads the same timeline', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE, DEVICE_1);
    await harness.offline(ALICE, DEVICE_2);

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE, DEVICE_1), ['op-1']);
    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE, DEVICE_2), ['op-1']);
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

/**
 * One stored fanout, as message-delivery appends it; good for an hour. Its
 * stored bytes are just its name, which is what a pull is checked against.
 */
const entry = (name, ts, recipients, extra = {}) => ({
  opId: idOf(name),
  ts,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  recipients,
  sender: SENDER,
  senderDevice: DEVICE_1,
  envelope: Buffer.from(name),
  ...extra
});
const names = async (queue, userId, since = 0, limit = undefined) => {
  const { envelopes, more } = await queue.pending(userId, DEVICE_1, since, limit);
  return { frames: envelopes.map(String), more };
};

describe('timeline (SYNC_PROTOCOL §10.6, §19 decision 1)', () => {
  test('pages come in timestamp order, channels interleaved as they were stamped', async () => {
    const members = new Map([['channel-1', [SENDER, ALICE]], ['channel-2', [SENDER, ALICE]]]);
    const harness = await startWorker({ members });
    await harness.offline(ALICE);

    const order = [['channel-1', 'op-3', 1], ['channel-2', 'op-1', 2], ['channel-1', 'op-2', 3]];
    const now = Date.now();
    await eachSeries(order, ([channelId, opId, ts]) => harness.worker.onMessage(
      envelopeEvent({ opId, channelId, serverTimestampMs: now + ts })
    ));

    const pulled = (await harness.queue.pending(ALICE, DEVICE_1)).envelopes
      .map(decodeEnvelope)
      .map((wire) => [nameOf(uuidText(wire.channelId)), nameOf(uuidText(wire.opId))]);
    assert.deepStrictEqual(pulled, order.map(([channelId, opId]) => [channelId, opId]));
  });

  test('every stored envelope is the one a push carries, sender and channel text left out', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    const event = envelopeEvent({ payload: Buffer.from([0x53, 0x01]) });
    await harness.worker.onMessage(event);

    const [stored] = (await harness.queue.pending(ALICE, DEVICE_1)).envelopes;
    const wire = decodeEnvelope(stored);
    assert.deepStrictEqual(wire, decodeWsEnvelope(event.toPushFrame()).push);
    assert.ok(wire.payload.equals(Buffer.from([0x53, 0x01])));
    assert.deepStrictEqual(wire.senderDeviceId, uuidBytes(DEVICE_1));
    assert.deepStrictEqual(wire.channelId, uuidBytes(idOf('channel-1')));
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
    await queue.append(entry('op-1', 1, [ALICE], { envelope: Buffer.from('first') }));
    await queue.append(entry('op-1', 9, [ALICE], { envelope: Buffer.from('retry') }));

    assert.deepStrictEqual((await names(queue, ALICE)).frames, ['first']);
  });

  test('an expired envelope is left out of every pull', async () => {
    const queue = await emptyQueue(DB);
    await queue.append(entry('gone', 1, [ALICE], { expiresAt: new Date(Date.now() - 1) }));
    await queue.append(entry('kept', 2, [ALICE]));

    assert.deepStrictEqual((await names(queue, ALICE)).frames, ['kept']);
  });

  test('expiry: the sender\'s ttl_sec, at most and by default 30 days', () => {
    const at = 1700000000000;
    const day = 24 * 60 * 60;
    assert.strictEqual(expiryOf({ serverTimestampMs: at }).getTime(), at + TTL_SEC * 1000);
    assert.strictEqual(expiryOf({ serverTimestampMs: at, ttlSec: 0 }).getTime(), at + TTL_SEC * 1000);
    assert.strictEqual(expiryOf({ serverTimestampMs: at, ttlSec: day }).getTime(), at + day * 1000);
    assert.strictEqual(expiryOf({ serverTimestampMs: at, ttlSec: 99 * day }).getTime(),
      at + TTL_SEC * 1000, 'capped');
  });

  test('expiry: a receipt is kept min(ttl_sec, 7 days); other classes as before (decision 218)', () => {
    const at = 1700000000000;
    const day = 24 * 60 * 60;
    const receipt = classFlags(FRAME_CLASS.RECEIPT);
    assert.strictEqual(RECEIPT_TTL_SEC, 7 * day);
    assert.strictEqual(expiryOf({ serverTimestampMs: at, flags: receipt }).getTime(),
      at + 7 * day * 1000, 'unset: the week');
    assert.strictEqual(expiryOf({ serverTimestampMs: at, flags: receipt, ttlSec: day }).getTime(),
      at + day * 1000, 'shorter: its own');
    assert.strictEqual(expiryOf({ serverTimestampMs: at, flags: receipt, ttlSec: 20 * day }).getTime(),
      at + 7 * day * 1000, 'longer: the week');
    // SILENT on top of the class changes nothing
    assert.strictEqual(expiryOf({ serverTimestampMs: at, flags: receipt + 1 }).getTime(),
      at + 7 * day * 1000);
    [FRAME_CLASS.MESSAGE, FRAME_CLASS.MUTATION, FRAME_CLASS.KEY, FRAME_CLASS.RESEND,
      FRAME_CLASS.EVENT].forEach((cls) => {
      assert.strictEqual(expiryOf({ serverTimestampMs: at, flags: classFlags(cls) }).getTime(),
        at + TTL_SEC * 1000, `class ${cls}`);
    });
  });

  test('fanout keeps a receipt a week, a message stamped as long ago stays', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

    await harness.worker.onMessage(envelopeEvent({
      opId: 'receipt', flags: classFlags(FRAME_CLASS.RECEIPT), serverTimestampMs: eightDaysAgo
    }));
    await harness.worker.onMessage(envelopeEvent({
      opId: 'mutation', flags: classFlags(FRAME_CLASS.MUTATION), serverTimestampMs: eightDaysAgo
    }));

    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE), ['mutation']);
  });

  test('fanout keeps an envelope for its sender\'s ttl_sec', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);
    const now = Date.now();

    const event = envelopeEvent({ opId: 'op-short', serverTimestampMs: now - 2000 });
    event.envelope.ttlSec = 1;
    await harness.worker.onMessage(event);
    await harness.worker.onMessage(envelopeEvent({ opId: 'op-default', serverTimestampMs: now }));

    assert.deepStrictEqual(await opIdsFor(harness.queue, ALICE), ['op-default'],
      'stamped 2 s ago with a 1 s TTL: already expired');
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

  test('stored once per fanout, deleted by a TTL index on each envelope\'s expiry', {
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
      assert.deepStrictEqual(ttl.key, { expiresAt: 1 });
      assert.strictEqual(ttl.expireAfterSeconds, 0);
      assert.ok(indexes.some((index) => index.key.recipients === 1 && index.key.ts === 1));

      // decision 218: ids binary, user ids as the 36-bit number
      const doc = await collection.findOne({});
      assert.strictEqual(doc.opId.sub_type, 4, 'op_id a UUID');
      assert.strictEqual(uuidText(doc.opId.buffer), idOf('op-group'));
      assert.strictEqual(doc.senderDevice.sub_type, 4, 'sender_device a UUID');
      assert.deepStrictEqual(doc.recipients, [ALICE, BOB, SENDER].map((id) => parseInt(id, 16)));
      assert.strictEqual(doc.sender, parseInt(SENDER, 16));
    } finally {
      await client.close();
    }
  });

  test('a text-id timeline from before decision 218 is dropped at boot', {
    skip: TEST_DB !== 'mongo' && 'mongo only: pg-undelivered-queue.test.js has its own'
  }, async () => {
    const queue = await emptyQueue(DB);
    const client = new MongoClient(mongoUrlFor(DB), { auth: null });
    try {
      const collection = client.db().collection(COLLECTION);
      await collection.insertOne({ opId: 'op-old', ts: 1, recipients: [ALICE], frame: Buffer.from('x') });
      await queue.createIndexes();
      assert.strictEqual(await collection.countDocuments(), 0);
      await queue.append(entry('op-new', 1, [ALICE]));
      assert.deepStrictEqual((await names(queue, ALICE)).frames, ['op-new']);
    } finally {
      await client.close();
    }
  });
});
