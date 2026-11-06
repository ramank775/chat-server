const test = require('node:test');
const assert = require('node:assert');
const {
  ACK_OUTCOME,
  REASON,
  WS_TYPE,
  EnvelopeEvent,
  encodeWsEnvelope,
  decodeWsEnvelope,
  opIdUserBits,
  dmChannelId,
  toWire,
  uuidBytes,
  uuidText,
  userIdBytes,
  userIdText
} = require('../../../libs/v3-envelope');
const {
  ACCESSKEY, DEVICE_1, DEVICE_2, mintOpId, opFrame, legacyWire, onWire, startGateway, connect
} = require('./helper');

const ALICE = 'a3f2e8c5d';
const BOB = 'b1c2d3e4f';
const CHANNEL = '01efabcd-7000-8000-8abc-000000000001';
const CARL = 'c2d3e4f5a';
/** A group nobody here is a member of. */
const OTHER_CHANNEL = '01efabcd-7000-8000-8abc-0000000000ff';
/** No row anywhere: a DM id is derived from the pair (TRIM_4_12_CONTRACT §1). */
const DM = dmChannelId(ALICE, BOB);

const payload = (byte = 0x08) => Buffer.from([byte, 0x01, 0x02]);

/** `n` only makes the op_id unique. */
function envelope(userId, n, extra = {}) {
  const { rand = n, ...fields } = extra;
  return {
    opId: mintOpId(userId, { counter: n, rand }),
    channelId: CHANNEL,
    payload: payload(),
    ...fields
  };
}

/** Run `fn` against a freshly started gateway and always tear it down. */
async function withGateway(fn, overrides) {
  const harness = await startGateway(overrides);
  harness.addChannel(CHANNEL, [ALICE, BOB]);
  try {
    await fn(harness);
  } finally {
    await harness.stop();
  }
}

test('mintOpId round-trips through the server-side prefix reader', () => {
  assert.strictEqual(opIdUserBits(mintOpId(ALICE)), parseInt(ALICE, 16));
  assert.notStrictEqual(opIdUserBits(mintOpId(BOB)), parseInt(ALICE, 16));
});

test('the edge helpers take exact lengths only and round-trip the text forms', () => {
  assert.strictEqual(uuidText(uuidBytes(CHANNEL)), CHANNEL);
  [0, 15, 17].forEach((n) => assert.strictEqual(uuidText(Buffer.alloc(n)), null, `${n} bytes`));
  assert.strictEqual(userIdText(userIdBytes(ALICE)), ALICE);
  assert.deepStrictEqual(userIdBytes(ALICE), Buffer.from('0a3f2e8c5d', 'hex'), 'big-endian, one 0 nibble');
  [0, 4, 6].forEach((n) => assert.strictEqual(userIdText(Buffer.alloc(n)), null, `${n} bytes`));
  assert.strictEqual(userIdText(Buffer.from('f000000000', 'hex')), null, 'past 36 bits');
  // what the server encodes it made itself: anything else is a bug, loudly
  assert.throws(() => uuidBytes('device-1'), TypeError);
  assert.throws(() => uuidBytes(CHANNEL.toUpperCase()), TypeError);
  assert.throws(() => userIdBytes('A3F2E8C5D'), TypeError);
});

test('echoes the accesskey subprotocol on the 101', async () => {
  await withGateway(async ({ uri }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    assert.strictEqual(client.protocol, `accesskey.${ACCESSKEY}`);
    client.close();
  });
});

