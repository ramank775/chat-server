const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startProfileMs, signupWithUsername, bearer } = require('./helpers/profile-ms');
const { canSee } = require('../services/profile-ms/presence');

test('canSee: each must share with the other (WhatsApp reciprocity)', () => {
  const everyone = { presence: null };
  const contacts = { presence: 'contacts' };
  const nobody = { presence: 'nobody' };
  assert.equal(canSee(everyone, everyone, false), true, 'the default is everyone');
  assert.equal(canSee(nobody, everyone, true), false, 'hidden from all');
  assert.equal(canSee(everyone, nobody, true), false, 'hide yours, see nobody');
  assert.equal(canSee(contacts, everyone, false), false, 'not a contact');
  assert.equal(canSee(contacts, everyone, true), true);
  assert.equal(canSee(everyone, contacts, false), false, 'you hide yours from them');
  assert.equal(canSee(contacts, contacts, true), true);
  assert.equal(canSee(everyone, everyone, true, true), false, 'a block hides it, either way');
});

test('canSee: only and except name contacts by user id (labels stay on the phone)', () => {
  const bob = { user_id: 'b0b000000', presence: null };
  const carl = { user_id: 'ca7100000', presence: null };
  const only = { user_id: 'a11ce0000', presence: 'only', presenceUsers: [bob.user_id] };
  const except = { user_id: 'a11ce0000', presence: 'except', presenceUsers: [bob.user_id] };
  assert.equal(canSee(only, bob, true), true);
  assert.equal(canSee(only, carl, true), false, 'not listed');
  assert.equal(canSee(only, bob, false), false, 'listed, but no longer a contact');
  assert.equal(canSee(bob, only, true), true, 'only shares with bob, so sees him');
  assert.equal(canSee(carl, only, true), false, 'reciprocity: hidden from carl, sees not his');
  assert.equal(canSee(except, bob, true), false, 'the exception');
  assert.equal(canSee(except, carl, true), true);
  assert.equal(canSee(except, carl, false), false, 'contacts only');
  assert.equal(canSee({ presence: 'only' }, bob, true), false, 'an empty list is nobody');
});

