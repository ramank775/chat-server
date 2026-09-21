const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { initDefaultResources } = require('../../../libs/service-base');
const { initHttpResource } = require('../../../libs/http-service-base');
const { UndeliveredQueue } = require('../../../libs/delivery-manager/undelivered-queue');
const { decodeWsEnvelope, pushFrame, WS_TYPE } = require('../../../libs/v3-envelope');
const { MessageMs } = require('../message-ms');

const ALICE = '00000000b';
const BOB = '00000000c';

/** Exactly the bytes message-delivery queues. */
function frameFor(channelId, deliverySequence) {
  return pushFrame({
    opId: `op-${channelId}-${deliverySequence}`,
    channelId,
    resourceSeq: 1,
    payload: Buffer.from('chat'),
    senderUserId: '00000000a',
    serverTimestampMs: 1700000000000,
    deliverySequence
  });
}

describe('GET /sync/pending (SYNC_PROTOCOL §10.6)', () => {
  let service;
  let queue;

  before(async () => {
    let context = await initDefaultResources({
      port: 0,
      host: '127.0.0.1',
      logLevel: 'error',
      statsClient: 'statsd',
      appName: 'message-ms-test'
    });
    const noop = () => { };
    context.statsClient = {
      increment: noop, decrement: noop, gauge: noop, timing: noop
    };
    context = await initHttpResource(context);
    queue = new UndeliveredQueue({ redis: null });
    context.undeliveredQueue = queue;
    service = new MessageMs(context);
    await service.init();
    await service.server.ready();
  });

  after(async () => { await service.shutdown(); });

  const pull = (userId) => service.server.inject({
    method: 'GET',
    url: '/pending',
    headers: { 'x-user': userId, 'x-device': 'device-1' }
  });

  test('drains the queue and returns base64 frames the client can decode', async () => {
    const queued = [frameFor('channel-1', 1), frameFor('channel-1', 2)];
    await queue.enqueue(ALICE, queued[0]);
    await queue.enqueue(ALICE, queued[1]);

    const response = await pull(ALICE);
    assert.strictEqual(response.statusCode, 200);

    const { frames } = JSON.parse(response.payload);
    assert.strictEqual(frames.length, 2);
    // The client does exactly this: base64 -> WsEnvelope -> .push.
    const envelopes = frames.map((frame) => decodeWsEnvelope(Buffer.from(frame, 'base64')));
    assert.deepStrictEqual(envelopes.map((e) => e.type), [WS_TYPE.WS_PUSH, WS_TYPE.WS_PUSH]);
    assert.deepStrictEqual(
      envelopes.map((e) => Number(e.push.deliverySequence)),
      [1, 2]
    );
    assert.ok(Buffer.from(frames[0], 'base64').equals(queued[0]));
  });

  test('a second call returns an empty list', async () => {
    await queue.enqueue(BOB, frameFor('channel-9', 1));

    assert.strictEqual(JSON.parse((await pull(BOB)).payload).frames.length, 1);
    assert.deepStrictEqual(JSON.parse((await pull(BOB)).payload), { frames: [] });
  });

  test('a user with nothing queued gets an empty list, not an error', async () => {
    const response = await pull('00000000d');
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.payload), { frames: [] });
  });

  test('frames come back in delivery_sequence order per channel', async () => {
    await [3, 1, 2].reduce(
      (previous, sequence) => previous.then(() => queue.enqueue(ALICE, frameFor('channel-1', sequence))),
      Promise.resolve()
    );

    const { frames } = JSON.parse((await pull(ALICE)).payload);
    const sequences = frames.map(
      (frame) => Number(decodeWsEnvelope(Buffer.from(frame, 'base64')).push.deliverySequence)
    );
    assert.deepStrictEqual(sequences, [1, 2, 3]);
  });

  test('a request without an identity header is rejected', async () => {
    const response = await service.server.inject({ method: 'GET', url: '/pending' });
    assert.strictEqual(response.statusCode, 400);
  });
});