test('binds the socket to the authenticated user and device', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    // a sender_device_id from the client is not believed
    client.send(opFrame([{ ...toWire(envelope(ALICE, 1)), senderDeviceId: uuidBytes(DEVICE_2) }]));
    const frame = await client.next();

    assert.strictEqual(frame.type, WS_TYPE.WS_ACK);
    assert.strictEqual(frame.acks.acks.length, 1);
    assert.strictEqual(frame.acks.acks[0].outcome, ACK_OUTCOME.SUCCESS);
    assert.ok(frame.acks.acks[0].serverTimestampMs > 0);

    const [published] = publishedEnvelopes();
    assert.strictEqual(published.key, CHANNEL);
    assert.strictEqual(published.args.envelope.senderUserId, ALICE);
    assert.strictEqual(published.args.senderDevice, DEVICE_1);
    assert.deepStrictEqual(
      decodeWsEnvelope(published.args.toPushFrame()).push.senderDeviceId, uuidBytes(DEVICE_1)
    );
    assert.strictEqual(
      published.args.envelope.serverTimestampMs, frame.acks.acks[0].serverTimestampMs
    );
    client.close();
  });
});

test('a batch over 20 envelopes is rejected envelope by envelope', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    const envelopes = Array.from({ length: 21 }, (_, i) => envelope(ALICE, i + 1));
    client.send(opFrame(envelopes));

    const frame = await client.next();
    assert.strictEqual(frame.acks.acks.length, 21);
    frame.acks.acks.forEach((ack) => {
      assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT);
      assert.strictEqual(ack.reason, REASON.VALIDATION_FAILED);
    });
    assert.strictEqual(publishedEnvelopes().length, 0);
    client.close();
  });
});

test('op_id minted for another user is prefix_mismatch', async () => {
  await withGateway(async ({ uri }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(opFrame([envelope(ALICE, 1, { opId: mintOpId(BOB) })]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.strictEqual(ack.reason, REASON.PREFIX_MISMATCH);
    client.close();
  });
});

test('a text-era frame from an older build fails cleanly as validation_failed', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    // decision 218: string op_id/channel_id/peer (fields 1, 2, 7) are reserved
    client.send(legacyWire.opFrame([{
      opId: mintOpId(ALICE), channelId: CHANNEL, clientTimestampMs: Date.now(), payload: payload()
    }]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.strictEqual(ack.reason, REASON.VALIDATION_FAILED);
    assert.strictEqual(publishedEnvelopes().length, 0);
    client.close();
  });
});

test('a replayed op_id returns the stored ack and is not re-processed', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    const env = envelope(ALICE, 1);

    client.send(opFrame([env]));
    const first = (await client.next()).acks.acks[0];

    client.send(opFrame([env]));
    const replay = (await client.next()).acks.acks[0];

    assert.deepStrictEqual(replay, first);
    assert.strictEqual(publishedEnvelopes().length, 1);
    client.close();
  });
});

test('a permanent reject replays identically too', async () => {
  await withGateway(async ({ uri }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    const env = envelope(ALICE, 1, { channelId: OTHER_CHANNEL });

    client.send(opFrame([env]));
    const first = (await client.next()).acks.acks[0];
    client.send(opFrame([env]));
    const replay = (await client.next()).acks.acks[0];

    assert.strictEqual(first.reason, REASON.FORBIDDEN);
    assert.deepStrictEqual(replay, first);
    client.close();
  });
});

test('a non-member gets forbidden', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(opFrame([envelope(ALICE, 1, { channelId: OTHER_CHANNEL })]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.strictEqual(ack.reason, REASON.FORBIDDEN);
    assert.strictEqual(publishedEnvelopes().length, 0);
    client.close();
  });
});

// ---- derived DM channels (TRIM_4_12_CONTRACT §3) --------------------------

test('a DM envelope needs no channel row and fans out to the peer', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    // the app sends the peer and no channel: toWire drops a DM's channel id
    client.send(opFrame([envelope(ALICE, 1, { peer: BOB })]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.SUCCESS);

    const [published] = publishedEnvelopes();
    // the channel is derived from the pair, inside the server only
    assert.strictEqual(published.key, DM);
    assert.strictEqual(published.args.envelope.channelId, DM);
    assert.strictEqual(published.args.envelope.peer, BOB);
    // spelled out by the gateway: message-delivery must not look for a row.
    // The sender is in the list so their other devices get it (§8).
    assert.deepStrictEqual(published.args.recipients, [BOB, ALICE]);
    const { push } = onWire(published.args.toPushFrame());
    assert.deepStrictEqual(push.peer, userIdBytes(BOB), 'the peer is echoed on fanout');
    assert.strictEqual(push.channelId, undefined, 'a DM channel is never on the wire');
    client.close();
  });
});

