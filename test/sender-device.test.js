const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../services/connection-gateway/ws-gateway');
const { LocalCache } = require('../libs/cache/local-cache');
const {
  EnvelopeEvent, ACK_OUTCOME, WS_TYPE, decodeWsEnvelope, encodeWsEnvelope, dmChannelId, toWire,
  uuidBytes, uuidText
} = require('../libs/v3-envelope');
const { DEVICE_1, DEVICE_2, mintOpId } = require('../services/connection-gateway/test/helper');

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
    const socket = { userId: ALICE, deviceId: DEVICE_1, remoteIp: '127.0.0.1' };
    // what decodeWsEnvelope hands the gateway, a forged sender device included
    const wire = decodeWsEnvelope(encodeWsEnvelope({
      type: WS_TYPE.WS_OP,
      ops: {
        envelopes: [{
          ...toWire({
            opId: mintOpId(ALICE), peer: BOB, payload: Buffer.from([0x45, 1, 2]), ephemeral, ttlSec: 15
          }),
          senderDeviceId: uuidBytes(DEVICE_2)
        }]
      }
    })).ops.envelopes[0];
    const ack = await gateway.processEnvelope(socket, wire);
    if (ephemeral) assert.equal(ack, null);
    else assert.equal(ack.outcome, ACK_OUTCOME.SUCCESS);
    assert.equal(published.length, 1);
    // across the bus and back, the server-side fields survive outside the wire
    const restored = EnvelopeEvent.fromBinary(published[0].toBinary());
    assert.equal(restored.envelope.senderUserId, ALICE);
    assert.equal(restored.envelope.channelId, dmChannelId(ALICE, BOB));
    assert.equal(restored.envelope.peer, BOB);
    assert.equal(restored.envelope.opId, uuidText(wire.opId));
    assert.equal(restored.senderDevice, DEVICE_1);
    const pushed = decodeWsEnvelope(restored.toPushFrame());
    assert.equal(uuidText(pushed.push.senderDeviceId), DEVICE_1);
    assert.deepEqual(pushed.push.peer, wire.peer);
    assert.equal(pushed.push.ttlSec, 15);
    assert.equal(pushed.push.ephemeral, ephemeral);
    assert.deepEqual(pushed.push.payload, Buffer.from([0x45, 1, 2]));
  });
}
