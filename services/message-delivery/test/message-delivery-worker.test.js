const assert = require('node:assert');
const { test, describe } = require('node:test');
const { UndeliveredQueue } = require('../../../libs/delivery-manager/undelivered-queue');
const { decodeWsEnvelope, WS_TYPE } = require('../../../libs/v3-envelope');
const { envelopeEvent, startWorker, settle, eachSeries } = require('./helper');

const SENDER = '00000000a';
const ALICE = '00000000b';
const BOB = '00000000c';

describe('message-delivery fanout (SYNC_PROTOCOL §10.3)', () => {
  test('an online recipient is pushed to its gateway and never queued', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });
    await harness.online(ALICE);

    await harness.worker.onMessage(envelopeEvent());
    await settle();

    assert.strictEqual(harness.redis.published.length, 1);
    assert.strictEqual(harness.redis.published[0].channel, 'msg:gateway-1:0');
    assert.deepStrictEqual(await harness.queue.drain(ALICE), []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
  });

  test('the sender is excluded from its own fanout', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });

    const event = envelopeEvent();
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients, [ALICE]);
  });

  test('an offline recipient is queued with the exact push-frame bytes and woken', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });

    const event = envelopeEvent();
    await harness.worker.onMessage(event);

    const queued = await harness.queue.drain(ALICE);
    assert.strictEqual(queued.length, 1);
    assert.ok(queued[0].equals(event.toPushFrame()));

    const wakes = harness.wakeEvents();
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(wakes[0].key, ALICE, 'the wake event is keyed by user_id');
  });

  test('ephemeral envelopes are dropped for offline recipients, never queued', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });

    await harness.worker.onMessage(envelopeEvent({ ephemeral: true }));

    assert.deepStrictEqual(await harness.queue.drain(ALICE), []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
  });

  test('a server-authored event with explicit recipients bypasses membership', async () => {
    // channel-ms knows nothing about this channel: an empty member set would
    // mean no fanout at all if the explicit recipients were not honoured.
    const harness = startWorker({ members: new Map() });

    const event = envelopeEvent({ channelId: 'channel-gone', recipients: [ALICE, BOB] });
    await harness.worker.onMessage(event);

    assert.deepStrictEqual(event.recipients, [ALICE, BOB]);
    assert.strictEqual((await harness.queue.drain(ALICE)).length, 1);
    assert.strictEqual((await harness.queue.drain(BOB)).length, 1);
  });

  test('a channel with no members other than the sender fans out to nobody', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER]]]) });

    await harness.worker.onMessage(envelopeEvent());

    assert.deepStrictEqual(harness.redis.published, []);
    assert.deepStrictEqual(harness.wakeEvents(), []);
  });
});

describe('undelivered queue (SYNC_PROTOCOL §10.6, §19 decisions 1-2)', () => {
  test('drains in delivery_sequence order within a channel', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });

    await eachSeries([3, 1, 2], (deliverySequence) => harness.worker.onMessage(
      envelopeEvent({ opId: `op-${deliverySequence}`, deliverySequence })
    ));

    const frames = await harness.queue.drain(ALICE);
    const sequences = frames.map((frame) => Number(decodeWsEnvelope(frame).push.deliverySequence));
    assert.deepStrictEqual(sequences, [1, 2, 3]);
  });

  test('keeps each channel internally ordered when two channels interleave', async () => {
    const members = new Map([['channel-1', [SENDER, ALICE]], ['channel-2', [SENDER, ALICE]]]);
    const harness = startWorker({ members });

    const order = [['channel-1', 2], ['channel-2', 9], ['channel-1', 1], ['channel-2', 4]];
    await eachSeries(order, ([channelId, deliverySequence]) => harness.worker.onMessage(
      envelopeEvent({ opId: `op-${channelId}-${deliverySequence}`, channelId, deliverySequence })
    ));

    const drained = (await harness.queue.drain(ALICE))
      .map((frame) => decodeWsEnvelope(frame).push)
      .map((push) => [push.channelId, Number(push.deliverySequence)]);
    const seqFor = (channelId) => drained.filter(([id]) => id === channelId).map(([, seq]) => seq);
    assert.deepStrictEqual(seqFor('channel-1'), [1, 2]);
    assert.deepStrictEqual(seqFor('channel-2'), [4, 9]);
  });

  test('every queued frame is a decodable WS_PUSH envelope', async () => {
    const harness = startWorker({ members: new Map([['channel-1', [SENDER, ALICE]]]) });

    await harness.worker.onMessage(envelopeEvent({ payload: Buffer.from([0x53, 0x01]) }));

    const [frame] = await harness.queue.drain(ALICE);
    const decoded = decodeWsEnvelope(frame);
    assert.strictEqual(decoded.type, WS_TYPE.WS_PUSH);
    assert.strictEqual(decoded.push.senderUserId, SENDER);
    assert.ok(decoded.push.payload.equals(Buffer.from([0x53, 0x01])));
  });

  test('the frame cap drops the oldest frames', async () => {
    const queue = new UndeliveredQueue({ redis: null, maxFrames: 3 });
    await eachSeries([1, 2, 3, 4, 5], (n) => queue.enqueue(ALICE, Buffer.from(`frame-${n}`)));

    const frames = await queue.drain(ALICE);
    assert.deepStrictEqual(frames.map(String), ['frame-3', 'frame-4', 'frame-5']);
  });

  test('a drain empties the queue', async () => {
    const queue = new UndeliveredQueue({ redis: null });
    await queue.enqueue(ALICE, Buffer.from('frame'));

    assert.strictEqual((await queue.drain(ALICE)).length, 1);
    assert.deepStrictEqual(await queue.drain(ALICE), []);
  });

  test('queues are per user', async () => {
    const queue = new UndeliveredQueue({ redis: null });
    await queue.enqueue(ALICE, Buffer.from('for-alice'));

    assert.deepStrictEqual(await queue.drain(BOB), []);
    assert.strictEqual((await queue.drain(ALICE)).length, 1);
  });
});
