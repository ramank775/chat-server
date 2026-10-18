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

/** Exactly the bytes message-delivery stores. */
function frameFor(channelId, n, serverTimestampMs) {
  return pushFrame({
    opId: `op-${channelId}-${n}`,
    channelId,
    payload: Buffer.from('chat'),
    senderUserId: '00000000a',
    serverTimestampMs
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

  const pullSince = (userId, pointer, device = DEVICE) => service.server.inject({
    method: 'GET',
    url: `/pending?since=${pointer}`,
    headers: { 'x-user': userId, 'x-device': device }
  });

  /** Store one fanout the way message-delivery does. */
  let clock = 1700000000000;
  const store = async (recipients, channelId, n, { sender = '00000000a', senderDevice = 'd-a' } = {}) => {
    clock += 1;
    const frame = frameFor(channelId, n, clock);
    await queue.append({
      opId: `op-${channelId}-${n}`, ts: clock, recipients, sender, senderDevice, frame
    });
    return clock;
  };
  const opIdsOf = (response) => JSON.parse(response.payload).frames
    .map((frame) => decodeWsEnvelope(Buffer.from(frame, 'base64')).push.opId);

  test('returns base64 frames the client can decode', async () => {
    await store([ALICE], 'channel-1', 1);
    await store([ALICE], 'channel-1', 2);

    const response = await pull(ALICE);
    assert.strictEqual(response.statusCode, 200);

    const { frames, more } = JSON.parse(response.payload);
    assert.strictEqual(more, false);
    // The client does exactly this: base64 -> WsEnvelope -> .push.
    const envelopes = frames.map((frame) => decodeWsEnvelope(Buffer.from(frame, 'base64')));
    assert.deepStrictEqual(envelopes.map((e) => e.type), [WS_TYPE.WS_PUSH, WS_TYPE.WS_PUSH]);
    assert.deepStrictEqual(envelopes.map((e) => e.push.opId), ['op-channel-1-1', 'op-channel-1-2']);
  });

  test('a pull removes nothing; `since` is the device\'s pointer, inclusive', async () => {
    const first = await store([BOB], 'channel-9', 1);
    const second = await store([BOB], 'channel-9', 2);

    assert.deepStrictEqual(opIdsOf(await pull(BOB)), ['op-channel-9-1', 'op-channel-9-2']);
    assert.deepStrictEqual(opIdsOf(await pull(BOB)), ['op-channel-9-1', 'op-channel-9-2'],
      'nothing was taken off');
    assert.deepStrictEqual(opIdsOf(await pullSince(BOB, first)), ['op-channel-9-1', 'op-channel-9-2']);
    assert.deepStrictEqual(opIdsOf(await pullSince(BOB, second)), ['op-channel-9-2']);
    assert.deepStrictEqual(JSON.parse((await pullSince(BOB, second + 1)).payload),
      { frames: [], more: false });
  });

  test('a page holds at most 500 frames and says more wait', async () => {
    const user = '00000000e';
    const stamps = [];
    await Array.from({ length: 501 }, (_, n) => n + 1).reduce(
      (previous, n) => previous.then(async () => { stamps.push(await store([user], 'channel-big', n)); }),
      Promise.resolve()
    );

    const first = JSON.parse((await pull(user)).payload);
    assert.strictEqual(first.frames.length, 500);
    assert.strictEqual(first.more, true);

    assert.deepStrictEqual(opIdsOf(await pullSince(user, stamps[500])), ['op-channel-big-501']);
  });

  test('`since` must be a non-negative integer', async () => {
    assert.strictEqual((await pullSince(ALICE, -1)).statusCode, 400);
    assert.strictEqual((await pullSince(ALICE, 'x')).statusCode, 400);
  });

  test('a user with nothing on the timeline gets an empty list, not an error', async () => {
    const response = await pull('00000000d');
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.payload), { frames: [], more: false });
  });

  test('what a device sent itself is left out; the user\'s other devices get it', async () => {
    const user = '000000010';
    await store([user, '00000000a'], 'channel-2', 1, { sender: user, senderDevice: DEVICE });

    assert.deepStrictEqual(opIdsOf(await pull(user)), [], 'the sending device');
    assert.deepStrictEqual(opIdsOf(await pullSince(user, 0, 'device-2')), ['op-channel-2-1']);
  });

  test('a request without an identity header is rejected', async () => {
    const response = await service.server.inject({ method: 'GET', url: '/pending' });
    assert.strictEqual(response.statusCode, 400);
  });
});
