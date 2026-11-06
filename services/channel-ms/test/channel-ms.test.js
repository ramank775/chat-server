const test = require('node:test');
const assert = require('node:assert');
const { startChannelMs, decodeServerEvent, mintOpId, op, headers } = require('./helper');
const {
  EVENT_FLAGS, decodeWsEnvelope, opIdUserBits, uuidBytes
} = require('../../../libs/v3-envelope');

const ALICE = 'a3f2e8c5d';
const BOB = 'b1c2d3e4f';
const CARL = 'c2d3e4f5a';
const DAVE = 'd3e4f5a6b';

const CHANNEL = '01efabcd-7000-8000-8abc-000000000001';
const LEGACY = '01efabcd-7000-8000-8abc-000000000002';

/** @type {Awaited<ReturnType<typeof startChannelMs>>} */
let harness;

test.before(async () => {
  harness = await startChannelMs('channel-ms-test');
  // decision 221: only connections may be invited to a group
  const people = [ALICE, BOB, CARL, DAVE];
  await Promise.all(people.flatMap((a, i) => people.slice(i + 1)
    .map((b) => harness.server.db.connect(a, b, Date.now()))));
});
test.after(async () => { await harness.stop(); });

const body = (response) => JSON.parse(response.payload);

function createGroup(channelId, creator, members) {
  return harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(creator),
    payload: op(creator, 1, { channel_id: channelId, kind: 'group', name: 'Trip', members })
  });
}

/** Each of `users` accepts their invite to `channelId` (decision 221). */
async function accept(channelId, ...users) {
  const responses = [];
  // one at a time, so the roster grows in a known order
  // eslint-disable-next-line no-restricted-syntax
  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop
    responses.push(await harness.inject({
      method: 'POST', url: `/${channelId}/invite/accept`, headers: headers(user), payload: {}
    }));
  }
  return responses;
}

test('creates a group: the creator is its member, the rest are invited', async () => {
  const before = harness.published().length;
  const response = await createGroup(CHANNEL, ALICE, [ALICE, BOB, CARL]);
  assert.strictEqual(response.statusCode, 201);
  assert.deepStrictEqual(body(response).members, [ALICE]);
  assert.deepStrictEqual(body(response).invited.sort(), [BOB, CARL].sort());

  const [created, invited, told] = harness.published().slice(before);
  // the invitees hear of it, class INVITE (9) and no SILENT: it wakes them
  assert.deepStrictEqual(invited.recipients.sort(), [BOB, CARL].sort());
  assert.strictEqual(invited.envelope.flags, 18);
  assert.strictEqual(decodeServerEvent(invited).type, 'INVITE_SENT');
  assert.strictEqual(decodeServerEvent(invited).inviteSent.name, 'Trip');
  assert.deepStrictEqual(decodeServerEvent(invited).inviteSent.users.sort(), [BOB, CARL].sort());
  // and the members, SILENT
  assert.deepStrictEqual(told.recipients, [ALICE]);
  assert.strictEqual(told.envelope.flags, 19);

  const { recipients, envelope } = created;
  const event = decodeServerEvent(created);
  assert.deepStrictEqual(recipients, [ALICE]);
  assert.strictEqual(envelope.senderUserId, ALICE);
  // decision 218: the actor rides in the op_id's user bits, as on any op
  assert.strictEqual(opIdUserBits(envelope.opId), parseInt(ALICE, 16));
  assert.strictEqual(envelope.opId[14], '7', 'a UUIDv7');
  assert.strictEqual(envelope.payload[0], 0x53);
  assert.ok(envelope.serverTimestampMs > 0);
  assert.strictEqual(envelope.deliverySequence, undefined, 'no per-channel sequence any more');
  // decision 218: class EVENT, no SILENT bit; on the wire as its recipients
  // get it, the group's id as bytes and no sending device
  assert.strictEqual(envelope.flags, EVENT_FLAGS);
  const { push } = decodeWsEnvelope(harness.published().at(-1).toPushFrame());
  assert.deepStrictEqual(push.channelId, uuidBytes(CHANNEL));
  assert.strictEqual(push.senderDeviceId.length, 0);
  assert.strictEqual(push.peer.length, 0);
  assert.strictEqual(event.type, 'CHANNEL_CREATED');
  assert.strictEqual(event.channelCreated.creator, ALICE);
  assert.deepStrictEqual(event.channelCreated.members, [ALICE]);
});

