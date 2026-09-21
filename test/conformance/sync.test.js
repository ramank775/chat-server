const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { ACK_OUTCOME, REASON, WS_TYPE, decodeWsEnvelope } = require('../../libs/v3-envelope');
const {
  BASE,
  api,
  connect,
  decodeServerEvent,
  devOtp,
  eventually,
  mintOpId,
  signup,
  uniquePhone
} = require('./helper');

/**
 * AUTH_CONTRACT + SYNC_PROTOCOL conformance against the live compose stack.
 * Run it with `npm run test:conformance` (or CONFORMANCE_BASE_URL=<nginx url>);
 * without that variable every case here is skipped so `npm test` stays hermetic.
 */
const { describe, it, after } = test;

/** Per user op_id minter — the 36 bit user_id is baked into every UUIDv7 (§3). */
function opIds(userId) {
  let counter = 0;
  return () => {
    counter += 1;
    return mintOpId(userId, { counter, rand: counter });
  };
}

describe('conformance: sync wire', { skip: BASE ? false : 'CONFORMANCE_BASE_URL not set' }, () => {
  /** @type {*} */ let alice;
  /** @type {*} */ let bob;
  let aliceOp;
  let bobOp;
  /** Sequence counters mirroring the server's `seq:<user>:<resource>` space. */
  const seq = new Map();
  const nextSeq = (user, resource) => {
    const key = `${user}:${resource}`;
    const value = (seq.get(key) || 0) + 1;
    seq.set(key, value);
    return value;
  };
  let dmId;
  let groupId;
  /** @type {*} */ let aliceWs;
  /** @type {*} */ let bobWs;

  after(async () => {
    await Promise.all([aliceWs, bobWs].filter(Boolean).map((socket) => socket.close()));
  });

  // -- 1. OTP send / verify -------------------------------------------------

  it('signs two users up over OTP with the mock sms sender', async () => {
    alice = await signup('device-a');
    bob = await signup('device-b');
    assert.equal(alice.isNew, true);
    assert.equal(bob.isNew, true);
    assert.match(alice.user_id, /^[0-9a-f]{9}$/);
    assert.equal(alice.username, null);
    assert.ok(alice.accesskey && alice.refreshToken);
    assert.notEqual(alice.user_id, bob.user_id);
    aliceOp = opIds(alice.user_id);
    bobOp = opIds(bob.user_id);
  });

  it('rejects a wrong code with 401 INVALID_CODE', async () => {
    const phone = uniquePhone();
    const send = await api('POST', '/v3.0/auth/otp/send', { body: { phone, deviceId: 'd' } });
    assert.equal(send.status, 200);
    assert.equal(send.body.isExistingAccount, false);
    const real = await devOtp(phone);
    const wrong = real === '000000' ? '111111' : '000000';
    const verify = await api('POST', '/v3.0/auth/otp/verify', {
      body: { sessionId: send.body.sessionId, code: wrong, deviceId: 'd' }
    });
    assert.equal(verify.status, 401);
    assert.equal(verify.body.error.code, 'INVALID_CODE');
  });

  // -- 2. USERNAME_REQUIRED gate -------------------------------------------

  it('gates every non exempt route until a username is set', async () => {
    const gated = await api('POST', '/v3.0/contacts/lookup', {
      token: alice.accesskey,
      body: { phoneHashes: [crypto.createHash('sha256').update(bob.phone).digest('hex')] }
    });
    assert.equal(gated.status, 403);
    assert.equal(gated.body.error.code, 'USERNAME_REQUIRED');

    // GET /users/me is on the exempt list, so it answers while username is null
    const me = await api('GET', '/v3.0/users/me', { token: alice.accesskey });
    assert.equal(me.status, 200);
    assert.equal(me.body.username, null);

    await [alice, bob].reduce(async (previous, user) => {
      await previous;
      const username = `c${crypto.randomInt(0, 1e9).toString().padStart(9, '0')}`;
      const patch = await api('PATCH', '/v3.0/users/me', {
        token: user.accesskey,
        body: { username }
      });
      assert.equal(patch.status, 200);
      assert.equal(patch.body.username, username);
      user.username = username;
    }, Promise.resolve());

    const open = await api('POST', '/v3.0/contacts/lookup', {
      token: alice.accesskey,
      body: { phoneHashes: [crypto.createHash('sha256').update(bob.phone).digest('hex')] }
    });
    assert.equal(open.status, 200);
  });

  it('rejects a taken username with 409 USERNAME_TAKEN', async () => {
    const clash = await api('PATCH', '/v3.0/users/me', {
      token: alice.accesskey,
      body: { username: bob.username }
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'USERNAME_TAKEN');
  });

  // -- 3. users/by-username with and without a key --------------------------

  it('resolves a handle, and demands the key once one is set', async () => {
    const open = await api('GET', `/v3.0/users/by-username/${bob.username.toUpperCase()}`, {
      token: alice.accesskey
    });
    assert.equal(open.status, 200);
    assert.equal(open.body.user_id, bob.user_id);
    assert.equal(open.body.phone, undefined);

    const keyed = await api('PATCH', '/v3.0/users/me', {
      token: bob.accesskey,
      body: { usernameKey: '4711' }
    });
    assert.equal(keyed.status, 200);

    const noKey = await api('GET', `/v3.0/users/by-username/${bob.username}`, {
      token: alice.accesskey
    });
    assert.equal(noKey.status, 404);
    assert.equal(noKey.body.error.code, 'USERNAME_KEY_REQUIRED');

    const wrongKey = await api('GET', `/v3.0/users/by-username/${bob.username}?key=0000`, {
      token: alice.accesskey
    });
    assert.equal(wrongKey.status, 404);
    assert.equal(wrongKey.body.error.code, 'USER_NOT_FOUND');

    const rightKey = await api('GET', `/v3.0/users/by-username/${bob.username}?key=4711`, {
      token: alice.accesskey
    });
    assert.equal(rightKey.status, 200);
    assert.equal(rightKey.body.user_id, bob.user_id);
  });

  // -- 4. contacts/lookup ---------------------------------------------------

  it('maps phone hashes to users and never reports negatives', async () => {
    const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
    const lookup = await api('POST', '/v3.0/contacts/lookup', {
      token: alice.accesskey,
      body: { phoneHashes: [hash(bob.phone), hash(alice.phone), hash('+919999999999')] }
    });
    assert.equal(lookup.status, 200);
    // the caller's own number and the unknown one are both simply absent
    assert.deepEqual(lookup.body.matches, [
      { phoneHash: hash(bob.phone), user_id: bob.user_id, username: bob.username }
    ]);

    const malformed = await api('POST', '/v3.0/contacts/lookup', {
      token: alice.accesskey,
      body: { phoneHashes: ['not-a-sha256'] }
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'validation_failed');
  });

  // -- 5. DM create over REST, with dedup and id collision ------------------

  it('creates a DM, replays the stored 201 and 409s a taken channel id', async () => {
    dmId = crypto.randomUUID();
    const opId = aliceOp();
    const payload = {
      op_id: opId,
      resource_seq: nextSeq(alice.user_id, dmId),
      client_timestamp_ms: Date.now(),
      channel_id: dmId,
      kind: 'one_to_one',
      members: [alice.user_id, bob.user_id]
    };
    const created = await api('POST', '/v3.0/channels', {
      token: alice.accesskey,
      body: payload
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.channel_id, dmId);
    assert.equal(created.body.kind, 'one_to_one');
    assert.deepEqual([...created.body.members].sort(), [alice.user_id, bob.user_id].sort());

    // §7.1 — the same op_id replays the stored outcome verbatim
    const replay = await api('POST', '/v3.0/channels', { token: alice.accesskey, body: payload });
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, created.body);

    // a *different* op landing on the same channel_id is terminal
    const collision = await api('POST', '/v3.0/channels', {
      token: alice.accesskey,
      body: {
        op_id: aliceOp(),
        resource_seq: nextSeq(alice.user_id, dmId),
        channel_id: dmId,
        kind: 'group',
        name: 'collides',
        members: [alice.user_id]
      }
    });
    assert.equal(collision.status, 409);
    assert.equal(collision.body.error.code, 'resource_id_taken');
  });

  it('rejects an op_id minted for another user with prefix_mismatch', async () => {
    const stolen = await api('POST', '/v3.0/channels', {
      token: bob.accesskey,
      body: {
        op_id: aliceOp(),
        resource_seq: 1,
        channel_id: crypto.randomUUID(),
        kind: 'group',
        name: 'nope',
        members: [bob.user_id]
      }
    });
    assert.equal(stolen.status, 400);
    assert.equal(stolen.body.error.code, 'prefix_mismatch');
  });

  // -- 6. WS: subprotocol echo, acks, ordering, batch cap -------------------

  it('accepts the accesskey subprotocol on the upgrade', async () => {
    aliceWs = connect(alice.accesskey);
    bobWs = connect(bob.accesskey);
    await Promise.all([aliceWs.opened, bobWs.opened]);
    assert.equal(aliceWs.protocol, `accesskey.${alice.accesskey}`);
    assert.equal(bobWs.protocol, `accesskey.${bob.accesskey}`);
  });

  it('acks three in-order envelopes with increasing delivery_sequence', async () => {
    const sent = [1, 2, 3].map((n) => ({
      opId: bobOp(),
      channelId: dmId,
      resourceSeq: nextSeq(bob.user_id, dmId),
      clientTimestampMs: Date.now(),
      payload: Buffer.from(`hello ${n}`)
    }));
    assert.deepEqual(sent.map((envelope) => envelope.resourceSeq), [1, 2, 3]);

    const acks = [];
    // strictly one at a time: `resource_seq` is a compare-and-set on last + 1
    await sent.reduce(async (previous, envelope) => {
      await previous;
      bobWs.send([envelope]);
      acks.push((await bobWs.ack()).acks.acks[0]);
    }, Promise.resolve());
    acks.forEach((ack, index) => {
      assert.equal(ack.opId, sent[index].opId);
      assert.equal(ack.outcome, ACK_OUTCOME.SUCCESS);
      assert.ok(ack.serverTimestampMs > 0);
    });
    assert.ok(acks[1].deliverySequence > acks[0].deliverySequence);
    assert.ok(acks[2].deliverySequence > acks[1].deliverySequence);

    // §10.4 — the peer sees the same three, in delivery_sequence order
    const pushes = [];
    await sent.reduce(async (previous) => {
      await previous;
      pushes.push(await aliceWs.push());
    }, Promise.resolve());
    assert.deepEqual(
      pushes.map((frame) => frame.push.opId),
      sent.map((envelope) => envelope.opId)
    );
    pushes.forEach((frame, index) => {
      assert.equal(frame.push.senderUserId, bob.user_id);
      assert.equal(Number(frame.push.deliverySequence), Number(acks[index].deliverySequence));
    });
  });

  it('rejects a skipped resource_seq with out_of_order', async () => {
    bobWs.send([
      {
        opId: bobOp(),
        channelId: dmId,
        resourceSeq: 5, // 4 was never sent
        clientTimestampMs: Date.now(),
        payload: Buffer.from('gap')
      }
    ]);
    const [ack] = (await bobWs.ack()).acks.acks;
    assert.equal(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.equal(ack.reason, REASON.OUT_OF_ORDER);
  });

  it('rejects an op_id bound to another user with prefix_mismatch', async () => {
    bobWs.send([
      {
        opId: aliceOp(), // minted for alice, sent on bob's socket
        channelId: dmId,
        resourceSeq: 4,
        clientTimestampMs: Date.now(),
        payload: Buffer.from('not mine')
      }
    ]);
    const [ack] = (await bobWs.ack()).acks.acks;
    assert.equal(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.equal(ack.reason, REASON.PREFIX_MISMATCH);
  });

  it('rejects a batch over the 20 envelope cap, one permanent ack each', async () => {
    const envelopes = Array.from({ length: 21 }, (_, index) => ({
      opId: bobOp(),
      channelId: dmId,
      resourceSeq: 100 + index,
      clientTimestampMs: Date.now(),
      payload: Buffer.from('too many')
    }));
    bobWs.send(envelopes);
    const frame = await bobWs.ack();
    assert.equal(frame.acks.acks.length, 21);
    frame.acks.acks.forEach((ack) => {
      assert.equal(ack.outcome, ACK_OUTCOME.PERMANENT);
      assert.equal(ack.reason, REASON.VALIDATION_FAILED);
    });
  });

  it('forbids an envelope on a channel the sender is not in', async () => {
    bobWs.send([
      {
        opId: bobOp(),
        channelId: crypto.randomUUID(),
        resourceSeq: 1,
        clientTimestampMs: Date.now(),
        payload: Buffer.from('stranger')
      }
    ]);
    const [ack] = (await bobWs.ack()).acks.acks;
    assert.equal(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.equal(ack.reason, REASON.FORBIDDEN);
  });

  // -- 7. fanout to a connected peer ---------------------------------------

  it('pushes a sender envelope to the connected peer, never back to the sender', async () => {
    const envelope = {
      opId: aliceOp(),
      channelId: dmId,
      resourceSeq: nextSeq(alice.user_id, dmId),
      clientTimestampMs: Date.now(),
      payload: Buffer.from('for bob')
    };
    aliceWs.send([envelope]);
    const [ack] = (await aliceWs.ack()).acks.acks;
    assert.equal(ack.outcome, ACK_OUTCOME.SUCCESS, JSON.stringify(ack));

    const push = await bobWs.push();
    assert.equal(push.type, WS_TYPE.WS_PUSH);
    assert.equal(push.push.opId, envelope.opId);
    assert.equal(push.push.channelId, dmId);
    assert.equal(push.push.senderUserId, alice.user_id);
    assert.equal(Buffer.from(push.push.payload).toString(), 'for bob');
    assert.equal(Number(push.push.deliverySequence), Number(ack.deliverySequence));

    // §10.3 rule 4 — the sender never gets its own op back
    await assert.rejects(() =>
      aliceWs.waitFor(
        (frame) => frame.type === WS_TYPE.WS_PUSH && frame.push.opId === envelope.opId,
        500
      ));
  });

  // -- 8. undelivered queue drain ------------------------------------------

  it('queues for an offline user and drains it exactly once', async () => {
    await bobWs.close();
    bobWs = null;

    const envelope = {
      opId: aliceOp(),
      channelId: dmId,
      resourceSeq: nextSeq(alice.user_id, dmId),
      clientTimestampMs: Date.now(),
      payload: Buffer.from('while you were out')
    };
    aliceWs.send([envelope]);
    const [ack] = (await aliceWs.ack()).acks.acks;
    assert.equal(ack.outcome, ACK_OUTCOME.SUCCESS);

    const drained = await eventually(async () => {
      const response = await api('GET', '/v3.0/sync/pending', { token: bob.accesskey });
      assert.equal(response.status, 200);
      const frames = response.body.frames.map((entry) =>
        decodeWsEnvelope(Buffer.from(entry, 'base64')));
      // the queue also holds the ChannelCreated bob was offline for (§10.2)
      return frames.some((frame) => frame.push.opId === envelope.opId) ? frames : null;
    });
    const mine = drained.filter((frame) => frame.push.opId === envelope.opId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].type, WS_TYPE.WS_PUSH);
    assert.equal(mine[0].push.senderUserId, alice.user_id);
    assert.equal(Buffer.from(mine[0].push.payload).toString(), 'while you were out');

    const second = await api('GET', '/v3.0/sync/pending', { token: bob.accesskey });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.frames, []);
  });

  // -- 9. channel server events (0x53) -------------------------------------

  it('fans ChannelCreated, ChannelMemberAdded and ChannelMemberRemoved out', async () => {
    bobWs = connect(bob.accesskey);
    await bobWs.opened;

    groupId = crypto.randomUUID();
    const created = await api('POST', '/v3.0/channels', {
      token: alice.accesskey,
      body: {
        op_id: aliceOp(),
        resource_seq: nextSeq(alice.user_id, groupId),
        channel_id: groupId,
        kind: 'group',
        name: 'conformance',
        members: [alice.user_id, bob.user_id]
      }
    });
    assert.equal(created.status, 201);

    const createdPush = await bobWs.push();
    const createdEvent = decodeServerEvent(createdPush.push.payload);
    assert.equal(createdEvent.type, 'CHANNEL_CREATED');
    assert.equal(createdEvent.channelCreated.channelId, groupId);
    assert.equal(createdEvent.channelCreated.creator, alice.user_id);

    const carol = await signup('device-c');
    await api('PATCH', '/v3.0/users/me', {
      token: carol.accesskey,
      body: { username: `c${crypto.randomInt(0, 1e9).toString().padStart(9, '0')}` }
    });
    const added = await api('POST', `/v3.0/channels/${groupId}/members`, {
      token: alice.accesskey,
      body: {
        op_id: aliceOp(),
        resource_seq: nextSeq(alice.user_id, groupId),
        members: [carol.user_id]
      }
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.member_count, 3);

    const addedPush = await bobWs.push();
    const addedEvent = decodeServerEvent(addedPush.push.payload);
    assert.equal(addedEvent.type, 'CHANNEL_MEMBER_ADDED');
    assert.deepEqual(addedEvent.memberAdded.members, [carol.user_id]);

    // bob leaves; the actor is excluded from its own fanout, alice is told
    const left = await api('DELETE', `/v3.0/channels/${groupId}/members/${bob.user_id}`, {
      token: bob.accesskey,
      body: { op_id: bobOp(), resource_seq: nextSeq(bob.user_id, groupId) }
    });
    assert.equal(left.status, 200);
    assert.equal(left.body.member_count, 2);

    const removedPush = await aliceWs.push();
    const removedEvent = decodeServerEvent(removedPush.push.payload);
    assert.equal(removedEvent.type, 'CHANNEL_MEMBER_REMOVED');
    assert.equal(removedEvent.memberRemoved.channelId, groupId);
    assert.equal(removedEvent.memberRemoved.member, bob.user_id);
  });
});
