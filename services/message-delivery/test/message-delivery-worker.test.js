const assert = require('node:assert');
const { test, describe, after } = require('node:test');
const { MongoClient } = require('mongodb');
const {
  UndeliveredQueue,
  COLLECTION,
  TTL_SEC
} = require('../../../libs/delivery-manager/undelivered-queue');
const { decodeWsEnvelope, WS_TYPE } = require('../../../libs/v3-envelope');
const {
  envelopeEvent,
  startWorker,
  settle,
  eachSeries,
  DB,
  mongoUrlFor,
  emptyQueue,
  closeQueues
} = require('./helper');

const SENDER = '00000000a';
const ALICE = '00000000b';
const BOB = '00000000c';
/** Delivery is keyed per `(user_id, device_id)` — TRIM_4_12_CONTRACT §7. */
const ALICE_1 = `${ALICE}:device-1`;
const BOB_1 = `${BOB}:device-1`;

after(closeQueues);

describe('message-delivery fanout (SYNC_PROTOCOL §10.3)', () => {
  test('an online device is pushed to its gateway and never queued', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.online(ALICE);

    await harness.worker.onMessage(envelopeEvent());
    await settle();

    assert.strictEqual(harness.redis.published.length, 1);
    assert.strictEqual(harness.redis.published[0].channel, 'msg:gateway-1:0');
    assert.deepStrictEqual(await harness.queue.drain(ALICE_1), []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
  });

  test('the sending device is excluded, its user\'s other devices are not', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(SENDER, 'device-1');
    await harness.offline(SENDER, 'device-2');
    await harness.offline(ALICE);

    const event = envelopeEvent({ senderDevice: 'device-1' });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients.sort(), [ALICE_1, `${SENDER}:device-2`].sort());
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

    const queued = await harness.queue.drain(ALICE_1);
    assert.strictEqual(queued.length, 1);
    assert.ok(queued[0].equals(event.toPushFrame()));

    const wakes = harness.wakeEvents();
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(wakes[0].key, ALICE_1, 'the wake is keyed per (user, device)');
  });

  test('a queue is per device, not per user', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE, 'device-1');
    await harness.offline(ALICE, 'device-2');

    await harness.worker.onMessage(envelopeEvent());

    assert.strictEqual((await harness.queue.drain(ALICE_1)).length, 1);
    assert.strictEqual((await harness.queue.drain(`${ALICE}:device-2`)).length, 1);
  });

  test('a device the registry has never seen gets no fanout', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(harness.wakeEvents(), []);
  });

  test('ephemeral envelopes are dropped for offline recipients, never queued', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    await harness.worker.onMessage(envelopeEvent({ ephemeral: true }));

    assert.deepStrictEqual(await harness.queue.drain(ALICE_1), []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
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
    assert.strictEqual((await harness.queue.drain(ALICE_1)).length, 1);
    assert.strictEqual((await harness.queue.drain(BOB_1)).length, 1);
  });

  test('a channel with no members other than the sender fans out to nobody', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER]]]) });
    await harness.offline(SENDER);

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(harness.redis.published, []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
  });
});

