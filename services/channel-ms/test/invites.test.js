const test = require('node:test');
const assert = require('node:assert');
const { startChannelMs, decodeServerEvent, op, headers } = require('./helper');
const {
  FRAME_CLASS, dmChannelId, encodeEnvelope, toWire, classFlags, userIdBytes
} = require('../../../libs/v3-envelope');
const { dmPairsOf } = require('../../../libs/delivery-manager/undelivered-queue');
const { emptyQueue, closeQueues, idOf } = require('../../message-delivery/test/helper');
const { DEVICE_1 } = require('../../connection-gateway/test/helper');

// Decisions 219-221 (SYNC_PROTOCOL §21): invites, connections, blocks,
// reports and the gate the gateway asks, on the TEST_DB backend.

const ANNA = 'a1a1a1a1a';
const BEN = 'b2b2b2b2b';
const CHLOE = 'c3c3c3c3c';
const DEV = 'd4d4d4d4d';
const EVA = 'e5e5e5e5e';
const GROUP = '01efabcd-7000-8000-8abc-0000000001a1';

/** @type {Awaited<ReturnType<typeof startChannelMs>>} */
let harness;

test.before(async () => { harness = await startChannelMs('channel-ms-invites-test'); });
test.after(async () => {
  await harness.stop();
  await closeQueues();
});

const body = (response) => JSON.parse(response.payload);
const call = (method, url, user, payload) => harness.inject({
  method, url, headers: headers(user), ...(payload === undefined ? {} : { payload })
});
const invite = (from, to) => call('POST', '/invites', from, { user_id: to });
const accept = (user, channelId) => call('POST', `/${channelId}/invite/accept`, user, {});
const decline = (user, channelId, extra = {}) => call('POST', `/${channelId}/invite/decline`, user, extra);
const verdict = async (from, to, cls = 0) => body(await harness.inject({
  method: 'GET', url: `/_internal/gate/${from}/${to}?class=${cls}`
})).verdict;
const snapshot = async (user) => body(await call('GET', '/connections', user));

test('migration: the pairs of 1:1 messages on the timeline start connected, once', async () => {
  const queue = await emptyQueue('channel-ms-invites-queue');
  const row = (name, sender, peer, flags = 0, recipients = [peer, sender]) => queue.append({
    opId: idOf(name),
    ts: 1,
    expiresAt: new Date(Date.now() + 60000),
    recipients,
    sender,
    senderDevice: DEVICE_1,
    envelope: encodeEnvelope(toWire({ opId: idOf(name), peer, payload: Buffer.from([8]), flags }))
  });
  await row('message', ANNA, DEV);
  await row('reaction', DEV, ANNA, classFlags(FRAME_CLASS.MUTATION) + 1);
  // a group's key and receipt over 1:1 prove nothing (decision 220)
  await row('key', BEN, CHLOE, classFlags(FRAME_CLASS.KEY) + 1);
  await row('receipt', CHLOE, BEN, classFlags(FRAME_CLASS.RECEIPT) + 1);
  assert.deepStrictEqual(await queue.dmPairs(), [[ANNA, DEV]]);

  harness.server.context.undeliveredQueue = queue;
  await harness.server.seedConnections();
  assert.strictEqual(await verdict(ANNA, DEV), 'ok');
  assert.strictEqual(await verdict(BEN, CHLOE), 'not_connected');
  // once: with a pair connected it never runs again
  await row('later', BEN, EVA);
  await harness.server.seedConnections();
  assert.strictEqual(await verdict(BEN, EVA), 'not_connected');
  delete harness.server.context.undeliveredQueue;
});

test('dmPairsOf leaves out group rows and messages to oneself', () => {
  const wire = (peer) => encodeEnvelope({ opId: Buffer.alloc(16), peer: userIdBytes(peer) });
  const group = encodeEnvelope({ opId: Buffer.alloc(16), channelId: Buffer.alloc(16, 1) });
  assert.deepStrictEqual(dmPairsOf([
    { sender: parseInt(BEN, 16), envelope: wire(ANNA) },
    { sender: parseInt(ANNA, 16), envelope: wire(BEN) },
    { sender: parseInt(ANNA, 16), envelope: wire(ANNA) },
    { sender: parseInt(ANNA, 16), envelope: group }
  ]), [[ANNA, BEN]]);
});

