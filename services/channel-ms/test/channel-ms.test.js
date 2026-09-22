const test = require('node:test');
const assert = require('node:assert');
const { startChannelMs, decodeServerEvent, mintOpId, op, headers } = require('./helper');

const ALICE = 'a3f2e8c5d';
const BOB = 'b1c2d3e4f';
const CARL = 'c2d3e4f5a';
const DAVE = 'd3e4f5a6b';

const CHANNEL = '01efabcd-7000-8000-8abc-000000000001';
const SEQ_SPACE = '01efabcd-7000-8000-8abc-000000000002';

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

// ---- trim 4: groups are the only channel with a row -----------------------

test('a one_to_one create is rejected — DM ids are derived, never created', async () => {
  const response = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(ALICE),
    payload: op(ALICE, 1, {
      channel_id: '01efabcd-7000-8000-8abc-0000000000f1',
      kind: 'one_to_one',
      members: [ALICE, BOB]
    })
  });
  assert.strictEqual(response.statusCode, 400);
});

test('GET / lists groups only', async () => {
  const response = await harness.inject({ method: 'GET', url: '/', headers: headers(ALICE) });
  assert.strictEqual(response.statusCode, 200);
  const kinds = new Set(body(response).map((channel) => channel.kind));
  assert.deepStrictEqual([...kinds], ['group']);
});

test('REST and WS share one sequence space per (user, resource)', async () => {
  // The gateway writes `seq:<user>:<resource>`; a REST op on the same
  // resource has to see that value.
  const { memCache } = harness.server;
  await createGroup(SEQ_SPACE, ALICE, [ALICE, BOB]);
  await memCache.set(`seq:${ALICE}:${SEQ_SPACE}`, 40);
  const response = await harness.inject({
    method: 'PATCH',
    url: `/${SEQ_SPACE}`,
    headers: headers(ALICE),
    payload: op(ALICE, 41, { name: 'renamed' })
  });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(Number(await memCache.get(`seq:${ALICE}:${SEQ_SPACE}`)), 41);
});

// ---- roles, owner leave and succession (DECISIONS rows 9 / 80) ------------

const ROLES = '01efabcd-7000-8000-8abc-000000000100';
const HANDOVER = '01efabcd-7000-8000-8abc-000000000101';
const SENIORITY = '01efabcd-7000-8000-8abc-000000000102';
const LAST = '01efabcd-7000-8000-8abc-000000000103';
const STRANGER = 'e5f6a7b8c';

/** `op` with a unique op_id, so same-seq writes on other channels cannot collide. */
let nonce = 0;
function uop(userId, seq, extra = {}) {
  nonce += 1;
  return { ...op(userId, seq, extra), op_id: mintOpId(userId, { counter: seq, rand: nonce }) };
}

const newGroup = (channelId, creator, members) => harness.inject({
  method: 'POST',
  url: '/',
  headers: headers(creator),
  payload: uop(creator, 1, { channel_id: channelId, kind: 'group', name: 'Roles', members })
});

const setRole = (channelId, actor, target, role, seq) => harness.inject({
  method: 'PATCH',
  url: `/${channelId}/members/${target}`,
  headers: headers(actor),
  payload: uop(actor, seq, { role })
});

const leaveChannel = (channelId, actor, seq) => harness.inject({
  method: 'DELETE',
  url: `/${channelId}/members/${actor}`,
  headers: headers(actor),
  payload: uop(actor, seq)
});

const roles = async (channelId) => {
  const info = await harness.inject({ method: 'GET', url: `/_internal/${channelId}` });
  return Object.fromEntries(body(info).members.map((m) => [m.user_id, m.role]));
};

test('the owner promotes a member to admin and re-announces them', async () => {
  await newGroup(ROLES, ALICE, [ALICE, BOB, CARL, DAVE]);
  const response = await setRole(ROLES, ALICE, BOB, 'admin', 2);
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(body(response), { user_id: BOB, role: 'admin' });

  const { recipients, body: event } = harness.lastEvent();
  assert.strictEqual(event.type, 'CHANNEL_MEMBER_ADDED');
  assert.deepStrictEqual(event.memberAdded.members, [BOB]);
  assert.strictEqual(event.memberAdded.role, 'admin');
  assert.deepStrictEqual(recipients.sort(), [ALICE, BOB, CARL, DAVE].sort());
  assert.strictEqual((await roles(ROLES))[BOB], 'admin');
});

