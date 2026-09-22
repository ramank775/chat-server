const assert = require('node:assert');
const { test, describe } = require('node:test');
const { UndeliveredQueue } = require('../../../libs/delivery-manager/undelivered-queue');
const { decodeWsEnvelope, WS_TYPE } = require('../../../libs/v3-envelope');
const { envelopeEvent, startWorker, settle, eachSeries } = require('./helper');

const SENDER = '00000000a';
const ALICE = '00000000b';
const BOB = '00000000c';
/** Delivery is keyed per `(user_id, device_id)` — TRIM_4_12_CONTRACT §7. */
const ALICE_1 = `${ALICE}:device-1`;
const BOB_1 = `${BOB}:device-1`;

describe('message-delivery fanout (SYNC_PROTOCOL §10.3)', () => {
  test('an online device is pushed to its gateway and never queued', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.online(ALICE);

    await harness.worker.onMessage(envelopeEvent());
    await settle();

    assert.strictEqual(harness.redis.published.length, 1);
    assert.strictEqual(harness.redis.published[0].channel, 'msg:gateway-1:0');
    assert.deepStrictEqual(await harness.queue.drain(ALICE_1), []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
  });

  test('the sending device is excluded, its user\'s other devices are not', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(SENDER, 'device-1');
    await harness.offline(SENDER, 'device-2');
    await harness.offline(ALICE);

    const event = envelopeEvent({ senderDevice: 'device-1' });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients.sort(), [ALICE_1, `${SENDER}:device-2`].sort());
  });

  test('a server-authored event skips the whole actor, which has no device', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(SENDER, 'device-1');
    await harness.offline(SENDER, 'device-2');
    await harness.offline(ALICE);

    const event = envelopeEvent({ senderDevice: '' });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients, [ALICE_1]);
  });

  test('an offline device is queued with the exact push-frame bytes and woken', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
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
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE, 'device-1');
    await harness.offline(ALICE, 'device-2');

    await harness.worker.onMessage(envelopeEvent());

    assert.strictEqual((await harness.queue.drain(ALICE_1)).length, 1);
    assert.strictEqual((await harness.queue.drain(`${ALICE}:device-2`)).length, 1);
  });

  test('a device the registry has never seen gets no fanout', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(harness.wakeEvents(), []);
  });

  test('ephemeral envelopes are dropped for offline recipients, never queued', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    await harness.worker.onMessage(envelopeEvent({ ephemeral: true }));

    assert.deepStrictEqual(await harness.queue.drain(ALICE_1), []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
  });

  test('a DM or server event with explicit recipients bypasses membership', async () => {
    // channel-ms knows nothing about this channel: an empty member set would
    // mean no fanout at all if the explicit recipients were not honoured.
    const harness = startWorker({ members: new Map() });
    await harness.offline(ALICE);
    await harness.offline(BOB);

    const event = envelopeEvent({ channelId: 'channel-gone', recipients: [ALICE, BOB] });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients, [ALICE_1, BOB_1]);
    assert.strictEqual((await harness.queue.drain(ALICE_1)).length, 1);
    assert.strictEqual((await harness.queue.drain(BOB_1)).length, 1);
  });

  test('a channel with no members other than the sender fans out to nobody', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER]]]) });
    await harness.offline(SENDER);

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(harness.redis.published, []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
  });
});

describe('undelivered queue (SYNC_PROTOCOL §10.6, §19 decisions 1-2)', () => {
  test('drains in delivery_sequence order within a channel', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    await eachSeries([3, 1, 2], (deliverySequence) => harness.worker.onMessage(
      envelopeEvent({ opId: `op-${deliverySequence}`, deliverySequence })
    ));

    const frames = await harness.queue.drain(ALICE_1);
    const sequences = frames.map((frame) => Number(decodeWsEnvelope(frame).push.deliverySequence));
    assert.deepStrictEqual(sequences, [1, 2, 3]);
  });

  test('keeps each channel internally ordered when two channels interleave', async () => {
    const members = new Map([['channel-1', [SENDER, ALICE]], ['channel-2', [SENDER, ALICE]]]);
    const harness = startWorker({ members });
    await harness.offline(ALICE);

    const order = [['channel-1', 2], ['channel-2', 9], ['channel-1', 1], ['channel-2', 4]];
    await eachSeries(order, ([channelId, deliverySequence]) => harness.worker.onMessage(
      envelopeEvent({ opId: `op-${channelId}-${deliverySequence}`, channelId, deliverySequence })
    ));

    const drained = (await harness.queue.drain(ALICE_1))
      .map((frame) => decodeWsEnvelope(frame).push)
      .map((push) => [push.channelId, Number(push.deliverySequence)]);
    const seqFor = (channelId) => drained.filter(([id]) => id === channelId).map(([, seq]) => seq);
    assert.deepStrictEqual(seqFor('channel-1'), [1, 2]);
    assert.deepStrictEqual(seqFor('channel-2'), [4, 9]);
  });

  test('every queued frame is a decodable WS_PUSH envelope', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.offline(ALICE);

    await harness.worker.onMessage(envelopeEvent({ payload: Buffer.from([0x53, 0x01]) }));

    const [frame] = await harness.queue.drain(ALICE_1);
    const decoded = decodeWsEnvelope(frame);
    assert.strictEqual(decoded.type, WS_TYPE.WS_PUSH);
    assert.strictEqual(decoded.push.senderUserId, SENDER);
    assert.ok(decoded.push.payload.equals(Buffer.from([0x53, 0x01])));
  });

  test('the frame cap drops the oldest frames', async () => {
    const queue = new UndeliveredQueue({ redis: null, maxFrames: 3 });
    await eachSeries([1, 2, 3, 4, 5], (n) => queue.enqueue(ALICE_1, Buffer.from(`frame-${n}`)));

    const frames = await queue.drain(ALICE_1);
    assert.deepStrictEqual(frames.map(String), ['frame-3', 'frame-4', 'frame-5']);
  });

  test('a drain empties the queue', async () => {
    const queue = new UndeliveredQueue({ redis: null });
    await queue.enqueue(ALICE_1, Buffer.from('frame'));

    assert.strictEqual((await queue.drain(ALICE_1)).length, 1);
    assert.deepStrictEqual(await queue.drain(ALICE_1), []);
  });

  test('queues are per (user, device)', async () => {
    const queue = new UndeliveredQueue({ redis: null });
    await queue.enqueue(ALICE_1, Buffer.from('for-alice'));

    assert.deepStrictEqual(await queue.drain(BOB_1), []);
    assert.deepStrictEqual(await queue.drain(`${ALICE}:device-2`), []);
    assert.strictEqual((await queue.drain(ALICE_1)).length, 1);
  });
});