test('an invite: nothing flows until it is accepted, then both ways', async () => {
  assert.strictEqual(await verdict(ANNA, BEN), 'not_connected');
  const before = harness.published().length;
  const sent = await invite(ANNA, BEN);
  assert.strictEqual(sent.statusCode, 200);
  assert.deepStrictEqual(body(sent), { state: 'sent' });

  // to the invitee as a 1:1 event: they are the peer, the inviter the actor
  const [event] = harness.published().slice(before);
  assert.deepStrictEqual(event.recipients, [BEN]);
  assert.strictEqual(event.envelope.peer, BEN);
  assert.strictEqual(event.senderUserId, ANNA);
  assert.strictEqual(event.channelId, dmChannelId(ANNA, BEN));
  assert.strictEqual(event.envelope.flags, 18, 'class INVITE, wakes');
  assert.strictEqual(event.wakes, true);
  const sentEvent = decodeServerEvent(event);
  assert.strictEqual(sentEvent.type, 'INVITE_SENT');
  assert.deepStrictEqual(sentEvent.inviteSent.users, [BEN]);
  assert.strictEqual(sentEvent.inviteSent.channelId, '');

  // asking again changes nothing and tells nobody
  assert.deepStrictEqual(body(await invite(ANNA, BEN)), { state: 'sent' });
  assert.strictEqual(harness.published().length, before + 1);
  assert.strictEqual(await verdict(ANNA, BEN), 'not_connected');
  assert.strictEqual(await verdict(BEN, ANNA), 'not_connected');

  const dm = dmChannelId(ANNA, BEN);
  const pending = { channel_id: dm, from: ANNA, to: BEN, name: null };
  const [listed] = (await snapshot(BEN)).invites;
  assert.deepStrictEqual({ ...listed, created_at: undefined }, { ...pending, created_at: undefined });
  assert.strictEqual((await snapshot(ANNA)).invites.length, 1, 'the inviter sees it too');

  const accepted = await accept(BEN, dm);
  assert.deepStrictEqual(body(accepted), { state: 'connected' });
  const answer = harness.lastEvent();
  assert.deepStrictEqual(answer.recipients, [ANNA]);
  assert.strictEqual(answer.envelope.peer, ANNA);
  assert.strictEqual(answer.envelope.flags, 19, 'class INVITE, SILENT');
  assert.deepStrictEqual(answer.body.inviteAnswered, {
    channelId: '', user: BEN, answer: 'INVITE_ACCEPTED', atMs: answer.body.inviteAnswered.atMs
  });
  assert.strictEqual(await verdict(ANNA, BEN), 'ok');
  assert.strictEqual(await verdict(BEN, ANNA), 'ok');
  assert.deepStrictEqual(await snapshot(BEN), { connections: [ANNA], blocked: [], invites: [] });
  assert.deepStrictEqual(body(await invite(BEN, ANNA)), { state: 'connected' });
  assert.deepStrictEqual(body(await accept(BEN, dm)).error.code, 'not_found');
});

test('inviting someone who invited you accepts theirs', async () => {
  await invite(CHLOE, ANNA);
  assert.deepStrictEqual(body(await invite(ANNA, CHLOE)), { state: 'connected' });
  assert.strictEqual(harness.lastEvent().body.inviteAnswered.answer, 'INVITE_ACCEPTED');
  assert.strictEqual(await verdict(CHLOE, ANNA), 'ok');
});