test('an admin may promote another member', async () => {
  const response = await setRole(ROLES, BOB, CARL, 'admin', 1);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual((await roles(ROLES))[CARL], 'admin');
});

test('a plain member cannot change roles', async () => {
  const response = await setRole(ROLES, DAVE, CARL, 'member', 1);
  assert.strictEqual(response.statusCode, 403);
  assert.strictEqual(body(response).error.code, 'forbidden');
});

test('nobody demotes themselves, and the owner role cannot be changed', async () => {
  const self = await setRole(ROLES, BOB, BOB, 'member', 2);
  assert.strictEqual(self.statusCode, 403);
  const owner = await setRole(ROLES, BOB, ALICE, 'member', 2);
  assert.strictEqual(owner.statusCode, 403);
  assert.strictEqual((await roles(ROLES))[ALICE], 'owner');
});

test('a role change on a non member is not_found', async () => {
  const response = await setRole(ROLES, ALICE, STRANGER, 'admin', 3);
  assert.strictEqual(response.statusCode, 404);
  assert.strictEqual(body(response).error.code, 'not_found');
});

test('a replayed role PATCH returns the stored outcome without fanning out', async () => {
  const payload = uop(ALICE, 3, { role: 'admin' });
  const request = {
    method: 'PATCH', url: `/${ROLES}/members/${DAVE}`, headers: headers(ALICE), payload
  };
  const first = await harness.inject(request);
  const before = harness.published().length;
  const second = await harness.inject(request);
  assert.strictEqual(first.statusCode, 200);
  assert.deepStrictEqual(body(second), body(first));
  assert.strictEqual(harness.published().length, before, 'replay must not fan out again');
});

test('an owner who leaves hands the channel to the longest-standing admin', async () => {
  await newGroup(HANDOVER, ALICE, [ALICE, BOB, CARL]);
  await setRole(HANDOVER, ALICE, CARL, 'admin', 2);

  const before = harness.published().length;
  const response = await leaveChannel(HANDOVER, ALICE, 3);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(body(response).member_count, 2);

  const fanned = harness.published().slice(before);
  assert.strictEqual(fanned.length, 2, 'removal + succession');
  const [removed, promoted] = fanned;
  assert.strictEqual(decodeServerEvent(removed).memberRemoved.member, ALICE);
  assert.deepStrictEqual(decodeServerEvent(promoted).memberAdded.members, [CARL]);
  assert.strictEqual(decodeServerEvent(promoted).memberAdded.role, 'owner');
  assert.deepStrictEqual(promoted.recipients.sort(), [BOB, CARL].sort());
  assert.deepStrictEqual(await roles(HANDOVER), { [BOB]: 'member', [CARL]: 'owner' });
});

test('with no admin the longest-standing member inherits', async () => {
  await newGroup(SENIORITY, ALICE, [ALICE, DAVE]);
  await harness.inject({
    method: 'POST',
    url: `/${SENIORITY}/members`,
    headers: headers(ALICE),
    payload: uop(ALICE, 2, { members: [BOB] })
  });

  const response = await leaveChannel(SENIORITY, ALICE, 3);
  assert.strictEqual(response.statusCode, 200);
  // DAVE joined at create, BOB later: seniority beats the lexical tiebreak
  assert.deepStrictEqual(await roles(SENIORITY), { [DAVE]: 'owner', [BOB]: 'member' });
  assert.strictEqual(harness.lastEvent().body.memberAdded.role, 'owner');
});

test('the last member out hard deletes the channel', async () => {
  await newGroup(LAST, ALICE, [ALICE, BOB]);
  const bobLeaves = await leaveChannel(LAST, BOB, 1);
  assert.strictEqual(bobLeaves.statusCode, 200);

  const response = await leaveChannel(LAST, ALICE, 2);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(body(response).member_count, 0);

  const { recipients, body: event } = harness.lastEvent();
  assert.strictEqual(event.type, 'CHANNEL_DELETED');
  assert.deepStrictEqual(recipients, [ALICE]);

  const info = await harness.inject({ method: 'GET', url: `/_internal/${LAST}` });
  assert.strictEqual(info.statusCode, 404);
});
