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

  test('deleting an account forgets its last seen', async () => {
    const alice = await user();
    await ask(alice, [], true);
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/delete',
      headers: bearer(alice.accesskey),
      payload: { confirmation: `DELETE presence_${String(phone).padStart(2, '0')}` }
    });
    assert.equal(res.statusCode, 200);
    const row = await app.db.collection('users').findOne({ user_id: alice.user_id });
    assert.equal(row.lastSeenAt, null);
  });
});
