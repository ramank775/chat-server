const test = require('node:test');
const assert = require('node:assert');
const {
  ACK_OUTCOME,
  REASON,
  WS_TYPE,
  FRAME_CLASS,
  SERVER_EVENT_MARKER,
  classFlags,
  opIdUserBits,
  uuidText,
  userIdBytes
} = require('../../../libs/v3-envelope');
const { serverEventPayload } = require('../../channel-ms/server-event');
const { mintOpId, opFrame, startGateway, connect } = require('./helper');

const ALICE = 'a3f2e8c5d';
const BOB = 'b1c2d3e4f';
const PRESENCE_FLAGS = classFlags(FRAME_CLASS.PRESENCE) + 1;

let counter = 0;

/** A client's presence op: its app is (not) on screen, and it watches `peer`. */
function presenceOp(userId, peer, online, extra = {}) {
  counter += 1;
  const definition = serverEventPayload();
  const body = definition.encode(definition.fromObject({
    version: 1, type: 50, presence: { online }
  })).finish();
  return {
    opId: mintOpId(userId, { counter, rand: counter }),
    peer,
    payload: Buffer.concat([Buffer.from([SERVER_EVENT_MARKER]), body]),
    ephemeral: true,
    flags: PRESENCE_FLAGS,
    ...extra
  };
}

/** The presence a WS_PUSH carries, and who the frame says it is from. */
function presenceOf(frame) {
  assert.strictEqual(frame.type, WS_TYPE.WS_PUSH);
  const { push } = frame;
  assert.strictEqual(push.ephemeral, true);
  assert.strictEqual(push.flags, PRESENCE_FLAGS, 'class PRESENCE, SILENT');
  assert.strictEqual(push.payload[0], SERVER_EVENT_MARKER);
  const { presence } = serverEventPayload().toObject(
    serverEventPayload().decode(push.payload.subarray(1)),
    { longs: Number, defaults: true }
  );
  return {
    from: opIdUserBits(uuidText(push.opId)).toString(16).padStart(9, '0'),
    peer: push.peer,
    ...presence
  };
}

/** No frame arrives within a short wait. */
async function silent(client) {
  await assert.rejects(client.next(150), /timed out/);
}

/**
 * A gateway whose profile-ms answers `/_internal/presence` with `lastSeen`
 * and the viewers `allowed(target, viewer)` lets through.
 */
async function withPresence(fn) {
  const harness = await startGateway();
  const calls = [];
  const profile = { allowed: () => true, lastSeen: 1234 };
  harness.gateway.profileClient = {
    post: async (path, body) => {
      calls.push({ path, body });
      if (path !== '/_internal/presence') return { status: true };
      return {
        last_seen_ms: profile.lastSeen,
        viewers: body.viewers.filter((viewer) => profile.allowed(body.user_id, viewer))
      };
    }
  };
  try {
    await fn({ ...harness, calls, profile });
  } finally {
    await harness.stop();
  }
}

test('a presence op is answered at once, and is never fanned out or acked', async () => {
  await withPresence(async ({ uri, publishedEnvelopes, calls }) => {
    const alice = connect(uri, ALICE);
    await alice.opened;
    alice.send(opFrame([presenceOp(ALICE, BOB, true)]));

    const answer = presenceOf(await alice.next());
    assert.deepStrictEqual(answer, {
      from: BOB, peer: userIdBytes(ALICE), userId: BOB, online: false, lastSeenMs: 1234
    });
    assert.strictEqual(publishedEnvelopes().length, 0);
    assert.deepStrictEqual(calls.map((c) => c.body), [
      { user_id: ALICE, viewers: [], seen: true }, // alice came online: her last seen
      { user_id: BOB, viewers: [ALICE], seen: false }
    ]);
    alice.close();
  });
});

test('a watcher hears its contact come online, step away, come back and leave', async () => {
  await withPresence(async ({ uri }) => {
    const alice = connect(uri, ALICE);
    await alice.opened;
    alice.send(opFrame([presenceOp(ALICE, BOB, true)]));
    assert.strictEqual(presenceOf(await alice.next()).online, false);

    const bob = connect(uri, BOB);
    await bob.opened;
    await silent(alice); // a socket alone is not online: the app says when it is on screen
    bob.send(opFrame([presenceOp(BOB, BOB, true)])); // on screen, watching nobody
    assert.strictEqual(presenceOf(await alice.next()).online, true);
    bob.send(opFrame([presenceOp(BOB, BOB, false)])); // in the background
    assert.deepStrictEqual(
      (({ online, lastSeenMs }) => ({ online, lastSeenMs }))(presenceOf(await alice.next())),
      { online: false, lastSeenMs: 1234 }
    );
    bob.send(opFrame([presenceOp(BOB, BOB, true)]));
    assert.strictEqual(presenceOf(await alice.next()).online, true);
    bob.close();
    assert.strictEqual(presenceOf(await alice.next()).online, false);
    alice.close();
  });
});

