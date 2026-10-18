const assert = require('node:assert');
const { test, describe, after } = require('node:test');
const { MongoClient } = require('mongodb');
const { COLLECTION, TTL_SEC } = require('../../../libs/delivery-manager/undelivered-queue');
const { decodeWsEnvelope, EnvelopeEvent, WS_TYPE } = require('../../../libs/v3-envelope');
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

describe('message-delivery fanout (SYNC_PROTOCOL §10.3)', () => {
  test('an online device is pushed to its gateway, and logged all the same', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.online(ALICE);

    const event = envelopeEvent();
    await harness.worker.onMessage(event);
    await settle();

    assert.strictEqual(harness.redis.published.length, 1);
    assert.strictEqual(harness.redis.published[0].channel, 'msg:gateway-1:0');
    const { frames } = await harness.queue.pending(ALICE_1);
    assert.strictEqual(frames.length, 1, 'a push into a dead socket must not be lost');
    assert.ok(frames[0].equals(event.toPushFrame()));
    assert.deepStrictEqual(harness.wakeEvents(), [], 'online: no wake');
  });

  test('the sending device is excluded, its user\'s other devices are not', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(SENDER, 'device-1');
    await harness.offline(SENDER, 'device-2');
    await harness.offline(ALICE);

    const event = envelopeEvent({ senderDevice: 'device-1' });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients.sort(), [ALICE_1, `${SENDER}:device-2`].sort());
    assert.deepStrictEqual((await harness.queue.pending(`${SENDER}:device-1`)).frames, []);
  });

  test('a server-authored event skips the whole actor, which has no device', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(SENDER, 'device-1');
    await harness.offline(SENDER, 'device-2');
    await harness.offline(ALICE);

    const event = envelopeEvent({ senderDevice: '' });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients, [ALICE_1]);
  });

  test('an offline device is queued with the exact push-frame bytes and woken', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    const event = envelopeEvent();
    await harness.worker.onMessage(event);

    const { frames } = await harness.queue.pending(ALICE_1);
    assert.strictEqual(frames.length, 1);
    assert.ok(frames[0].equals(event.toPushFrame()));

    const wakes = harness.wakeEvents();
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(wakes[0].key, ALICE_1, 'the wake is keyed per (user, device)');
  });

  test('a queue is per device, not per user', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE, 'device-1');
    await harness.offline(ALICE, 'device-2');

    await harness.worker.onMessage(envelopeEvent());

    assert.strictEqual((await harness.queue.pending(ALICE_1)).frames.length, 1);
    assert.strictEqual((await harness.queue.pending(`${ALICE}:device-2`)).frames.length, 1);
  });

  test('a device the registry has never seen gets no fanout', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(harness.wakeEvents(), []);
  });

  test('ephemeral envelopes are never logged and carry no offset', async () => {
    const harness = await startWorker({
      members: new Map([['channel-1', [SENDER, ALICE, BOB]]])
    });
    await harness.offline(ALICE);
    await harness.online(BOB);

    const event = envelopeEvent({ ephemeral: true });
    await harness.worker.onMessage(event);
    await settle();

    assert.strictEqual(event.envelope.offset, undefined);
    assert.deepStrictEqual((await harness.queue.pending(ALICE_1)).frames, []);
    assert.deepStrictEqual((await harness.queue.pending(BOB_1)).frames, []);
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
    assert.strictEqual((await harness.queue.pending(ALICE_1)).frames.length, 1);
    assert.strictEqual((await harness.queue.pending(BOB_1)).frames.length, 1);
  });

  test('a channel with no members other than the sender fans out to nobody', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER]]]) });
    await harness.offline(SENDER);

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(harness.redis.published, []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
  });
});

/** One fanout per name, each under the next offset as the worker does; the offsets. */
async function fill(queue, subject, names) {
  const offsets = [];
  await eachSeries(names, async (name) => {
    const offset = await queue.nextOffset();
    offsets.push(offset);
    await queue.enqueue(subject, offset, Buffer.from(name));
  });
  return offsets;
}
const read = async (queue, subject, pointer = 0, limit = undefined) => {
  const { frames, more } = await queue.pending(subject, pointer, limit);
  return { frames: frames.map(String), more };
};

