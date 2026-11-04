const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { initDefaultResources } = require('../../../libs/service-base');
const { initHttpResource } = require('../../../libs/http-service-base');
const {
  idOf, nameOf, emptyQueue, closeQueues
} = require('../../message-delivery/test/helper');
const { DEVICE_1, DEVICE_2 } = require('../../connection-gateway/test/helper');
const {
  EnvelopeEvent, decodePendingPage, decodeWsEnvelope, uuidText
} = require('../../../libs/v3-envelope');
const { MessageMs } = require('../message-ms');

const ALICE = '00000000b';
const BOB = '00000000c';
/** The queue is keyed per `(user_id, device_id)` — TRIM_4_12_CONTRACT §7. */
const DEVICE = DEVICE_1;

/** The fanout message-delivery stores; `n` names its op (at most 16 bytes). */
function eventFor(channel, n, serverTimestampMs) {
  return EnvelopeEvent.of({
    opId: idOf(`${channel}-${n}`),
    channelId: idOf(channel),
    payload: Buffer.from('chat'),
    senderUserId: '00000000a',
    serverTimestampMs
  }, [], DEVICE_2);
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
  const store = async (recipients, channel, n, { sender = '00000000a', senderDevice = DEVICE_2 } = {}) => {
    clock += 1;
    const event = eventFor(channel, n, clock);
    await queue.append({
      opId: event.envelope.opId,
      ts: clock,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      recipients,
      sender,
      senderDevice,
      envelope: event.toEnvelopeBytes()
    });
    return clock;
  };
  /** The body as the client reads it: a PendingPage (decision 218). */
  const page = (response) => decodePendingPage(response.rawPayload);
  const opIdsOf = (response) => page(response).envelopes
    .map((envelope) => nameOf(uuidText(envelope.opId)));

  test('returns a PendingPage of envelopes exactly as a push carries them', async () => {
    await store([ALICE], 'ch-1', 1);
    await store([ALICE], 'ch-1', 2);

    const response = await pull(ALICE);
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.headers['content-type'], 'application/x-protobuf');

    const { envelopes, more } = page(response);
    assert.strictEqual(more, false);
    assert.deepStrictEqual(envelopes.map((e) => nameOf(uuidText(e.opId))), ['ch-1-1', 'ch-1-2']);
    assert.deepStrictEqual(envelopes[0], decodeWsEnvelope(eventFor('ch-1', 1, clock - 1).toPushFrame()).push);
  });

  test('a pull removes nothing; `since` is the device\'s pointer, inclusive', async () => {
    const first = await store([BOB], 'ch-9', 1);
    const second = await store([BOB], 'ch-9', 2);

    assert.deepStrictEqual(opIdsOf(await pull(BOB)), ['ch-9-1', 'ch-9-2']);
    assert.deepStrictEqual(opIdsOf(await pull(BOB)), ['ch-9-1', 'ch-9-2'],
      'nothing was taken off');
    assert.deepStrictEqual(opIdsOf(await pullSince(BOB, first)), ['ch-9-1', 'ch-9-2']);
    assert.deepStrictEqual(opIdsOf(await pullSince(BOB, second)), ['ch-9-2']);
    assert.deepStrictEqual(page(await pullSince(BOB, second + 1)), { envelopes: [], more: false });
  });

  test('a page holds at most 500 frames and says more wait', async () => {
    const user = '00000000e';
    const stamps = [];
    await Array.from({ length: 501 }, (_, n) => n + 1).reduce(
      (previous, n) => previous.then(async () => { stamps.push(await store([user], 'big', n)); }),
      Promise.resolve()
    );

    const first = page(await pull(user));
    assert.strictEqual(first.envelopes.length, 500);
    assert.strictEqual(first.more, true);

    assert.deepStrictEqual(opIdsOf(await pullSince(user, stamps[500])), ['big-501']);
  });

  test('`since` must be a non-negative integer', async () => {
    assert.strictEqual((await pullSince(ALICE, -1)).statusCode, 400);
    assert.strictEqual((await pullSince(ALICE, 'x')).statusCode, 400);
  });

  test('a user with nothing on the timeline gets an empty list, not an error', async () => {
    const response = await pull('00000000d');
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.rawPayload.length, 0, 'an empty PendingPage is zero bytes');
    assert.deepStrictEqual(page(response), { envelopes: [], more: false });
  });

  test('what a device sent itself is left out; the user\'s other devices get it', async () => {
    const user = '000000010';
    await store([user, '00000000a'], 'ch-2', 1, { sender: user, senderDevice: DEVICE });

    assert.deepStrictEqual(opIdsOf(await pull(user)), [], 'the sending device');
    assert.deepStrictEqual(opIdsOf(await pullSince(user, 0, DEVICE_2)), ['ch-2-1']);
  });

  test('a request without an identity header is rejected', async () => {
    const response = await service.server.inject({ method: 'GET', url: '/pending' });
    assert.strictEqual(response.statusCode, 400);
  });
});
