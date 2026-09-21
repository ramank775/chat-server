const test = require('node:test');
const assert = require('node:assert');
const { startChannelMs, op, headers } = require('./helper');

const ALICE = 'a3f2e8c5d';
const BOB = 'b1c2d3e4f';
const CARL = 'c2d3e4f5a';
const DAVE = 'd3e4f5a6b';

const CHANNEL = '01efabcd-7000-8000-8abc-000000000001';
const DM = '01efabcd-7000-8000-8abc-000000000002';

/** @type {Awaited<ReturnType<typeof startChannelMs>>} */
let harness;

test.before(async () => { harness = await startChannelMs('channel-ms-test'); });
test.after(async () => { await harness.stop(); });

const body = (response) => JSON.parse(response.payload);

function createGroup(channelId, creator, members, seq = 1) {
  return harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(creator),
    payload: op(creator, seq, { channel_id: channelId, kind: 'group', name: 'Trip', members })
  });
}

test('creates a group and fans ChannelCreated to every member', async () => {
  const response = await createGroup(CHANNEL, ALICE, [ALICE, BOB, CARL]);
  assert.strictEqual(response.statusCode, 201);
  assert.deepStrictEqual(body(response).members.sort(), [ALICE, BOB, CARL].sort());

  const { recipients, envelope, body: event } = harness.lastEvent();
  assert.deepStrictEqual(recipients.sort(), [ALICE, BOB, CARL].sort());
  assert.strictEqual(envelope.senderUserId, ALICE);
  assert.strictEqual(envelope.payload[0], 0x53);
  assert.ok(envelope.deliverySequence > 0);
  assert.strictEqual(event.type, 'CHANNEL_CREATED');
  assert.strictEqual(event.channelCreated.creator, ALICE);
  assert.deepStrictEqual(event.channelCreated.members.sort(), [ALICE, BOB, CARL].sort());
});

test('a replayed op_id returns the stored outcome without re-applying', async () => {
  const payload = op(ALICE, 1, {
    channel_id: '01efabcd-7000-8000-8abc-0000000000a1',
    kind: 'group',
    name: 'Replay',
    members: [ALICE, BOB]
  });
  const first = await harness.inject({
    method: 'POST', url: '/', headers: headers(ALICE), payload
  });
  const before = harness.published().length;
  const second = await harness.inject({
    method: 'POST', url: '/', headers: headers(ALICE), payload
  });
  assert.strictEqual(first.statusCode, 201);
  assert.strictEqual(second.statusCode, 201);
  assert.deepStrictEqual(body(second), body(first));
  assert.strictEqual(harness.published().length, before, 'replay must not fan out again');
});

test('a skipped resource_seq is rejected as out_of_order', async () => {
  const response = await harness.inject({
    method: 'POST',
    url: `/${CHANNEL}/members`,
    headers: headers(ALICE),
    payload: op(ALICE, 9, { members: [DAVE] })
  });
  assert.strictEqual(response.statusCode, 400);
  assert.strictEqual(body(response).error.code, 'out_of_order');
});

test('an op_id minted for another user is prefix_mismatch', async () => {
  const response = await harness.inject({
    method: 'POST',
    url: `/${CHANNEL}/members`,
    headers: headers(ALICE),
    payload: { ...op(BOB, 2, { members: [DAVE] }) }
  });
  assert.strictEqual(response.statusCode, 400);
  assert.strictEqual(body(response).error.code, 'prefix_mismatch');
});

test('a plain member cannot add members', async () => {
  const response = await harness.inject({
    method: 'POST',
    url: `/${CHANNEL}/members`,
    headers: headers(BOB),
    payload: op(BOB, 1, { members: [DAVE] })
  });
  assert.strictEqual(response.statusCode, 403);
  assert.strictEqual(body(response).error.code, 'forbidden');
});

test('the owner adds a member and both old and new members are told', async () => {
  const response = await harness.inject({
    method: 'POST',
    url: `/${CHANNEL}/members`,
    headers: headers(ALICE),
    payload: op(ALICE, 2, { members: [DAVE] })
  });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(body(response).member_count, 4);

  const { recipients, body: event } = harness.lastEvent();
  assert.deepStrictEqual(recipients.sort(), [ALICE, BOB, CARL, DAVE].sort());
  assert.strictEqual(event.type, 'CHANNEL_MEMBER_ADDED');
  assert.deepStrictEqual(event.memberAdded.members, [DAVE]);
});

test('a non-owner DELETE on the channel is a leave, not a delete', async () => {
  const response = await harness.inject({
    method: 'DELETE',
    url: `/${CHANNEL}`,
    headers: headers(DAVE),
    payload: op(DAVE, 1)
  });
  assert.strictEqual(response.statusCode, 200);

  const { recipients, body: event } = harness.lastEvent();
  assert.strictEqual(event.type, 'CHANNEL_MEMBER_REMOVED');
  assert.strictEqual(event.memberRemoved.member, DAVE);
  assert.ok(recipients.includes(DAVE), 'the removed member is told too');

  const info = await harness.inject({
    method: 'GET', url: `/_internal/${CHANNEL}`
  });
  assert.deepStrictEqual(
    body(info).members.map((m) => m.user_id).sort(), [ALICE, BOB, CARL].sort()
  );
});

test('the owner removes another member', async () => {
  const response = await harness.inject({
    method: 'DELETE',
    url: `/${CHANNEL}/members/${CARL}`,
    headers: headers(ALICE),
    payload: op(ALICE, 3)
  });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(harness.lastEvent().body.memberRemoved.member, CARL);
});