describe('presence: setting, last seen and who may see it (SYNC_PROTOCOL 22)', () => {
  /** @type {Awaited<ReturnType<typeof startProfileMs>>} */
  let app;

  before(async () => {
    app = await startProfileMs('profile_ms_test_presence');
  });

  after(async () => {
    await app.stop();
  });

  let phone = 0;
  const user = async () => {
    phone += 1;
    const n = String(phone).padStart(2, '0');
    return signupWithUsername(app, { phone: `+9195000000${n}`, username: `presence_${n}` });
  };
  const setPresence = (session, presence) =>
    app.inject({
      method: 'PATCH', url: '/users/me', headers: bearer(session.accesskey), payload: { presence }
    });
  const ask = async (target, viewers, seen = false) => {
    const res = await app.inject({
      method: 'POST',
      url: '/_internal/presence',
      payload: { user_id: target.user_id, viewers: viewers.map((v) => v.user_id), seen }
    });
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.payload);
  };
  const visible = async (target, viewer) => (await ask(target, [viewer])).viewers.length === 1;

  test('users/me carries the setting, everyone by default, and PATCH takes the three values only', async () => {
    const alice = await user();
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: bearer(alice.accesskey) });
    assert.equal(JSON.parse(me.payload).presence, 'everyone');

    const res = await setPresence(alice, 'contacts');
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).presence, 'contacts');
    assert.equal((await setPresence(alice, 'friends')).statusCode, 400);
  });

  const setListed = (session, presence, presenceUsers) =>
    app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: bearer(session.accesskey),
      payload: { presence, presenceUsers }
    });

  test('only / except take a list of user ids, capped, and nothing else does', async () => {
    const alice = await user();
    const bob = await user();
    const ok = await setListed(alice, 'only', [bob.user_id]);
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.payload).presence, 'only');
    assert.equal((await setListed(alice, 'except', [])).statusCode, 200, 'empty is fine');
    assert.equal((await setPresence(alice, 'only')).statusCode, 400, 'only needs its list');
    assert.equal((await setListed(alice, 'contacts', [bob.user_id])).statusCode, 400);
    assert.equal((await setListed(alice, 'only', ['Not an id'])).statusCode, 400);
    assert.equal((await setListed(alice, 'only', [bob.user_id, bob.user_id])).statusCode, 400);
    const many = Array.from({ length: 1001 }, (_, i) => i.toString(16).padStart(9, '0'));
    assert.equal((await setListed(alice, 'only', many)).statusCode, 400, 'at most 1000');
    assert.equal((await setListed(alice, 'only', many.slice(0, 1000))).statusCode, 200);
    const row = await app.db.collection('users').findOne({ user_id: alice.user_id });
    assert.equal(row.presenceUsers.length, 1000, 'stored');
    await setPresence(alice, 'nobody');
    const cleared = await app.db.collection('users').findOne({ user_id: alice.user_id });
    assert.equal(cleared.presenceUsers, null, 'a plain setting drops the list');
  });

  test('only: the listed contacts; except: every contact but them', async () => {
    const alice = await user();
    const bob = await user();
    const carl = await user();
    app.connect(alice, bob);
    app.connect(alice, carl);
    await setListed(alice, 'only', [bob.user_id]);
    assert.deepEqual((await ask(alice, [bob, carl])).viewers, [bob.user_id]);
    assert.equal(await visible(carl, alice), false, 'reciprocity');
    await setListed(alice, 'except', [bob.user_id]);
    assert.deepEqual((await ask(alice, [bob, carl])).viewers, [carl.user_id]);
    const dave = await user();
    assert.equal(await visible(alice, dave), false, 'except is still contacts only');
  });

  test('a new list under the same setting tells the gateway too', async () => {
    const alice = await user();
    const bob = await user();
    await setListed(alice, 'only', []);
    const sent = app.revokes.length;
    await setListed(alice, 'only', []);
    assert.equal(app.revokes.length, sent, 'nothing changed');
    await setListed(alice, 'only', [bob.user_id]);
    assert.deepEqual(app.revokes.slice(sent), [{ user_id: alice.user_id }]);
  });

  test('a change of setting tells the gateway, so watchers see it at once', async () => {
    const alice = await user();
    const sent = app.revokes.length;
    await setPresence(alice, 'nobody');
    assert.deepEqual(app.revokes.slice(sent), [{ user_id: alice.user_id }]);
  });

  test('seen stamps last seen; without it the stamp is read back', async () => {
    const alice = await user();
    const bob = await user();
    assert.equal((await ask(alice, [bob])).last_seen_ms, 0, 'never seen');
    const t0 = Date.now();
    const stamped = await ask(alice, [bob], true);
    assert.ok(stamped.last_seen_ms >= t0 - 1000 && stamped.last_seen_ms <= Date.now());
    assert.equal((await ask(alice, [bob])).last_seen_ms, stamped.last_seen_ms);
    assert.deepEqual(stamped.viewers, [bob.user_id]);
  });

  test('nobody hides from everyone, and its owner sees nobody', async () => {
    const alice = await user();
    const bob = await user();
    await setPresence(alice, 'nobody');
    assert.equal(await visible(alice, bob), false);
    assert.equal(await visible(bob, alice), false, 'reciprocity');
  });

  test('contacts: people connected by an accepted invite (decision 219)', async () => {
    const alice = await user();
    const bob = await user();
    const carl = await user();
    await setPresence(alice, 'contacts');
    assert.equal(await visible(alice, bob), false);
    app.connect(alice, bob);
    assert.equal(await visible(alice, bob), true);
    assert.equal(await visible(bob, alice), true, 'everyone, and alice shares with her contact bob');
    assert.equal(await visible(alice, carl), false);
    assert.equal(await visible(carl, alice), false, 'alice hides hers from carl, so cannot see his');
    assert.deepEqual((await ask(alice, [bob, carl])).viewers, [bob.user_id]);
  });

  test('a block hides presence both ways, whatever the setting (decision 219)', async () => {
    const alice = await user();
    const bob = await user();
    assert.equal(await visible(alice, bob), true, 'everyone, by default');
    app.connect(alice, bob);
    app.block(bob, alice);
    assert.equal(await visible(alice, bob), false);
    assert.equal(await visible(bob, alice), false);
  });

  test('an unknown viewer or target sees and is seen by nobody', async () => {
    const alice = await user();
    const ghost = { user_id: 'fffffffff' };
    assert.equal(await visible(alice, ghost), false);
    assert.deepEqual(await ask(ghost, [alice], true), { last_seen_ms: 0, viewers: [] });
  });

  test('deleting an account forgets its last seen and its list', async () => {
    const alice = await user();
    await ask(alice, [], true);
    await setListed(alice, 'only', ['b0b000000']);
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/delete',
      headers: bearer(alice.accesskey),
      payload: { confirmation: `DELETE presence_${String(phone).padStart(2, '0')}` }
    });
    assert.equal(res.statusCode, 200);
    const row = await app.db.collection('users').findOne({ user_id: alice.user_id });
    assert.equal(row.lastSeenAt, null);
    assert.equal(row.presenceUsers, null);
  });
});
