const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { initDefaultResources } = require('../../../libs/service-base');
const { initHttpResource } = require('../../../libs/http-service-base');
const { UndeliveredQueue } = require('../../../libs/delivery-manager/undelivered-queue');
const { decodeWsEnvelope, pushFrame, WS_TYPE } = require('../../../libs/v3-envelope');
const { MessageMs } = require('../message-ms');

const ALICE = '00000000b';
const BOB = '00000000c';
/** The queue is keyed per `(user_id, device_id)` — TRIM_4_12_CONTRACT §7. */
const DEVICE = 'device-1';
const subject = (userId) => `${userId}:${DEVICE}`;

/** Exactly the bytes message-delivery queues. */
function frameFor(channelId, n) {
  return pushFrame({
    opId: `op-${channelId}-${n}`,
    channelId,
    payload: Buffer.from('chat'),
    senderUserId: '00000000a',
    serverTimestampMs: 1700000000000 + n
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
    headers: { 'x-user': userId, 'x-device': DEVICE }
  });

  test('drains the queue and returns base64 frames the client can decode', async () => {
    const queued = [frameFor('channel-1', 1), frameFor('channel-1', 2)];
    await queue.enqueue(subject(ALICE), queued[0]);
    await queue.enqueue(subject(ALICE), queued[1]);

    const response = await pull(ALICE);
    assert.strictEqual(response.statusCode, 200);

    const { frames } = JSON.parse(response.payload);
    assert.strictEqual(frames.length, 2);
    // The client does exactly this: base64 -> WsEnvelope -> .push.
    const envelopes = frames.map((frame) => decodeWsEnvelope(Buffer.from(frame, 'base64')));
    assert.deepStrictEqual(envelopes.map((e) => e.type), [WS_TYPE.WS_PUSH, WS_TYPE.WS_PUSH]);
    assert.deepStrictEqual(envelopes.map((e) => e.push.opId), ['op-channel-1-1', 'op-channel-1-2']);
    assert.ok(Buffer.from(frames[0], 'base64').equals(queued[0]));
  });

  test('a second call returns an empty list', async () => {
    await queue.enqueue(subject(BOB), frameFor('channel-9', 1));

    assert.strictEqual(JSON.parse((await pull(BOB)).payload).frames.length, 1);
    assert.deepStrictEqual(JSON.parse((await pull(BOB)).payload), { frames: [] });
  });

  test('a user with nothing queued gets an empty list, not an error', async () => {
    const response = await pull('00000000d');
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.payload), { frames: [] });
  });

  test('frames come back in enqueue order; the client sorts by server_timestamp_ms', async () => {
    await [3, 1, 2].reduce(
      (previous, n) => previous.then(() => queue.enqueue(subject(ALICE), frameFor('channel-1', n))),
      Promise.resolve()
    );

    const { frames } = JSON.parse((await pull(ALICE)).payload);
    const opIds = frames.map((frame) => decodeWsEnvelope(Buffer.from(frame, 'base64')).push.opId);
    assert.deepStrictEqual(opIds, ['op-channel-1-3', 'op-channel-1-1', 'op-channel-1-2']);
  });

  test('another device of the same user keeps its own queue', async () => {
    await queue.enqueue(`${ALICE}:device-2`, frameFor('channel-2', 1));

    assert.deepStrictEqual(JSON.parse((await pull(ALICE)).payload), { frames: [] });
    assert.strictEqual((await queue.drain(`${ALICE}:device-2`)).length, 1);
  });

  test('a request without an identity header is rejected', async () => {
    const response = await service.server.inject({ method: 'GET', url: '/pending' });
    assert.strictEqual(response.statusCode, 400);
  });
});