test('PATCH renames the channel and fans ChannelEdited', async () => {
  const response = await harness.inject({
    method: 'PATCH',
    url: `/${CHANNEL}`,
    headers: headers(ALICE),
    payload: op(ALICE, 4, { name: 'Trip 2.0' })
  });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(body(response).name, 'Trip 2.0');
  const { body: event } = harness.lastEvent();
  assert.strictEqual(event.type, 'CHANNEL_EDITED');
  assert.strictEqual(event.channelEdited.name, 'Trip 2.0');
});

test('the owner DELETE is a hard delete with ChannelDeleted', async () => {
  const response = await harness.inject({
    method: 'DELETE',
    url: `/${CHANNEL}`,
    headers: headers(ALICE),
    payload: op(ALICE, 5)
  });
  assert.strictEqual(response.statusCode, 204);
  assert.strictEqual(harness.lastEvent().body.type, 'CHANNEL_DELETED');

  const info = await harness.inject({ method: 'GET', url: `/_internal/${CHANNEL}` });
  assert.strictEqual(info.statusCode, 404);
});

test('an unknown channel is 404 not_found', async () => {
  const response = await harness.inject({
    method: 'PATCH',
    url: '/01efabcd-7000-8000-8abc-0000000000ff',
    headers: headers(ALICE),
    payload: op(ALICE, 1, { name: 'nope' })
  });
  assert.strictEqual(response.statusCode, 404);
  assert.strictEqual(body(response).error.code, 'not_found');
});

test('a second channel id collision is resource_id_taken', async () => {
  const taken = '01efabcd-7000-8000-8abc-0000000000b1';
  await createGroup(taken, ALICE, [ALICE, BOB], 1);
  const response = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(BOB),
    payload: op(BOB, 1, { channel_id: taken, kind: 'group', name: 'clash', members: [BOB, CARL] })
  });
  assert.strictEqual(response.statusCode, 409);
  assert.strictEqual(body(response).error.code, 'resource_id_taken');
});

// ---- one_to_one -----------------------------------------------------------

test('creating a DM that already exists returns the existing channel with 200', async () => {
  const first = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(ALICE),
    payload: op(ALICE, 1, { channel_id: DM, kind: 'one_to_one', members: [ALICE, BOB] })
  });
  assert.strictEqual(first.statusCode, 201);

  const again = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(BOB),
    payload: op(BOB, 1, {
      channel_id: '01efabcd-7000-8000-8abc-0000000000c1',
      kind: 'one_to_one',
      members: [BOB, ALICE]
    })
  });
  assert.strictEqual(again.statusCode, 200);
  assert.strictEqual(body(again).channel_id, DM);
});

test('a username-initiated DM against a keyed user needs the key', async () => {
  const keyed = 'e4f5a6b7c';
  await harness.seedUser(keyed, '4321');

  const withoutKey = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(ALICE),
    payload: op(ALICE, 1, {
      channel_id: '01efabcd-7000-8000-8abc-0000000000d1',
      kind: 'one_to_one',
      members: [ALICE, keyed],
      initiatedVia: 'username'
    })
  });
  assert.strictEqual(withoutKey.statusCode, 403);
  assert.strictEqual(body(withoutKey).error.code, 'USERNAME_KEY_REQUIRED');

  const wrongKey = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(ALICE),
    payload: op(ALICE, 1, {
      channel_id: '01efabcd-7000-8000-8abc-0000000000d2',
      kind: 'one_to_one',
      members: [ALICE, keyed],
      initiatedVia: 'username',
      usernameKey: '0000'
    })
  });
  assert.strictEqual(wrongKey.statusCode, 403);

  const rightKey = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(ALICE),
    payload: op(ALICE, 1, {
      channel_id: '01efabcd-7000-8000-8abc-0000000000d3',
      kind: 'one_to_one',
      members: [ALICE, keyed],
      initiatedVia: 'username',
      usernameKey: '4321'
    })
  });
  assert.strictEqual(rightKey.statusCode, 201);
});

test('a phone-initiated DM bypasses the key entirely', async () => {
  const keyed = 'f5a6b7c8d';
  await harness.seedUser(keyed, '1111');
  const response = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(CARL),
    payload: op(CARL, 1, {
      channel_id: '01efabcd-7000-8000-8abc-0000000000e1',
      kind: 'one_to_one',
      members: [CARL, keyed],
      initiatedVia: 'phone'
    })
  });
  assert.strictEqual(response.statusCode, 201);
});

test('one_to_one membership is fixed', async () => {
  const response = await harness.inject({
    method: 'POST',
    url: `/${DM}/members`,
    headers: headers(ALICE),
    payload: op(ALICE, 2, { members: [CARL] })
  });
  assert.strictEqual(response.statusCode, 403);
});

test('REST and WS share one sequence space per (user, resource)', async () => {
  // The gateway writes `seq:<user>:<resource>`; a REST op on the same
  // resource has to see that value.
  const { memCache } = harness.server;
  await memCache.set(`seq:${ALICE}:${DM}`, 40);
  const response = await harness.inject({
    method: 'PATCH',
    url: `/${DM}`,
    headers: headers(ALICE),
    payload: op(ALICE, 41, { name: 'ignored for a dm' })
  });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(Number(await memCache.get(`seq:${ALICE}:${DM}`)), 41);
});