test('cancel: only its sender takes an invite back, and the invitee hears of it', async () => {
  await invite(BEN, EVA);
  const dm = dmChannelId(BEN, EVA);
  const notTheirs = await call('DELETE', `/${dm}/invites/${EVA}`, CHLOE);
  assert.strictEqual(notTheirs.statusCode, 403);
  const canceled = await call('DELETE', `/${dm}/invites/${EVA}`, BEN);
  assert.deepStrictEqual(body(canceled), { state: 'none' });
  const { recipients, envelope, body: event } = harness.lastEvent();
  assert.deepStrictEqual(recipients, [EVA]);
  assert.strictEqual(envelope.peer, EVA);
  assert.strictEqual(event.inviteAnswered.answer, 'INVITE_CANCELED');
  assert.deepStrictEqual((await snapshot(EVA)).invites, []);
  assert.deepStrictEqual(body(await call('DELETE', `/${dm}/invites/${EVA}`, BEN)), { state: 'none' });
});

test('Decline & Block: the inviter is blocked, their frames and invites go nowhere', async () => {
  await invite(DEV, BEN);
  const dm = dmChannelId(DEV, BEN);
  const declined = await decline(BEN, dm, { block: true });
  assert.deepStrictEqual(body(declined), { state: 'none' });
  const { recipients, body: event } = harness.lastEvent();
  assert.deepStrictEqual(recipients, [DEV]);
  assert.strictEqual(event.inviteAnswered.answer, 'INVITE_DECLINED');
  assert.deepStrictEqual((await snapshot(BEN)).blocked, [DEV]);
  assert.strictEqual(await verdict(DEV, BEN), 'blocked');

  // a new invite is kept, as far as the blocked one can tell, and never shown
  const before = harness.published().length;
  assert.deepStrictEqual(body(await invite(DEV, BEN)), { state: 'sent' });
  assert.strictEqual(harness.published().length, before, 'nothing reaches the blocker');
  assert.deepStrictEqual((await snapshot(BEN)).invites, []);
  assert.strictEqual((await snapshot(DEV)).invites.length, 1);

  // unblocked, it shows
  await call('DELETE', `/blocks/${DEV}`, BEN);
  assert.strictEqual((await snapshot(BEN)).invites.length, 1);
  assert.strictEqual(await verdict(DEV, BEN), 'not_connected');
  await decline(BEN, dm);
});

test('a block stops a connection\'s frames, not a shared group\'s keys and receipts', async () => {
  // ANNA and BEN are connected; ANNA and EVA are not
  await call('POST', '/blocks', ANNA, { user_id: BEN });
  assert.strictEqual(await verdict(BEN, ANNA), 'blocked');
  assert.strictEqual(await verdict(ANNA, BEN), 'ok', 'only the blocked one is stopped');

  const create = await call('POST', '/', ANNA, op(ANNA, 1, {
    channel_id: GROUP, kind: 'group', name: 'Family', members: [ANNA, BEN]
  }));
  assert.strictEqual(create.statusCode, 201);
  // BEN is invited, not a member: no group exception yet
  assert.strictEqual(await verdict(BEN, ANNA, FRAME_CLASS.KEY), 'blocked');
  await accept(BEN, GROUP);
  const classes = [FRAME_CLASS.KEY, FRAME_CLASS.RECEIPT, FRAME_CLASS.RESEND];
  assert.deepStrictEqual(
    await Promise.all(classes.map((cls) => verdict(BEN, ANNA, cls))), ['ok', 'ok', 'ok']
  );
  assert.strictEqual(await verdict(BEN, ANNA, FRAME_CLASS.MESSAGE), 'blocked');
  await call('DELETE', `/blocks/${BEN}`, ANNA);
  assert.strictEqual(await verdict(BEN, ANNA), 'ok');
});

test('co-members who are not connected trade keys, receipts and resends only', async () => {
  // EVA joins ANNA's group through a connection of ANNA's
  await invite(ANNA, EVA);
  await accept(EVA, dmChannelId(ANNA, EVA));
  await call('POST', `/${GROUP}/members`, ANNA, op(ANNA, 2, { members: [EVA] }));
  await accept(EVA, GROUP);
  assert.strictEqual(await verdict(BEN, EVA, FRAME_CLASS.KEY), 'ok');
  assert.strictEqual(await verdict(EVA, BEN, FRAME_CLASS.RECEIPT), 'ok');
  assert.strictEqual(await verdict(EVA, BEN, FRAME_CLASS.RESEND), 'ok');
  assert.strictEqual(await verdict(EVA, BEN, FRAME_CLASS.MESSAGE), 'not_connected');
  assert.strictEqual(await verdict(EVA, BEN, FRAME_CLASS.MUTATION), 'not_connected');
});