// ---- the invite gate (decisions 219, 220; SYNC_PROTOCOL §21) -------------

test('a DM between two people who have not connected is refused not_connected', async () => {
  await withGateway(async ({
    uri, publishedEnvelopes, setVerdict, gateAsked
  }) => {
    setVerdict(ALICE, BOB, 'not_connected');
    const client = connect(uri, ALICE);
    await client.opened;
    // class KEY (3), SILENT: the class is what the gate is asked about
    client.send(opFrame([envelope(ALICE, 1, { peer: BOB, flags: 7 })]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.strictEqual(ack.reason, REASON.NOT_CONNECTED);
    assert.strictEqual(publishedEnvelopes().length, 0);
    assert.deepStrictEqual(gateAsked, [{ from: ALICE, to: BOB, cls: 3 }]);
    client.close();
  });
});

test('a blocked sender is acked as usual and relayed nowhere', async () => {
  await withGateway(async ({ uri, publishedEnvelopes, setVerdict }) => {
    setVerdict(ALICE, BOB, 'blocked');
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(opFrame([
      envelope(ALICE, 0, { peer: BOB, ephemeral: true }),
      envelope(ALICE, 1, { peer: BOB })
    ]));

    const { acks } = (await client.next()).acks;
    assert.strictEqual(acks.length, 1, 'typing is never acked');
    assert.strictEqual(acks[0].outcome, ACK_OUTCOME.SUCCESS);
    assert.ok(acks[0].serverTimestampMs > 0);
    assert.strictEqual(publishedEnvelopes().length, 0);
    client.close();
  });
});

test('a group frame never asks the invite gate', async () => {
  await withGateway(async ({ uri, gateAsked }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(opFrame([envelope(ALICE, 1)]));
    assert.strictEqual((await client.next()).acks.acks[0].outcome, ACK_OUTCOME.SUCCESS);
    assert.deepStrictEqual(gateAsked, []);
    client.close();
  });
});

test('a DM names a peer and no channel_id, a group the reverse; anything else is validation_failed', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    const group = toWire(envelope(ALICE, 1));
    const both = { ...toWire(envelope(ALICE, 2)), peer: userIdBytes(BOB) };
    const { channelId: _, ...neither } = toWire(envelope(ALICE, 3));
    assert.ok(group.channelId && !group.peer);
    client.send(opFrame([both, neither]));

    const { acks } = (await client.next()).acks;
    assert.deepStrictEqual(acks.map((ack) => ack.reason), [
      REASON.VALIDATION_FAILED, REASON.VALIDATION_FAILED
    ]);
    assert.deepStrictEqual(acks.map((ack) => ack.outcome), [
      ACK_OUTCOME.PERMANENT, ACK_OUTCOME.PERMANENT
    ]);
    assert.strictEqual(publishedEnvelopes().length, 0);
    client.close();
  });
});

test('an id of the wrong length is validation_failed, and its ack names the bytes sent', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    const good = toWire(envelope(ALICE, 1));
    const cases = [
      { ...good, opId: good.opId.subarray(0, 15) },
      { ...toWire(envelope(ALICE, 2)), channelId: good.channelId.subarray(0, 15) },
      { ...toWire(envelope(ALICE, 3)), channelId: Buffer.concat([good.channelId, Buffer.from([0])]) },
      { ...toWire(envelope(ALICE, 4, { peer: BOB })), peer: userIdBytes(BOB).subarray(1) },
      // five bytes, but past 36 bits: no user_id has that top nibble
      { ...toWire(envelope(ALICE, 5, { peer: BOB })), peer: Buffer.from('1b1c2d3e4f', 'hex') }
    ];
    client.send(opFrame(cases));

    const { acks } = (await client.next()).acks;
    assert.strictEqual(acks.length, cases.length);
    acks.forEach((ack, index) => {
      assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT, `case ${index}`);
      assert.strictEqual(ack.reason, REASON.VALIDATION_FAILED, `case ${index}`);
      assert.deepStrictEqual(ack.opId, cases[index].opId, `case ${index}`);
    });
    assert.strictEqual(publishedEnvelopes().length, 0);
    client.close();
  });
});

