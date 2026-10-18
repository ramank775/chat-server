const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { initDefaultResources } = require('../../../libs/service-base');
const { initHttpResource } = require('../../../libs/http-service-base');
const { emptyQueue, closeQueues } = require('../../message-delivery/test/helper');
const { decodeWsEnvelope, pushFrame, WS_TYPE } = require('../../../libs/v3-envelope');
const { MessageMs } = require('../message-ms');

const ALICE = '00000000b';
const BOB = '00000000c';
/** The queue is keyed per `(user_id, device_id)` — TRIM_4_12_CONTRACT §7. */
const DEVICE = 'device-1';

/** Exactly the bytes message-delivery logs. */
function frameFor(channelId, n, offset) {
  return pushFrame({
    opId: `op-${channelId}-${n}`,
    channelId,
    payload: Buffer.from('chat'),
    senderUserId: '00000000a',
    serverTimestampMs: 1700000000000 + n,
    offset
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
    queue = await emptyQueue('message-ms-test');
    context.undeliveredQueue = queue;
    service = new MessageMs(context);
    await service.init();
    await service.server.ready();
  });

  after(async () => {
    await closeQueues();
    await service.shutdown();
  });

  const pull = (userId) => service.server.inject({
    method: 'GET',
    url: '/pending',
    headers: { 'x-user': userId, 'x-device': DEVICE }
  });

  const pullAfter = (userId, pointer) => service.server.inject({
    method: 'GET',
    url: `/pending?after=${pointer}`,
    headers: { 'x-user': userId, 'x-device': DEVICE }
  });

  /** Log one frame the way message-delivery does; its offset. */
  const log = async (userId, channelId, n, device = DEVICE) => {
    const offset = await queue.nextOffset();
    await queue.enqueue(`${userId}:${device}`, offset, frameFor(channelId, n, offset));
    return offset;
  };
  const opIdsOf = (response) => JSON.parse(response.payload).frames
    .map((frame) => decodeWsEnvelope(Buffer.from(frame, 'base64')).push.opId);

  test('returns base64 frames the client can decode, each with its offset', async () => {
    const offsets = [await log(ALICE, 'channel-1', 1), await log(ALICE, 'channel-1', 2)];

    const response = await pull(ALICE);
    assert.strictEqual(response.statusCode, 200);

    const { frames, more } = JSON.parse(response.payload);
    assert.strictEqual(more, false);
    // The client does exactly this: base64 -> WsEnvelope -> .push.
    const envelopes = frames.map((frame) => decodeWsEnvelope(Buffer.from(frame, 'base64')));
    assert.deepStrictEqual(envelopes.map((e) => e.type), [WS_TYPE.WS_PUSH, WS_TYPE.WS_PUSH]);
    assert.deepStrictEqual(envelopes.map((e) => e.push.opId), ['op-channel-1-1', 'op-channel-1-2']);
    assert.deepStrictEqual(envelopes.map((e) => e.push.offset), offsets);
  });

  test('a pull removes nothing; `after` is the device\'s pointer', async () => {
    const first = await log(BOB, 'channel-9', 1);
    const second = await log(BOB, 'channel-9', 2);

    assert.deepStrictEqual(opIdsOf(await pull(BOB)), ['op-channel-9-1', 'op-channel-9-2']);
    assert.deepStrictEqual(opIdsOf(await pull(BOB)), ['op-channel-9-1', 'op-channel-9-2'],
      'nothing was taken off the log');
    assert.deepStrictEqual(opIdsOf(await pullAfter(BOB, first)), ['op-channel-9-2']);
    assert.deepStrictEqual(JSON.parse((await pullAfter(BOB, second)).payload),
      { frames: [], more: false });
  });

  test('a page holds at most 500 frames and says more wait', async () => {
    const user = '00000000e';
    const offsets = [];
    await Array.from({ length: 501 }, (_, n) => n + 1).reduce(
      (previous, n) => previous.then(async () => { offsets.push(await log(user, 'channel-big', n)); }),
      Promise.resolve()
    );

    const first = JSON.parse((await pull(user)).payload);
    assert.strictEqual(first.frames.length, 500);
    assert.strictEqual(first.more, true);

    assert.deepStrictEqual(opIdsOf(await pullAfter(user, offsets[499])), ['op-channel-big-501']);
  });

  test('`after` must be a non-negative integer', async () => {
    assert.strictEqual((await pullAfter(ALICE, -1)).statusCode, 400);
    assert.strictEqual((await pullAfter(ALICE, 'x')).statusCode, 400);
  });

  test('a user with nothing logged gets an empty list, not an error', async () => {
    const response = await pull('00000000d');
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.payload), { frames: [], more: false });
  });

  test('another device of the same user keeps its own log', async () => {
    const user = '000000010';
    await log(user, 'channel-2', 1, 'device-2');

    assert.deepStrictEqual(opIdsOf(await pull(user)), []);
    assert.strictEqual((await queue.pending(`${user}:device-2`)).frames.length, 1);
  });

  test('a request without an identity header is rejected', async () => {
    const response = await service.server.inject({ method: 'GET', url: '/pending' });
    assert.strictEqual(response.statusCode, 400);
  });
});