test('a group invite declined or canceled: the members hear of it', async () => {
  await call('POST', `/${GROUP}/members`, ANNA, op(ANNA, 3, { members: [CHLOE] }));
  const listed = (await snapshot(CHLOE)).invites;
  assert.deepStrictEqual(listed.map((i) => [i.channel_id, i.from, i.name]), [[GROUP, ANNA, 'Family']]);
  assert.ok((await snapshot(BEN)).invites.some((i) => i.to === CHLOE), 'members see who is invited');

  await decline(CHLOE, GROUP);
  let last = harness.lastEvent();
  assert.deepStrictEqual(last.recipients.sort(), [ANNA, BEN, EVA].sort());
  assert.deepStrictEqual(
    [last.body.inviteAnswered.channelId, last.body.inviteAnswered.answer], [GROUP, 'INVITE_DECLINED']
  );

  await call('POST', `/${GROUP}/members`, ANNA, op(ANNA, 4, { members: [CHLOE] }));
  const forbidden = await call('DELETE', `/${GROUP}/invites/${CHLOE}`, EVA);
  assert.strictEqual(forbidden.statusCode, 403, 'a plain member may not');
  await call('DELETE', `/${GROUP}/invites/${CHLOE}`, ANNA);
  last = harness.lastEvent();
  assert.deepStrictEqual(last.recipients.sort(), [ANNA, BEN, CHLOE, EVA].sort());
  assert.strictEqual(last.body.inviteAnswered.answer, 'INVITE_CANCELED');
});

test('pending 1:1 invites are capped', async () => {
  const { options } = harness.server;
  const max = options.invitePendingMax;
  options.invitePendingMax = 1;
  try {
    await invite(CHLOE, DEV);
    const over = await invite(CHLOE, EVA);
    assert.strictEqual(over.statusCode, 429);
    assert.strictEqual(body(over).error.code, 'invite_limit');
  } finally {
    options.invitePendingMax = max;
  }
});

test('a report keeps up to the last 5 messages, 90 days', async () => {
  const message = (n) => ({ author: DEV, body: `spam ${n}`, content_type: 'text/plain', sent_at: n });
  const six = await call('POST', '/reports', ANNA, {
    user_id: DEV, messages: [1, 2, 3, 4, 5, 6].map(message)
  });
  assert.strictEqual(six.statusCode, 400);
  const filed = await call('POST', '/reports', ANNA, { user_id: DEV, messages: [message(1)] });
  assert.strictEqual(filed.statusCode, 201);
  assert.strictEqual((await call('POST', '/reports', ANNA, { user_id: DEV })).statusCode, 201);

  const count = async () => {
    if (harness.db) return harness.db.collection('reports').countDocuments({ reported: DEV });
    const { rows } = await harness.server.context.pgPool.query(
      'SELECT count(*)::int AS n FROM reports WHERE reported = $1', [DEV]
    );
    return rows[0].n;
  };
  assert.strictEqual(await count(), 2);
  await harness.server.db.purgeReports(new Date(Date.now() - 60000));
  assert.strictEqual(await count(), 2, 'younger than the cut-off');
  await harness.server.db.purgeReports(new Date(Date.now() + 60000));
  assert.strictEqual(await count(), 0);
});

test('a deleted account takes its invites, connections and blocks with it', async () => {
  await call('POST', '/blocks', EVA, { user_id: DEV });
  const removed = await harness.inject({
    method: 'POST', url: '/_internal/members/remove', payload: { user_id: EVA }
  });
  assert.strictEqual(removed.statusCode, 200);
  assert.deepStrictEqual(await snapshot(EVA), { connections: [], blocked: [], invites: [] });
  assert.ok(!(await snapshot(ANNA)).connections.includes(EVA));
  assert.strictEqual(await verdict(EVA, ANNA), 'not_connected');
});
