const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sha256 } = require('../helper');
const { TEST_DB } = require('./helpers/db');
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

  test('more than 5,000 hashes is BATCH_TOO_LARGE, a malformed one is a schema error', async () => {
    const reader = await signupWithUsername(app, {
      phone: '+919300000012',
      username: 'reader_seven'
    });
    const hashes = Array.from({ length: 5001 }, (_, i) => sha256(`+919900${i}`));
    const tooMany = await lookup(reader.accesskey, hashes);
    assert.equal(tooMany.statusCode, 400);
    assert.equal(JSON.parse(tooMany.payload).error.code, 'BATCH_TOO_LARGE');

    const malformed = await lookup(reader.accesskey, ['not-a-sha256']);
    assert.equal(malformed.statusCode, 400);
    assert.equal(JSON.parse(malformed.payload).error.code, 'validation_failed');

    const empty = await lookup(reader.accesskey, []);
    assert.equal(empty.statusCode, 400);
  });

  test('5,000 hashes a request, with no daily budget (decision 208)', async () => {
    const reader = await signupWithUsername(app, {
      phone: '+919300000013',
      username: 'reader_eight'
    });
    const batch = Array.from({ length: 5000 }, (_, i) => sha256(`+919800${i}`));
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await lookup(reader.accesskey, batch);
      assert.equal(res.statusCode, 200, `lookup ${i}`);
    }
  });

  // ---- decision 223: discoverability -------------------------------------

  const setMode = (accesskey, payload) =>
    app.inject({ method: 'PUT', url: '/users/me/discoverability', headers: bearer(accesskey), payload });
  const found = async (accesskey, phone) =>
    JSON.parse((await lookup(accesskey, [sha256(phone)])).payload).matches.map((m) => m.user_id);
  /** The stored chosen list, which no route returns. */
  const tokensOf = async (userId) => {
    if (TEST_DB === 'pg') {
      const { rows } = await app.raw.query('SELECT discovery_tokens FROM users WHERE user_id = $1', [userId]);
      return rows[0].discovery_tokens;
    }
    return (await app.raw.collection('users').findOne({ user_id: userId })).discoveryTokens;
  };

  test('nobody: not found by number, still found by username', async () => {
    const owner = await signupWithUsername(app, { phone: '+919300000020', username: 'hidden_one' });
    const reader = await signupWithUsername(app, { phone: '+919300000021', username: 'reader_nine' });
    assert.deepEqual(await found(reader.accesskey, '+919300000020'), [owner.user_id],
      'an account that never chose is found by everyone');

    const res = await setMode(owner.accesskey, { mode: 'nobody' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.payload), { mode: 'nobody', count: 0 });
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: bearer(owner.accesskey) });
    assert.equal(JSON.parse(me.payload).discoverability, 'nobody');

    assert.deepEqual(await found(reader.accesskey, '+919300000020'), []);
    assert.equal((await byUsername(reader.accesskey, 'hidden_one')).statusCode, 200);
  });

  test('chosen: only the numbers on the list find the account, kept as tokens only', async () => {
    const owner = await signupWithUsername(app, { phone: '+919300000030', username: 'choosy_one' });
    const friend = await signupWithUsername(app, { phone: '+919300000031', username: 'friend_one' });
    const stranger = await signupWithUsername(app, { phone: '+919300000032', username: 'stranger_one' });

    const res = await setMode(owner.accesskey, {
      mode: 'chosen',
      // the second one is not on Vartalap yet
      phoneHashes: [sha256('+919300000031'), sha256('+919300000039'), sha256('+919300000031')]
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.payload), { mode: 'chosen', count: 2 });

    assert.deepEqual(await found(friend.accesskey, '+919300000030'), [owner.user_id]);
    assert.deepEqual(await found(stranger.accesskey, '+919300000030'), []);
    const later = await signupWithUsername(app, { phone: '+919300000039', username: 'later_one' });
    assert.deepEqual(await found(later.accesskey, '+919300000030'), [owner.user_id],
      'a chosen number that joins later finds them too');

    const tokens = await tokensOf(owner.user_id);
    assert.equal(tokens.length, 2);
    const plain = ['+919300000031', '+919300000039'].flatMap((p) => [p, sha256(p), app.server.keyOfPhone(p)]);
    assert.equal(tokens.some((token) => plain.includes(token)), false, 'no number in any readable form');
    const me = JSON.parse((await app.inject({
      method: 'GET', url: '/users/me', headers: bearer(owner.accesskey)
    })).payload);
    assert.equal(me.discoverability, 'chosen');
    assert.equal(Object.keys(me).some((field) => /token|chosen|hashes/i.test(field)), false);

    // leaving `chosen` drops the list
    await setMode(owner.accesskey, { mode: 'everyone' });
    assert.equal(await tokensOf(owner.user_id), null);
    assert.deepEqual(await found(stranger.accesskey, '+919300000030'), [owner.user_id]);
  });

  test('chosen takes a list of at most 500; the other modes take none', async () => {
    const owner = await signupWithUsername(app, { phone: '+919300000040', username: 'rules_one' });
    const bad = [
      { mode: 'chosen' },
      { mode: 'everyone', phoneHashes: [sha256('+919300000041')] },
      { mode: 'friends' },
      { mode: 'chosen', phoneHashes: ['not-a-hash'] },
      { mode: 'chosen', phoneHashes: Array.from({ length: 501 }, (_, i) => sha256(`+9193001${i}`)) }
    ];
    const codes = await Promise.all(bad.map(async (payload) => (await setMode(owner.accesskey, payload)).statusCode));
    assert.deepEqual(codes, bad.map(() => 400));
    const empty = await setMode(owner.accesskey, { mode: 'chosen', phoneHashes: [] });
    assert.deepEqual(JSON.parse(empty.payload), { mode: 'chosen', count: 0 }, 'an empty list is nobody by number');
  });

  test('past the per-minute chosen-check budget a match looks unknown', async () => {
    const owner = await signupWithUsername(app, { phone: '+919300000050', username: 'budget_one' });
    const friend = await signupWithUsername(app, { phone: '+919300000051', username: 'budget_two' });
    await setMode(owner.accesskey, { mode: 'chosen', phoneHashes: [sha256('+919300000051')] });
    const { chosenCheckMin } = app.server.options;
    app.server.options.chosenCheckMin = 1;
    try {
      assert.deepEqual(await found(friend.accesskey, '+919300000050'), [owner.user_id]);
      assert.deepEqual(await found(friend.accesskey, '+919300000050'), [], 'the next minute it is found again');
    } finally {
      app.server.options.chosenCheckMin = chosenCheckMin;
    }
  });

  test('phone lookups: 20 requests a minute per user, then 429', async () => {
    const reader = await signupWithUsername(app, { phone: '+919300000060', username: 'reader_ten' });
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await lookup(reader.accesskey, [sha256('+919300000020')])).statusCode, 200);
    }
    const limited = await lookup(reader.accesskey, [sha256('+919300000020')]);
    assert.equal(limited.statusCode, 429);
    const { error } = JSON.parse(limited.payload);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.retryAfterSec, 60);
  });
});