test('an invitee who accepts is a member, announced with them as actor', async () => {
  const [bob] = await accept(CHANNEL, BOB);
  assert.strictEqual(bob.statusCode, 200);
  assert.deepStrictEqual(body(bob).members, [ALICE, BOB]);
  assert.deepStrictEqual(body(bob).invited, [CARL]);
  const { recipients, envelope, body: event } = harness.lastEvent();
  assert.deepStrictEqual(recipients.sort(), [ALICE, BOB].sort());
  assert.strictEqual(envelope.senderUserId, BOB);
  assert.strictEqual(event.type, 'CHANNEL_MEMBER_ADDED');
  assert.deepStrictEqual(event.memberAdded.members, [BOB]);

  // accepting again answers the same, and adds nobody twice
  const before = harness.published().length;
  const [again] = await accept(CHANNEL, BOB);
  assert.strictEqual(again.statusCode, 200);
  assert.strictEqual(harness.published().length, before);
  await accept(CHANNEL, CARL);
});

test('an invitee gets no group frames, and is not a member, before accepting', async () => {
  const group = '01efabcd-7000-8000-8abc-0000000000c1';
  await createGroup(group, ALICE, [ALICE, BOB]);
  const info = await harness.inject({ method: 'GET', url: `/_internal/${group}` });
  assert.deepStrictEqual(body(info).members.map((m) => m.user_id), [ALICE]);
  const asBob = await harness.inject({ method: 'GET', url: `/${group}`, headers: headers(BOB) });
  assert.strictEqual(asBob.statusCode, 404, 'no roster for an invitee');
  const listed = await harness.inject({ method: 'GET', url: '/', headers: headers(ALICE) });
  assert.deepStrictEqual(body(listed).find((c) => c.channel_id === group).invited, [BOB]);
});