describe('device logs (SYNC_PROTOCOL §10.6, §19 decision 1)', () => {
  test('one offset per fanout, the same for every recipient, stamped on the push', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE, BOB]]]) });
    await harness.offline(ALICE);
    await harness.online(BOB);

    const first = envelopeEvent({ opId: 'op-1' });
    const second = envelopeEvent({ opId: 'op-2' });
    await harness.worker.onMessage(first);
    await harness.worker.onMessage(second);
    await settle();

    assert.ok(first.envelope.offset > 0);
    assert.ok(second.envelope.offset > first.envelope.offset, 'strictly increasing');
    const pushed = (frame) => decodeWsEnvelope(frame).push;
    const alice = (await harness.queue.pending(ALICE_1)).frames.map(pushed);
    const bob = (await harness.queue.pending(BOB_1)).frames.map(pushed);
    assert.deepStrictEqual(alice.map((p) => p.offset), [first.envelope.offset, second.envelope.offset]);
    assert.deepStrictEqual(bob.map((p) => p.offset), alice.map((p) => p.offset));
    // and what bob's gateway got live carries the same offset
    const live = EnvelopeEvent.fromBinary(harness.redis.published[0].payload);
    assert.strictEqual(live.envelope.offset, first.envelope.offset);
  });

  test('pages come in offset order, channels interleaved as they arrived', async () => {
    const members = new Map([['channel-1', [SENDER, ALICE]], ['channel-2', [SENDER, ALICE]]]);
    const harness = await startWorker({ members });
    await harness.offline(ALICE);

    const order = [['channel-1', 'op-3'], ['channel-2', 'op-1'], ['channel-1', 'op-2']];
    await eachSeries(order, ([channelId, opId]) => harness.worker.onMessage(
      envelopeEvent({ opId, channelId })
    ));

    const pulled = (await harness.queue.pending(ALICE_1)).frames
      .map((frame) => decodeWsEnvelope(frame).push)
      .map((push) => [push.channelId, push.opId]);
    assert.deepStrictEqual(pulled, order);
  });

  test('every logged frame is a decodable WS_PUSH envelope', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    await harness.worker.onMessage(envelopeEvent({ payload: Buffer.from([0x53, 0x01]) }));

    const [frame] = (await harness.queue.pending(ALICE_1)).frames;
    const decoded = decodeWsEnvelope(frame);
    assert.strictEqual(decoded.type, WS_TYPE.WS_PUSH);
    assert.strictEqual(decoded.push.senderUserId, SENDER);
    assert.ok(decoded.push.payload.equals(Buffer.from([0x53, 0x01])));
  });

  test('a read removes nothing; the device reads past its own pointer', async () => {
    const queue = await emptyQueue(DB);
    const offsets = await fill(queue, ALICE_1, ['f-1', 'f-2', 'f-3']);

    assert.deepStrictEqual((await read(queue, ALICE_1)).frames, ['f-1', 'f-2', 'f-3']);
    assert.deepStrictEqual((await read(queue, ALICE_1)).frames, ['f-1', 'f-2', 'f-3']);
    assert.deepStrictEqual((await read(queue, ALICE_1, offsets[0])).frames, ['f-2', 'f-3']);
    assert.deepStrictEqual((await read(queue, ALICE_1, offsets[2])).frames, []);
  });

  test('pages: at most `limit` frames, and whether more wait', async () => {
    const queue = await emptyQueue(DB);
    const offsets = await fill(queue, ALICE_1, ['f-1', 'f-2', 'f-3', 'f-4', 'f-5']);

    assert.deepStrictEqual(await read(queue, ALICE_1, 0, 2), { frames: ['f-1', 'f-2'], more: true });
    assert.deepStrictEqual(await read(queue, ALICE_1, offsets[1], 2),
      { frames: ['f-3', 'f-4'], more: true });
    assert.deepStrictEqual(await read(queue, ALICE_1, offsets[3], 2), { frames: ['f-5'], more: false });
  });

  test('logs are per (user, device)', async () => {
    const queue = await emptyQueue(DB);
    await fill(queue, ALICE_1, ['for-alice']);

    assert.deepStrictEqual((await read(queue, BOB_1)).frames, []);
    assert.deepStrictEqual((await read(queue, `${ALICE}:device-2`)).frames, []);
    assert.deepStrictEqual((await read(queue, ALICE_1)).frames, ['for-alice']);
  });

  test('frames and offsets survive a restart', async () => {
    const before = await emptyQueue(DB);
    await fill(before, ALICE_1, ['frame-1', 'frame-2']);
    const last = await before.nextOffset();

    // DECISIONS row 125: the in-process queue lost these on every deploy
    const restarted = reopenQueue(DB);
    try {
      assert.deepStrictEqual((await read(restarted, ALICE_1)).frames, ['frame-1', 'frame-2']);
      assert.ok(await restarted.nextOffset() > last, 'a restart never reuses an offset');
    } finally {
      await restarted.dispose();
    }
  });

  test('the indexes include a TTL of the §19 thirty days on the enqueue time', {
    skip: TEST_DB !== 'mongo' && 'mongo only: pg drops day partitions instead'
  }, async () => {
    const queue = await emptyQueue(DB);
    await queue.createIndexes();
    await queue.createIndexes(); // idempotent: every boot runs it

    const client = new MongoClient(mongoUrlFor(DB), { auth: null });
    try {
      const indexes = await client.db().collection(COLLECTION).indexes();
      const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);
      assert.deepStrictEqual(ttl.key, { at: 1 });
      assert.strictEqual(ttl.expireAfterSeconds, TTL_SEC);
      const reads = indexes.find((index) => index.key.offset === 1);
      assert.deepStrictEqual(reads.key, { subject: 1, offset: 1 });
    } finally {
      await client.close();
    }
  });
});