test('a session whose device id is no UUID cannot send: it could not be stamped', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE, 'not-a-uuid');
    await client.opened;
    client.send(opFrame([envelope(ALICE, 1)]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.reason, REASON.VALIDATION_FAILED);
    assert.strictEqual(publishedEnvelopes().length, 0);
    client.close();
  });
});

test('a third party cannot send on somebody else\'s DM: the pair derives another channel', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, CARL);
    await client.opened;
    // carl's own user_id is half of whatever channel his peer derives to,
    // so alice+bob's channel is unrepresentable
    client.send(opFrame([envelope(CARL, 1, { peer: BOB })]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.SUCCESS);
    const [published] = publishedEnvelopes();
    assert.strictEqual(published.args.envelope.channelId, dmChannelId(CARL, BOB));
    assert.notStrictEqual(published.args.envelope.channelId, DM);
    assert.deepStrictEqual(published.args.recipients, [BOB, CARL]);
    client.close();
  });
});

test('a 0x53 payload from a client is rejected as validation_failed', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(opFrame([envelope(ALICE, 1, { payload: Buffer.from([0x53, 0x08, 0x01]) })]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.strictEqual(ack.reason, REASON.VALIDATION_FAILED);
    assert.strictEqual(publishedEnvelopes().length, 0);
    client.close();
  });
});

test('the ack echoes the op_id bytes; the fanout encodes nothing at its default', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    const before = Date.now();
    const sent = [envelope(ALICE, 1), envelope(ALICE, 2)];

    client.send(opFrame(sent));
    const frame = await client.next();
    const { acks } = onWire(frame.raw).acks;
    const pushes = publishedEnvelopes().map(({ args }) => onWire(args.toPushFrame()).push);

    assert.strictEqual(acks.length, 2);
    acks.forEach((ack, index) => {
      assert.deepStrictEqual(Object.keys(ack).sort(), ['opId', 'outcome', 'serverTimestampMs']);
      assert.deepStrictEqual(ack.opId, uuidBytes(sent[index].opId), 'the op_id as sent');
      assert.ok(ack.serverTimestampMs >= before);
      assert.strictEqual(pushes[index].serverTimestampMs, ack.serverTimestampMs);
      // decision 218: no sender, no client clock, no flags/ttl/ephemeral unset
      assert.deepStrictEqual(Object.keys(pushes[index]).sort(), [
        'channelId', 'opId', 'payload', 'senderDeviceId', 'serverTimestampMs'
      ]);
      assert.deepStrictEqual(pushes[index].channelId, uuidBytes(CHANNEL));
    });
    client.close();
  });
});

test('over the rate limit the ack is transient rate_limited with a retry hint', async () => {
  await withGateway(async ({ uri }) => {
    const client = connect(uri, ALICE);
    await client.opened;

    let limited = null;
    for (let frame = 0; frame < 6 && !limited; frame += 1) {
      const envelopes = Array.from({ length: 20 }, (_, i) => envelope(ALICE, frame * 20 + i + 1));
      client.send(opFrame(envelopes));
      // eslint-disable-next-line no-await-in-loop
      const { acks } = (await client.next()).acks;
      limited = acks.find((ack) => ack.reason === REASON.RATE_LIMITED);
    }

    assert.ok(limited, 'expected a rate_limited ack within 120 envelopes');
    assert.strictEqual(limited.outcome, ACK_OUTCOME.TRANSIENT);
    assert.ok(limited.retryAfterMs > 0);
    client.close();
  });
});

