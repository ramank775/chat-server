const test = require('node:test');
const assert = require('node:assert');
const {
  ACK_OUTCOME,
  REASON,
  WS_TYPE,
  EnvelopeEvent,
  encodeWsEnvelope,
  opIdUserBits,
  dmChannelId
} = require('../../../libs/v3-envelope');
const {
  ACCESSKEY, mintOpId, opFrame, legacyWire, startGateway, connect
} = require('./helper');

const ALICE = 'a3f2e8c5d';
const BOB = 'b1c2d3e4f';
const CHANNEL = '01efabcd-7000-8000-8abc-000000000001';
const CARL = 'c2d3e4f5a';
/** No row anywhere: a DM id is derived from the pair (TRIM_4_12_CONTRACT §1). */
const DM = dmChannelId(ALICE, BOB);

const payload = (byte = 0x08) => Buffer.from([byte, 0x01, 0x02]);

/** `n` only makes the op_id unique. */
function envelope(userId, n, extra = {}) {
  const { rand = n, ...fields } = extra;
  return {
    opId: mintOpId(userId, { counter: n, rand }),
    channelId: CHANNEL,
    clientTimestampMs: Date.now(),
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

test('echoes the accesskey subprotocol on the 101', async () => {
  await withGateway(async ({ uri }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    assert.strictEqual(client.protocol, `accesskey.${ACCESSKEY}`);
    client.close();
  });
});

test('binds the socket to x-user and stamps sender_user_id', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(opFrame([envelope(ALICE, 1)]));
    const frame = await client.next();

    assert.strictEqual(frame.type, WS_TYPE.WS_ACK);
    assert.strictEqual(frame.acks.acks.length, 1);
    assert.strictEqual(frame.acks.acks[0].outcome, ACK_OUTCOME.SUCCESS);
    assert.ok(frame.acks.acks[0].serverTimestampMs > 0);

    const [published] = publishedEnvelopes();
    assert.strictEqual(published.key, CHANNEL);
    assert.strictEqual(published.args.envelope.senderUserId, ALICE);
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

test('resource_seq from an older client is ignored: gaps, repeats and none all land', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;

    // DECISIONS row 127: the server keeps no per-channel counter, so nothing
    // an older client puts in field 3 can be out_of_order.
    const seqs = [7, 3, 3, undefined, 1];
    // eslint-disable-next-line no-restricted-syntax
    for (const [n, resourceSeq] of seqs.entries()) {
      client.send(legacyWire.opFrame([{ ...envelope(ALICE, n + 1), resourceSeq }]));
      // eslint-disable-next-line no-await-in-loop
      const [ack] = (await client.next()).acks.acks;
      assert.strictEqual(ack.outcome, ACK_OUTCOME.SUCCESS, `resource_seq ${resourceSeq}`);
    }

    const published = publishedEnvelopes();
    assert.strictEqual(published.length, seqs.length);
    // and it is not passed on to the recipients either
    published.forEach(({ args }) => {
      assert.strictEqual(legacyWire.decode(args.toPushFrame()).push.resourceSeq, undefined);
    });
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
    const env = envelope(ALICE, 1, { channelId: 'not-my-channel' });

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
    client.send(opFrame([envelope(ALICE, 1, { channelId: 'someone-elses-channel' })]));

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
    client.send(opFrame([envelope(ALICE, 1, { channelId: DM, peer: BOB })]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.SUCCESS);

    const [published] = publishedEnvelopes();
    assert.strictEqual(published.args.envelope.channelId, DM);
    assert.strictEqual(published.args.envelope.peer, BOB);
    // spelled out by the gateway: message-delivery must not look for a row.
    // The sender is in the list so their other devices get it (§8).
    assert.deepStrictEqual(published.args.recipients, [BOB, ALICE]);
    client.close();
  });
});

test('a DM envelope without a peer is validation_failed', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(opFrame([envelope(ALICE, 1, { channelId: DM })]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.strictEqual(ack.reason, REASON.VALIDATION_FAILED);
    assert.strictEqual(publishedEnvelopes().length, 0);
    client.close();
  });
});

test('a peer that does not derive to the channel_id is forbidden', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    client.send(opFrame([envelope(ALICE, 1, { channelId: DM, peer: CARL })]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.strictEqual(ack.reason, REASON.FORBIDDEN);
    assert.strictEqual(publishedEnvelopes().length, 0);
    client.close();
  });
});

test('a third party cannot send on somebody else\'s DM id', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, CARL);
    await client.opened;
    // every peer carl can name derives to a different id, so squatting
    // alice+bob's channel is unrepresentable
    client.send(opFrame([envelope(CARL, 1, { channelId: DM, peer: BOB })]));

    const [ack] = (await client.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.strictEqual(ack.reason, REASON.FORBIDDEN);
    assert.strictEqual(publishedEnvelopes().length, 0);
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

test('the ack and the fanout carry server_timestamp_ms and no delivery_sequence', async () => {
  await withGateway(async ({ uri, publishedEnvelopes }) => {
    const client = connect(uri, ALICE);
    await client.opened;
    const before = Date.now();

    client.send(opFrame([envelope(ALICE, 1), envelope(ALICE, 2)]));
    const frame = await client.next();
    const { acks } = legacyWire.decode(frame.raw).acks;
    const pushes = publishedEnvelopes().map(({ args }) => legacyWire.decode(args.toPushFrame()).push);

    assert.strictEqual(acks.length, 2);
    acks.forEach((ack, index) => {
      assert.ok(ack.serverTimestampMs >= before);
      assert.strictEqual(pushes[index].serverTimestampMs, ack.serverTimestampMs);
      assert.strictEqual(ack.deliverySequence, undefined, 'Ack.delivery_sequence (6) is retired');
      assert.strictEqual(pushes[index].deliverySequence, undefined, 'field 22 is retired');
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
    assert.strictEqual(frame.push.senderUserId, ALICE);
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
const fanout = (gateway, subjects, offset = 1) => gateway.messageHandler(EnvelopeEvent.of({
  opId: mintOpId(ALICE),
  channelId: CHANNEL,
  payload: payload(),
  senderUserId: ALICE,
  serverTimestampMs: 1700000000123,
  offset
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
    client.send(encodeWsEnvelope({ type: WS_TYPE.WS_PUSH, push: envelope(ALICE, 1) }));

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
