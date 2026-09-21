const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sha256 } = require('../helper');
const { startProfileMs, signup, signupWithUsername, bearer } = require('./helpers/profile-ms');

describe('contact discovery (AUTH_CONTRACT 7)', () => {
  /** @type {Awaited<ReturnType<typeof startProfileMs>>} */
  let app;

  before(async () => {
    app = await startProfileMs('profile_ms_test_discovery');
  });

  after(async () => {
    await app.stop();
  });

  const getUser = (accesskey, userId) =>
    app.inject({ method: 'GET', url: `/users/${userId}`, headers: bearer(accesskey) });
  const byUsername = (accesskey, username, key) =>
    app.inject({
      method: 'GET',
      url: `/users/by-username/${username}${key === undefined ? '' : `?key=${key}`}`,
      headers: bearer(accesskey)
    });
  const lookup = (accesskey, phoneHashes) =>
    app.inject({
      method: 'POST',
      url: '/contacts/lookup',
      headers: bearer(accesskey),
      payload: { phoneHashes }
    });

  test('GET users/{user_id} is the public profile, never the phone', async () => {
    const target = await signupWithUsername(app, {
      phone: '+919300000001',
      username: 'public_one'
    });
    await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: bearer(target.accesskey),
      payload: { displayName: 'Public One', statusText: 'here' }
    });
    const reader = await signupWithUsername(app, { phone: '+919300000002', username: 'reader_one' });

    const res = await getUser(reader.accesskey, target.user_id);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.payload), {
      user_id: target.user_id,
      username: 'public_one',
      displayName: 'Public One',
      avatarUrl: null,
      statusText: 'here'
    });
  });

  test('an unknown user_id is 404 USER_NOT_FOUND', async () => {
    const reader = await signupWithUsername(app, { phone: '+919300000003', username: 'reader_two' });
    const res = await getUser(reader.accesskey, 'deadbeef1');
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.payload).error.code, 'USER_NOT_FOUND');
  });

  test('discovery needs an accesskey', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/by-username/public_one' });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.payload).error.code, 'MISSING_ACCESSKEY');
  });

  test('by-username matches case insensitively and hides the phone', async () => {
    await signupWithUsername(app, { phone: '+919300000004', username: 'handle_one' });
    const reader = await signupWithUsername(app, {
      phone: '+919300000005',
      username: 'reader_three'
    });

    const res = await byUsername(reader.accesskey, 'HaNdLe_One');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.username, 'handle_one');
    assert.equal(body.phone, undefined);

    const missing = await byUsername(reader.accesskey, 'no_such_handle');
    assert.equal(missing.statusCode, 404);
    assert.equal(JSON.parse(missing.payload).error.code, 'USER_NOT_FOUND');
  });

  test('a keyed handle needs its key; a wrong key looks like no user at all', async () => {
    const keyed = await signupWithUsername(app, { phone: '+919300000006', username: 'keyed_one' });
    await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: bearer(keyed.accesskey),
      payload: { usernameKey: '4821' }
    });
    const reader = await signupWithUsername(app, {
      phone: '+919300000007',
      username: 'reader_four'
    });

    const omitted = await byUsername(reader.accesskey, 'keyed_one');
    assert.equal(omitted.statusCode, 404);
    assert.equal(JSON.parse(omitted.payload).error.code, 'USERNAME_KEY_REQUIRED');

    const wrong = await byUsername(reader.accesskey, 'keyed_one', '0000');
    assert.equal(wrong.statusCode, 404);
    assert.equal(
      JSON.parse(wrong.payload).error.code,
      'USER_NOT_FOUND',
      'a wrong key is indistinguishable from an unknown handle (7.6)'
    );

    const right = await byUsername(reader.accesskey, 'keyed_one', '4821');
    assert.equal(right.statusCode, 200);
    assert.equal(JSON.parse(right.payload).user_id, keyed.user_id);
  });

  test('by-username is capped at 60 lookups a minute per user', async () => {
    const reader = await signupWithUsername(app, {
      phone: '+919300000008',
      username: 'reader_five'
    });
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await byUsername(reader.accesskey, 'handle_one');
      assert.equal(res.statusCode, 200, `lookup ${i} should be within budget`);
    }
    const limited = await byUsername(reader.accesskey, 'handle_one');
    assert.equal(limited.statusCode, 429);
    const { error } = JSON.parse(limited.payload);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.scope, 'user');
    assert.equal(error.retryAfterSec, 60);
  });

  test('contacts/lookup answers only the hashes it knows', async () => {
    const known = await signupWithUsername(app, { phone: '+919300000009', username: 'contact_one' });
    const noHandle = await signup(app, { phone: '+919300000010' });
    const reader = await signupWithUsername(app, { phone: '+919300000011', username: 'reader_six' });

    const res = await lookup(reader.accesskey, [
      sha256('+919300000009'),
      sha256('+919300000010'),
      sha256('+919300000011'),
      sha256('+919999999999')
    ]);
    assert.equal(res.statusCode, 200);
    const { matches } = JSON.parse(res.payload);
    const byId = new Map(matches.map((match) => [match.user_id, match]));
    assert.equal(matches.length, 2, 'the unknown hash and the caller are absent');
    assert.deepEqual(byId.get(known.user_id), {
      phoneHash: sha256('+919300000009'),
      user_id: known.user_id,
      username: 'contact_one'
    });
    assert.equal(byId.get(noHandle.user_id).username, null, 'a handle-less account still resolves');
    assert.equal(matches.some((match) => match.phone !== undefined), false);
  });

  test('more than 100 hashes is BATCH_TOO_LARGE, a malformed one is a schema error', async () => {
    const reader = await signupWithUsername(app, {
      phone: '+919300000012',
      username: 'reader_seven'
    });
    const hashes = Array.from({ length: 101 }, (_, i) => sha256(`+9199000000${i}`));
    const tooMany = await lookup(reader.accesskey, hashes);
    assert.equal(tooMany.statusCode, 400);
    assert.equal(JSON.parse(tooMany.payload).error.code, 'BATCH_TOO_LARGE');

    const malformed = await lookup(reader.accesskey, ['not-a-sha256']);
    assert.equal(malformed.statusCode, 400);
    assert.equal(JSON.parse(malformed.payload).error.code, 'validation_failed');

    const empty = await lookup(reader.accesskey, []);
    assert.equal(empty.statusCode, 400);
  });

  test('the daily contact budget is spent in hashes, not requests', async () => {
    const reader = await signupWithUsername(app, {
      phone: '+919300000013',
      username: 'reader_eight'
    });
    const batch = Array.from({ length: 100 }, (_, i) => sha256(`+9198000000${i}`));
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await lookup(reader.accesskey, batch);
      assert.equal(res.statusCode, 200, `batch ${i} is within the 500/day budget`);
    }
    const limited = await lookup(reader.accesskey, batch);
    assert.equal(limited.statusCode, 429);
    const { error } = JSON.parse(limited.payload);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.scope, 'user');
  });
});
