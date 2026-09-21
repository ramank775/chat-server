const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startProfileMs, signup, signupWithUsername, bearer } = require('./helpers/profile-ms');

describe('users/me and username rules', () => {
  /** @type {Awaited<ReturnType<typeof startProfileMs>>} */
  let app;

  before(async () => {
    app = await startProfileMs('profile_ms_test_users');
  });

  after(async () => {
    await app.stop();
  });

  const me = (accesskey) =>
    app.inject({ method: 'GET', url: '/users/me', headers: bearer(accesskey) });
  const patch = (accesskey, payload) =>
    app.inject({ method: 'PATCH', url: '/users/me', headers: bearer(accesskey), payload });
  const check = (accesskey, username) =>
    app.inject({
      method: 'POST',
      url: '/users/username/check',
      headers: bearer(accesskey),
      payload: { username }
    });

  test('GET users/me returns the owner view with phone and a null username', async () => {
    const session = await signup(app, { phone: '+919200000001' });
    const res = await me(session.accesskey);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.payload), {
      user_id: session.user_id,
      username: null,
      phone: '+919200000001',
      displayName: null,
      avatarUrl: null,
      statusText: null,
      createdAt: JSON.parse(res.payload).createdAt
    });
    assert.ok(JSON.parse(res.payload).createdAt > 0);
  });

  test('users/me requires an accesskey', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/me' });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.payload).error.code, 'MISSING_ACCESSKEY');
  });

  test('PATCH updates the free form fields and rejects unknown ones', async () => {
    const session = await signup(app, { phone: '+919200000002' });
    const res = await patch(session.accesskey, {
      displayName: 'Alice K.',
      statusText: 'Off the grid'
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.displayName, 'Alice K.');
    assert.equal(body.statusText, 'Off the grid');

    const cleared = await patch(session.accesskey, { statusText: null });
    assert.equal(JSON.parse(cleared.payload).statusText, null);
    assert.equal(JSON.parse(cleared.payload).displayName, 'Alice K.', 'absent means unchanged');

    const unknown = await patch(session.accesskey, { nickname: 'nope' });
    assert.equal(unknown.statusCode, 400);
    assert.equal(JSON.parse(unknown.payload).error.code, 'validation_failed');
  });

  test('username shape rules', async () => {
    const session = await signup(app, { phone: '+919200000003' });
    const invalid = ['ab', 'Alice', '1alice', 'a'.repeat(31), 'al..ice', 'al__ice', 'www.alice', 'alice.com', 'ali ce'];
    for (let i = 0; i < invalid.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await patch(session.accesskey, { username: invalid[i] });
      assert.equal(res.statusCode, 400, `${invalid[i]} should be rejected`);
      assert.equal(JSON.parse(res.payload).error.code, 'INVALID_USERNAME');
    }
    const ok = await patch(session.accesskey, { username: 'a.li_ce3' });
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.payload).username, 'a.li_ce3');
  });

  test('reserved usernames are 409 USERNAME_RESERVED', async () => {
    const session = await signup(app, { phone: '+919200000004' });
    const res = await patch(session.accesskey, { username: 'support' });
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.payload).error.code, 'USERNAME_RESERVED');
  });

  test('usernames are unique case insensitively', async () => {
    const owner = await signupWithUsername(app, { phone: '+919200000005', username: 'taken_name' });
    const other = await signup(app, { phone: '+919200000006' });

    const conflict = await patch(other.accesskey, { username: 'taken_name' });
    assert.equal(conflict.statusCode, 409);
    assert.equal(JSON.parse(conflict.payload).error.code, 'USERNAME_TAKEN');

    const checkUpper = await check(other.accesskey, 'TAKEN_NAME');
    assert.deepEqual(JSON.parse(checkUpper.payload), { available: false, reason: 'taken' });

    const checkSelf = await check(owner.accesskey, 'taken_name');
    assert.deepEqual(JSON.parse(checkSelf.payload), { available: true }, 'own name is available to itself');
  });

  test('username/check reports invalid and reserved candidates', async () => {
    const session = await signup(app, { phone: '+919200000007' });
    assert.deepEqual(JSON.parse((await check(session.accesskey, 'no')).payload), {
      available: false,
      reason: 'invalid'
    });
    assert.deepEqual(JSON.parse((await check(session.accesskey, 'admin')).payload), {
      available: false,
      reason: 'reserved'
    });
    assert.deepEqual(JSON.parse((await check(session.accesskey, 'free_handle')).payload), {
      available: true
    });
  });

  test('first set is exempt, the next change starts the 90 day clock', async () => {
    const session = await signup(app, { phone: '+919200000008' });

    const first = await patch(session.accesskey, { username: 'clock_one' });
    assert.equal(first.statusCode, 200);
    let row = await app.db.collection('users').findOne({ user_id: session.user_id });
    assert.equal(row.usernameChangedAt, null, 'the first ever set does not consume the budget');

    const rename = await patch(session.accesskey, { username: 'clock_two' });
    assert.equal(rename.statusCode, 200, 'the rename right after the first set is allowed');
    row = await app.db.collection('users').findOne({ user_id: session.user_id });
    assert.ok(row.usernameChangedAt instanceof Date, 'the rename starts the clock');

    const blocked = await patch(session.accesskey, { username: 'clock_three' });
    assert.equal(blocked.statusCode, 429);
    const { error } = JSON.parse(blocked.payload);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.scope, 'user');
    assert.ok(error.retryAfterSec > 0 && error.retryAfterSec <= 90 * 24 * 3600);

    // 90 days later the change is allowed again
    await app.db
      .collection('users')
      .updateOne(
        { user_id: session.user_id },
        { $set: { usernameChangedAt: new Date(Date.now() - 91 * 24 * 3600 * 1000) } }
      );
    const allowed = await patch(session.accesskey, { username: 'clock_three' });
    assert.equal(allowed.statusCode, 200);
  });

  test('re-sending the same username is a no-op, not a rate limited change', async () => {
    const session = await signupWithUsername(app, { phone: '+919200000009', username: 'idem_name' });
    const again = await patch(session.accesskey, { username: 'idem_name' });
    assert.equal(again.statusCode, 200);
    const row = await app.db.collection('users').findOne({ user_id: session.user_id });
    assert.equal(row.usernameChangedAt, null);
  });

  test('usernameKey must be four digits and needs a username', async () => {
    const session = await signup(app, { phone: '+919200000010' });

    const tooEarly = await patch(session.accesskey, { usernameKey: '1234' });
    assert.equal(tooEarly.statusCode, 400);
    assert.equal(JSON.parse(tooEarly.payload).error.code, 'INVALID_USERNAME_KEY');

    await patch(session.accesskey, { username: 'key_holder' });
    const bad = await patch(session.accesskey, { usernameKey: '12a4' });
    assert.equal(bad.statusCode, 400);
    assert.equal(JSON.parse(bad.payload).error.code, 'INVALID_USERNAME_KEY');

    const ok = await patch(session.accesskey, { usernameKey: '4821' });
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.payload).usernameKey, undefined, 'the key is never echoed');
    let row = await app.db.collection('users').findOne({ user_id: session.user_id });
    assert.ok(row.usernameKeyHash && !row.usernameKeyHash.includes('4821'), 'stored hashed');

    const cleared = await patch(session.accesskey, { usernameKey: null });
    assert.equal(cleared.statusCode, 200);
    row = await app.db.collection('users').findOne({ user_id: session.user_id });
    assert.equal(row.usernameKeyHash, null);
  });

  test('clearing the username clears the key and re-arms the gate', async () => {
    const session = await signupWithUsername(app, { phone: '+919200000011', username: 'to_clear' });
    await patch(session.accesskey, { usernameKey: '1111' });

    const cleared = await patch(session.accesskey, { username: null });
    assert.equal(cleared.statusCode, 200);
    assert.equal(JSON.parse(cleared.payload).username, null);
    const row = await app.db.collection('users').findOne({ user_id: session.user_id });
    assert.equal(row.usernameKeyHash, null);

    const gated = await app.inject({
      method: 'GET',
      url: '/auth',
      headers: { ...bearer(session.accesskey), 'x-original-uri': '/v3.0/channels' }
    });
    assert.equal(gated.statusCode, 403);
    assert.equal(JSON.parse(gated.payload).error.code, 'USERNAME_REQUIRED');
  });

  test('the USERNAME_REQUIRED gate blocks every non exempt route', async () => {
    const session = await signup(app, { phone: '+919200000012' });
    const subrequest = (originalUri) =>
      app.inject({
        method: 'GET',
        url: '/auth',
        headers: { ...bearer(session.accesskey), 'x-original-uri': originalUri }
      });

    const gated = ['/v3.0/channels', '/v3.0/messages', '/v3.0/users/me/delete', '/v3.0/contacts/lookup'];
    for (let i = 0; i < gated.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await subrequest(gated[i]);
      assert.equal(res.statusCode, 403, gated[i]);
      assert.equal(JSON.parse(res.payload).error.code, 'USERNAME_REQUIRED');
    }

    const exempt = ['/v3.0/users/me', '/v3.0/users/username/check', '/v3.0/auth/session/revoke', '/wss'];
    for (let i = 0; i < exempt.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await subrequest(exempt[i])).statusCode, 200, exempt[i]);
    }
    // the service's own exempt routes answer while the username is null
    assert.equal((await me(session.accesskey)).statusCode, 200);
    assert.equal((await check(session.accesskey, 'anything_goes')).statusCode, 200);

    await patch(session.accesskey, { username: 'gate_open' });
    assert.equal((await subrequest('/v3.0/channels')).statusCode, 200);
  });
});