describe('undelivered queue (SYNC_PROTOCOL §10.6, §19 decisions 1-2)', () => {
  test('drains in enqueue order, channels interleaved as they arrived', async () => {
    const members = new Map([['channel-1', [SENDER, ALICE]], ['channel-2', [SENDER, ALICE]]]);
    const harness = await startWorker({ members });
    await harness.offline(ALICE);

    const order = [['channel-1', 'op-3'], ['channel-2', 'op-1'], ['channel-1', 'op-2']];
    await eachSeries(order, ([channelId, opId]) => harness.worker.onMessage(
      envelopeEvent({ opId, channelId })
    ));

    const drained = (await harness.queue.drain(ALICE_1))
      .map((frame) => decodeWsEnvelope(frame).push)
      .map((push) => [push.channelId, push.opId]);
    assert.deepStrictEqual(drained, order);
  });

  test('every queued frame is a decodable WS_PUSH envelope', async () => {
    const harness = await startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    await harness.worker.onMessage(envelopeEvent({ payload: Buffer.from([0x53, 0x01]) }));

    const [frame] = await harness.queue.drain(ALICE_1);
    const decoded = decodeWsEnvelope(frame);
    assert.strictEqual(decoded.type, WS_TYPE.WS_PUSH);
    assert.strictEqual(decoded.push.senderUserId, SENDER);
    assert.ok(decoded.push.payload.equals(Buffer.from([0x53, 0x01])));
  });

  test('the frame cap drops the oldest frames', async () => {
    const queue = await emptyQueue(DB, { maxFrames: 3 });
    await eachSeries([1, 2, 3, 4, 5], (n) => queue.enqueue(ALICE_1, Buffer.from(`frame-${n}`)));

    const frames = await queue.drain(ALICE_1);
    assert.deepStrictEqual(frames.map(String), ['frame-3', 'frame-4', 'frame-5']);
  });

  test('the cap is per subject', async () => {
    const queue = await emptyQueue(DB, { maxFrames: 2 });
    await eachSeries([1, 2, 3], (n) => queue.enqueue(ALICE_1, Buffer.from(`alice-${n}`)));
    await queue.enqueue(BOB_1, Buffer.from('bob-1'));

    assert.deepStrictEqual((await queue.drain(ALICE_1)).map(String), ['alice-2', 'alice-3']);
    assert.deepStrictEqual((await queue.drain(BOB_1)).map(String), ['bob-1']);
  });

  test('a drain empties the queue', async () => {
    const queue = await emptyQueue(DB);
    await queue.enqueue(ALICE_1, Buffer.from('frame'));

    assert.strictEqual((await queue.drain(ALICE_1)).length, 1);
    assert.deepStrictEqual(await queue.drain(ALICE_1), []);
  });

  test('queues are per (user, device)', async () => {
    const queue = await emptyQueue(DB);
    await queue.enqueue(ALICE_1, Buffer.from('for-alice'));

    assert.deepStrictEqual(await queue.drain(BOB_1), []);
    assert.deepStrictEqual(await queue.drain(`${ALICE}:device-2`), []);
    assert.strictEqual((await queue.drain(ALICE_1)).length, 1);
  });

  test('frames survive a restart: a new queue on a new connection drains them', async () => {
    const before = await emptyQueue(DB);
    await eachSeries([1, 2], (n) => before.enqueue(ALICE_1, Buffer.from(`frame-${n}`)));

    // DECISIONS row 125: the in-process queue lost these on every deploy
    const restarted = new UndeliveredQueue({
      client: new MongoClient(mongoUrlFor(DB), { auth: null })
    });
    try {
      assert.deepStrictEqual((await restarted.drain(ALICE_1)).map(String), ['frame-1', 'frame-2']);
    } finally {
      await restarted.dispose();
    }
  });

  test('concurrent drains never hand out a frame twice, and lose none', async () => {
    const queue = await emptyQueue(DB);
    const first = Array.from({ length: 200 }, (_, n) => `early-${n}`);
    await eachSeries(first, (name) => queue.enqueue(ALICE_1, Buffer.from(name)));

    // five drains race each other and a burst of late enqueues
    const late = Array.from({ length: 50 }, (_, n) => `late-${n}`);
    const [drains] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, () => queue.drain(ALICE_1))),
      eachSeries(late, (name) => queue.enqueue(ALICE_1, Buffer.from(name)))
    ]);
    const leftover = await queue.drain(ALICE_1);

    const handedOut = [...drains, leftover].flat().map(String);
    assert.strictEqual(new Set(handedOut).size, handedOut.length, 'a frame was handed out twice');
    assert.deepStrictEqual([...handedOut].sort(), [...first, ...late].sort());
    // and each drain's share is still in enqueue order
    const position = new Map([...first, ...late].map((name, index) => [name, index]));
    [...drains, leftover].forEach((frames) => {
      const at = frames.map((frame) => position.get(String(frame)));
      assert.deepStrictEqual(at, [...at].sort((a, b) => a - b));
    });
  });

  test('the indexes include a TTL of the §19 thirty days on the enqueue time', async () => {
    const queue = await emptyQueue(DB);
    await queue.createIndexes();
    await queue.createIndexes(); // idempotent: every boot runs it

    const client = new MongoClient(mongoUrlFor(DB), { auth: null });
    try {
      const indexes = await client.db().collection(COLLECTION).indexes();
      const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);
      assert.deepStrictEqual(ttl.key, { at: 1 });
      assert.strictEqual(ttl.expireAfterSeconds, TTL_SEC);
      assert.ok(indexes.some((index) => index.key.subject === 1));
    } finally {
      await client.close();
    }
  });
});
