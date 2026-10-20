const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../services/connection-gateway/ws-gateway');
const { LocalCache } = require('../libs/cache/local-cache');
const { EnvelopeEvent, ACK_OUTCOME, decodeWsEnvelope, dmChannelId } = require('../libs/v3-envelope');
const { mintOpId } = require('../services/connection-gateway/test/helper');

const ALICE = 'a3f2e8c5d';
const BOB = 'b1c2d3e4f';

for (const ephemeral of [false, true]) { // eslint-disable-line no-restricted-syntax
  test(`gateway authenticates sender device on ${ephemeral ? 'ephemeral' : 'stored'} envelopes and preserves it on the wire`, async () => {
    const published = [];
    const gateway = new Gateway({
      options: {},
      events: { 'new-message': 'new-message' },
      eventStore: { emit: async (_topic, event) => published.push(event) },
      memCache: new LocalCache()
    });
    const socket = { userId: ALICE, deviceId: 'real-phone', remoteIp: '127.0.0.1' };
    const ack = await gateway.processEnvelope(socket, {
      opId: mintOpId(ALICE), channelId: dmChannelId(ALICE, BOB), peer: BOB,
      payload: Buffer.from([0x45, 1, 2]), ephemeral, ttlSec: 15,
      senderUserId: BOB, senderDeviceId: 'forged-phone'
    });
    if (ephemeral) assert.equal(ack, null);
    else assert.equal(ack.outcome, ACK_OUTCOME.SUCCESS);
    assert.equal(published.length, 1);
    const restored = EnvelopeEvent.fromBinary(published[0].toBinary());
    assert.equal(restored.envelope.senderUserId, ALICE);
    assert.equal(restored.envelope.senderDeviceId, socket.deviceId);
    assert.equal(restored.senderDevice, socket.deviceId);
    const pushed = decodeWsEnvelope(restored.toPushFrame());
    assert.equal(pushed.push.senderDeviceId, socket.deviceId);
    assert.equal(pushed.push.peer, BOB);
    assert.equal(pushed.push.ttlSec, 15);
    assert.deepEqual(pushed.push.payload, Buffer.from([0x45, 1, 2]));
  });
}