test('only connections may be invited to a group', async () => {
  const response = await createGroup('01efabcd-7000-8000-8abc-0000000000c2', ALICE, [ALICE, 'e5f6a7b8c']);
  assert.strictEqual(response.statusCode, 403);
  assert.strictEqual(body(response).error.code, 'not_connected');
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

test('resource_seq from an older client is accepted and ignored, and may be absent', async () => {
  // DECISIONS row 127: no per-(user, resource) counter, so any value lands
  const created = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(ALICE),
    payload: {
      ...op(ALICE, 90, { channel_id: LEGACY, kind: 'group', name: 'old', members: [ALICE] }),
      resource_seq: 9
    }
  });
  assert.strictEqual(created.statusCode, 201);
  const renamed = await harness.inject({
    method: 'PATCH',
    url: `/${LEGACY}`,
    headers: headers(ALICE),
    payload: { ...op(ALICE, 91, { name: 'renamed' }), resource_seq: 3 }
  });
  assert.strictEqual(renamed.statusCode, 200);
  const unsequenced = await harness.inject({
    method: 'PATCH',
    url: `/${LEGACY}`,
    headers: headers(ALICE),
    payload: op(ALICE, 92, { name: 'again' })
  });
  assert.strictEqual(unsequenced.statusCode, 200);
  assert.strictEqual(body(unsequenced).name, 'again');
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

test('the owner adds a member: invited, then both old and new members are told', async () => {
  const response = await harness.inject({
    method: 'POST',
    url: `/${CHANNEL}/members`,
    headers: headers(ALICE),
    payload: op(ALICE, 2, { members: [DAVE] })
  });
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(body(response), { member_count: 3, invited: [DAVE] });
  const told = harness.lastEvent();
  assert.strictEqual(told.body.type, 'INVITE_SENT');
  assert.deepStrictEqual(told.recipients.sort(), [ALICE, BOB, CARL].sort());

  await accept(CHANNEL, DAVE);
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

// ---- roles, owner leave and succession (DECISIONS rows 9 / 80) ------------

const ROLES = '01efabcd-7000-8000-8abc-000000000100';
const HANDOVER = '01efabcd-7000-8000-8abc-000000000101';
const SENIORITY = '01efabcd-7000-8000-8abc-000000000102';
const LAST = '01efabcd-7000-8000-8abc-000000000103';
const STRANGER = 'e5f6a7b8c';

/** `op` with a unique op_id, so writes reusing `n` on other channels cannot collide. */
let nonce = 0;
function uop(userId, n, extra = {}) {
  nonce += 1;
  return { ...op(userId, n, extra), op_id: mintOpId(userId, { counter: n, rand: nonce }) };
}

async function newGroup(channelId, creator, members) {
  const response = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(creator),
    payload: uop(creator, 1, { channel_id: channelId, kind: 'group', name: 'Roles', members })
  });
  await accept(channelId, ...members.filter((id) => id !== creator));
  return response;
}

const setRole = (channelId, actor, target, role, n) => harness.inject({
  method: 'PATCH',
  url: `/${channelId}/members/${target}`,
  headers: headers(actor),
  payload: uop(actor, n, { role })
});

const leaveChannel = (channelId, actor, n) => harness.inject({
  method: 'DELETE',
  url: `/${channelId}/members/${actor}`,
  headers: headers(actor),
  payload: uop(actor, n)
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
  await accept(SENIORITY, BOB);

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

const PHOTO = '01efabcd-7000-8000-8abc-000000000104';
const LONE = '01efabcd-7000-8000-8abc-000000000105';

const editGroup = (channelId, actor, n, extra) => harness.inject({
  method: 'PATCH',
  url: `/${channelId}`,
  headers: headers(actor),
  payload: uop(actor, n, extra)
});

test('a replaced or cleared group photo is deleted as its setter\'s file', async () => {
  harness.fileDeletes.length = 0;
  await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(ALICE),
    payload: uop(ALICE, 1, {
      channel_id: PHOTO, kind: 'group', name: 'Photo', avatar_url: 'f1', members: [ALICE, BOB]
    })
  });
  await editGroup(PHOTO, ALICE, 2, { name: 'Renamed' });
  await editGroup(PHOTO, ALICE, 3, { avatar_url: 'f1' });
  assert.deepStrictEqual(harness.fileDeletes, [], 'a rename or the same photo deletes nothing');

  await setRole(PHOTO, ALICE, BOB, 'admin', 4);
  const replaced = await editGroup(PHOTO, BOB, 5, { avatar_url: 'f2#key' });
  assert.strictEqual(replaced.statusCode, 200);
  assert.strictEqual(body(replaced).avatar_url, 'f2#key');
  assert.strictEqual(body(replaced).avatarBy, undefined, 'the setter stays server side');
  await editGroup(PHOTO, ALICE, 6, { avatar_url: null });
  assert.deepStrictEqual(harness.fileDeletes, [
    { fileId: 'f1', owner: ALICE },
    { fileId: 'f2', owner: BOB }
  ]);
});

test('a deleted group takes its photo with it', async () => {
  await editGroup(PHOTO, BOB, 7, { avatar_url: 'f3' });
  harness.fileDeletes.length = 0;
  const deleted = await harness.inject({
    method: 'DELETE', url: `/${PHOTO}`, headers: headers(ALICE), payload: uop(ALICE, 8)
  });
  assert.strictEqual(deleted.statusCode, 204);

  await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(CARL),
    payload: uop(CARL, 1, {
      channel_id: LONE, kind: 'group', name: 'Lone', avatar_url: 'f4', members: [CARL]
    })
  });
  await leaveChannel(LONE, CARL, 2);
  assert.deepStrictEqual(harness.fileDeletes, [
    { fileId: 'f3', owner: BOB },
    { fileId: 'f4', owner: CARL }
  ]);
});