test('a viewer who may not see is told nothing on a change, and "nothing" when it asks', async () => {
  await withPresence(async ({ uri, profile, calls }) => {
    profile.allowed = () => false;
    const alice = connect(uri, ALICE);
    await alice.opened;
    alice.send(opFrame([presenceOp(ALICE, BOB, true)]));
    const answer = presenceOf(await alice.next());
    assert.deepStrictEqual([answer.online, answer.lastSeenMs], [false, 0], 'show nothing');

    const bob = connect(uri, BOB);
    await bob.opened;
    bob.send(opFrame([presenceOp(BOB, BOB, true)]));
    bob.close();
    await silent(alice); // its timing would give it away
    const stamps = calls.filter((c) => c.body.user_id === BOB && c.body.seen);
    assert.strictEqual(stamps.length, 2, 'bob\'s last seen is still recorded, twice');
    alice.close();
  });
});

test('a viewer shown something gets "nothing" once it may no longer see', async () => {
  await withPresence(async ({ uri, gateway, profile }) => {
    const bob = connect(uri, BOB);
    await bob.opened;
    bob.send(opFrame([presenceOp(BOB, BOB, true)]));
    const alice = connect(uri, ALICE);
    await alice.opened;
    alice.send(opFrame([presenceOp(ALICE, BOB, true)]));
    assert.strictEqual(presenceOf(await alice.next()).online, true);

    // bob hides it: profile-ms tells the gateway
    profile.allowed = () => false;
    const res = await gateway.server.inject({
      method: 'POST', url: '/_internal/presence/refresh', payload: { user_id: BOB }
    });
    assert.strictEqual(res.statusCode, 200);
    const cleared = presenceOf(await alice.next());
    assert.deepStrictEqual([cleared.online, cleared.lastSeenMs], [false, 0]);
    bob.close();
    await silent(alice);
    alice.close();
  });
});

test('a presence op must be ephemeral; one over https does nothing', async () => {
  await withPresence(async ({ uri, gateway, calls }) => {
    const alice = connect(uri, ALICE);
    await alice.opened;
    alice.send(opFrame([presenceOp(ALICE, BOB, true, { ephemeral: false })]));
    const [ack] = (await alice.next()).acks.acks;
    assert.strictEqual(ack.outcome, ACK_OUTCOME.PERMANENT);
    assert.strictEqual(ack.reason, REASON.VALIDATION_FAILED);

    const res = await gateway.server.inject({
      method: 'POST',
      url: '/ops',
      headers: { 'x-user': BOB, 'x-device': '00000000-0000-4000-8000-000000000002' },
      payload: { frame: opFrame([presenceOp(BOB, ALICE, true)]).toString('base64') }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls.length, 0, 'no socket: not online, nothing to answer');
    alice.close();
  });
});

test('closing a socket ends its watch', async () => {
  await withPresence(async ({ uri, gateway }) => {
    const alice = connect(uri, ALICE);
    await alice.opened;
    alice.send(opFrame([presenceOp(ALICE, BOB, true)]));
    await alice.next();
    assert.strictEqual(gateway.watchers.get(BOB).size, 1);
    alice.send(opFrame([presenceOp(ALICE, ALICE, true)])); // watching nobody
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.strictEqual(gateway.watchers.has(BOB), false);
    alice.send(opFrame([presenceOp(ALICE, BOB, true)]));
    await alice.next();
    alice.close();
    await alice.closed;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.strictEqual(gateway.watchers.size, 0);
  });
});

test('someone who blocked the asker is not asked about (decision 219)', async () => {
  await withPresence(async ({ uri, calls, setVerdict }) => {
    setVerdict(ALICE, BOB, 'blocked');
    const alice = connect(uri, ALICE);
    await alice.opened;
    alice.send(opFrame([presenceOp(ALICE, BOB, true), presenceOp(ALICE, ALICE, true)]));
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.deepStrictEqual(calls.filter((c) => c.body.user_id === BOB), []);
    alice.close();
  });
});