test('a fanout envelope is pushed to the recipient device, not to the user', async () => {
  await withGateway(async ({ uri, gateway }) => {
    const bob = connect(uri, BOB, 'device-1');
    const bobLaptop = connect(uri, BOB, 'device-2');
    await Promise.all([bob.opened, bobLaptop.opened]);

    const stamped = {
      opId: mintOpId(ALICE),
      channelId: CHANNEL,
      payload: payload(),
      senderUserId: ALICE,
      serverTimestampMs: 1700000000123
    };
    // delivery keys per `(user_id, device_id)`: only device-1 is addressed
    const offline = gateway.messageHandler(
      EnvelopeEvent.of(stamped, [`${BOB}:device-1`, 'c0ffee123:device-1'])
    );

    const frame = await bob.next();
    assert.strictEqual(frame.type, WS_TYPE.WS_PUSH);
    assert.deepStrictEqual(frame.push.opId, uuidBytes(stamped.opId));
    assert.strictEqual(frame.push.serverTimestampMs, 1700000000123);
    // Every subject we could not reach comes back for the undelivered queue.
    assert.deepStrictEqual(offline, ['c0ffee123:device-1']);
    // bob's other device was not a recipient, so it saw nothing
    await assert.rejects(() => bobLaptop.next(300));
    bob.close();
    bobLaptop.close();
  });
});

/** A server-stamped fanout envelope for `subjects`, as delivery-manager hands it over. */
const fanout = (gateway, subjects) => gateway.messageHandler(EnvelopeEvent.of({
  opId: mintOpId(ALICE),
  channelId: CHANNEL,
  payload: payload(),
  senderUserId: ALICE,
  serverTimestampMs: 1700000000123
}, subjects));

test('heartbeat: a socket that misses a ping is terminated, and woken for an unconfirmed push', async () => {
  await withGateway(async (harness) => {
    const alice = connect(harness.uri, ALICE, 'device-1');
    // a phone that went out of coverage: the socket is there, nothing answers
    const bob = connect(harness.uri, BOB, 'device-1', undefined, { autoPong: false });
    await Promise.all([alice.opened, bob.opened]);
    fanout(harness.gateway, [`${ALICE}:device-1`, `${BOB}:device-1`]);
    await Promise.all([alice.next(), bob.next()]);

    harness.gateway.heartbeat();
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    harness.gateway.heartbeat();

    assert.strictEqual((await bob.closed).code, 1006, 'terminated, no close handshake');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.deepStrictEqual(harness.wakes().map((w) => w.key), [`${BOB}:device-1`],
      'the push into the dead socket may be lost: wake bob to pull it');
    assert.strictEqual(alice.socket.readyState, 1, 'alice answered: still open');
    alice.close();
  });
});

test('no wake when the pushes were confirmed by a pong, or the client closed itself', async () => {
  await withGateway(async (harness) => {
    const alice = connect(harness.uri, ALICE, 'device-1');
    const bob = connect(harness.uri, BOB, 'device-1');
    await Promise.all([alice.opened, bob.opened]);
    fanout(harness.gateway, [`${ALICE}:device-1`, `${BOB}:device-1`]);
    await Promise.all([alice.next(), bob.next()]);

    // alice's pong confirms the push; then her socket dies all the same
    harness.gateway.heartbeat();
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    alice.socket.terminate();
    // bob never pongs before leaving, but he closes the socket himself
    bob.close();
    await Promise.all([alice.closed, bob.closed]);
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    assert.deepStrictEqual(harness.wakes(), []);
  });
});

test('a text frame that is not the keepalive is a protocol error', async () => {
  await withGateway(async ({ uri }) => {
    const client = connect(uri, ALICE);
    await client.opened;

    client.send('ping');
    assert.strictEqual(await client.next(), 'pong');

    client.send('{"hello":"v2"}');
    const frame = await client.next();
    assert.strictEqual(frame.type, WS_TYPE.WS_ERROR);
    assert.strictEqual(frame.error.code, 'VALIDATION_FAILED');
    assert.strictEqual((await client.closed).code, 1002);
  });
});

test('a server-only WsType from a client is a protocol error', async () => {
  await withGateway(async ({ uri }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(encodeWsEnvelope({ type: WS_TYPE.WS_PUSH, push: toWire(envelope(ALICE, 1)) }));

    const frame = await client.next();
    assert.strictEqual(frame.type, WS_TYPE.WS_ERROR);
    assert.strictEqual(frame.error.code, 'VALIDATION_FAILED');
    assert.strictEqual((await client.closed).code, 1002);
  });
});

test('revoke sends WS_REAUTH_REQUIRED then closes with the mapped code', async () => {
  const cases = [
    ['expired', 4001, 'accesskey_expired'],
    ['revoked', 4002, 'session_revoked'],
    ['rebind', 4003, 'phone_rebind']
  ];
  await withGateway(async ({ uri, gateway }) => {
    for (let i = 0; i < cases.length; i += 1) {
      const [reason, code, closeReason] = cases[i];
      // eslint-disable-next-line no-await-in-loop
      const client = connect(uri, ALICE, `device-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await client.opened;

      // eslint-disable-next-line no-await-in-loop
      const response = await gateway.server.inject({
        method: 'POST',
        url: '/_internal/sessions/revoke',
        payload: { user_id: ALICE, deviceId: `device-${i}`, reason }
      });
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.json().sessions, 1);

      // eslint-disable-next-line no-await-in-loop
      const frame = await client.next();
      assert.strictEqual(frame.type, WS_TYPE.WS_REAUTH_REQUIRED);
      assert.strictEqual(frame.reauthRequired, true);

      // eslint-disable-next-line no-await-in-loop
      const closed = await client.closed;
      assert.strictEqual(closed.code, code);
      assert.strictEqual(closed.reason, closeReason);
    }
  });
});

test('revoke without a deviceId hits every socket of the user', async () => {
  await withGateway(async ({ uri, gateway }) => {
    const first = connect(uri, ALICE, 'device-a');
    const second = connect(uri, ALICE, 'device-b');
    await Promise.all([first.opened, second.opened]);

    const response = await gateway.server.inject({
      method: 'POST',
      url: '/_internal/sessions/revoke',
      payload: { user_id: ALICE, reason: 'revoked' }
    });
    assert.strictEqual(response.json().sessions, 2);
    assert.strictEqual((await first.next()).type, WS_TYPE.WS_REAUTH_REQUIRED);
    assert.strictEqual((await second.next()).type, WS_TYPE.WS_REAUTH_REQUIRED);
    assert.strictEqual((await first.closed).code, 4002);
    assert.strictEqual((await second.closed).code, 4002);
  });
});

test('a second socket for the same device replaces the first with close 1000', async () => {
  await withGateway(async ({ uri, gateway }) => {
    const first = connect(uri, ALICE, 'device-1');
    await first.opened;
    const second = connect(uri, ALICE, 'device-1');
    await second.opened;

    const closed = await first.closed;
    assert.strictEqual(closed.code, 1000);
    assert.strictEqual(closed.reason, 'replaced');
    assert.strictEqual(gateway.userSessions.get(ALICE).size, 1);

    // The survivor is still the one that receives pushes.
    const stamped = {
      opId: mintOpId(ALICE),
      channelId: CHANNEL,
      payload: payload(),
      senderUserId: BOB,
      serverTimestampMs: Date.now()
    };
    assert.deepStrictEqual(
      gateway.messageHandler(EnvelopeEvent.of(stamped, [`${ALICE}:device-1`])), []
    );
    assert.strictEqual((await second.next()).type, WS_TYPE.WS_PUSH);
    second.close();
  });
});

test('connect and disconnect publish the connection-state event keyed by user_id', async () => {
  await withGateway(async ({ uri, published }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    client.close();
    await client.closed;
    // The disconnect publish happens off the close event; give it a tick.
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    const states = published.filter((p) => p.topic === 'connection-state');
    assert.strictEqual(states.length, 2);
    assert.deepStrictEqual(states.map((s) => s.key), [ALICE, ALICE]);
    assert.strictEqual(states[0].args.user, ALICE);
    assert.strictEqual(states[0].args.state, 'CONNECTED');
    assert.strictEqual(states[1].args.state, 'DISCONNECTED');
  });
});

test('an ephemeral envelope is fanned out without an ack', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;

    client.send(opFrame([envelope(ALICE, 0, { ephemeral: true })]));
    // No ack is due, so prove the frame landed by following it with one that is.
    client.send(opFrame([envelope(ALICE, 1)]));
    const frame = await client.next();

    assert.strictEqual(frame.acks.acks.length, 1);
    assert.strictEqual(frame.acks.acks[0].outcome, ACK_OUTCOME.SUCCESS);
    const envelopes = publishedEnvelopes();
    assert.strictEqual(envelopes.length, 2);
    assert.strictEqual(envelopes[0].args.envelope.ephemeral, true);
    client.close();
  });
});

test('envelope flags reach the fanout as sent, bits the server does not know included', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;

    // 33: SILENT (bit 0) plus bit 5, one a newer client might set (decision 215)
    client.send(opFrame([envelope(ALICE, 0, { flags: 33 })]));
    const frame = await client.next();

    assert.strictEqual(frame.acks.acks[0].outcome, ACK_OUTCOME.SUCCESS);
    const [published] = publishedEnvelopes();
    assert.strictEqual(published.args.envelope.flags, 33);
    assert.strictEqual(decodeWsEnvelope(published.args.toPushFrame()).push.flags, 33);
    assert.strictEqual(published.args.wakes, false);
    client.close();
  });
});

test('POST /ops takes a WS_OP frame over https and answers with its WS_ACK', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const post = (frame) => fetch(`${uri}/ops`, {
      method: 'POST',
      // what nginx sets after the `/auth` subrequest
      headers: { 'content-type': 'application/json', 'x-user': ALICE, 'x-device': DEVICE_2 },
      body: JSON.stringify({ frame: frame.toString('base64') })
    });
    const env = envelope(ALICE, 1, { peer: BOB });

    const response = await post(opFrame([env]));
    assert.strictEqual(response.status, 200);
    const reply = decodeWsEnvelope(Buffer.from((await response.json()).frame, 'base64'));
    assert.strictEqual(reply.type, WS_TYPE.WS_ACK);
    const [ack] = reply.acks.acks;
    assert.strictEqual(uuidText(ack.opId), env.opId);
    assert.strictEqual(ack.outcome, ACK_OUTCOME.SUCCESS);
    const [published] = publishedEnvelopes();
    assert.strictEqual(published.args.envelope.senderUserId, ALICE);
    assert.strictEqual(published.args.senderDevice, DEVICE_2);

    // one dedup window with the socket: the same op there is the stored ack
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(opFrame([env]));
    assert.deepStrictEqual((await client.next()).acks.acks[0], ack);
    assert.strictEqual(publishedEnvelopes().length, 1);
    client.close();

    // a frame that is not a WS_OP is refused whole
    assert.strictEqual((await post(Buffer.from('not a frame'))).status, 400);
    assert.strictEqual((await post(encodeWsEnvelope({ type: WS_TYPE.WS_ACK }))).status, 400);
  });
});

test('a binary frame that is not a WsEnvelope is a protocol error', async () => {
  await withGateway(async ({ uri }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));

    const frame = await client.next();
    assert.strictEqual(frame.type, WS_TYPE.WS_ERROR);
    assert.strictEqual(frame.error.code, 'MALFORMED_FRAME');
    assert.strictEqual((await client.closed).code, 1002);
  });
});
