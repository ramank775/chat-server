const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sha256 } = require('../helper');
const { startProfileMs, signup, signupWithUsername, bearer } = require('./helpers/profile-ms');

describe('account delete and phone rebind (AUTH_CONTRACT 8 and 9)', () => {
  /** @type {Awaited<ReturnType<typeof startProfileMs>>} */
  let app;

  before(async () => {
    app = await startProfileMs('profile_ms_test_account');
  });

  after(async () => {
    await app.stop();
  });

  const me = (accesskey) =>
    app.inject({ method: 'GET', url: '/users/me', headers: bearer(accesskey) });
  const deleteMe = (accesskey, confirmation) =>
    app.inject({
      method: 'POST',
      url: '/users/me/delete',
      headers: bearer(accesskey),
      payload: { confirmation }
    });
  const rebindStart = (accesskey, newPhone) =>
    app.inject({
      method: 'POST',
      url: '/auth/phone/rebind/start',
      headers: bearer(accesskey),
      payload: { newPhone }
    });
  const rebindVerify = (accesskey, payload) =>
    app.inject({
      method: 'POST',
      url: '/auth/phone/rebind/verify',
      headers: bearer(accesskey),
      payload
    });

  test('delete needs the exact typed confirmation', async () => {
    const session = await signupWithUsername(app, {
      phone: '+919400000001',
      username: 'confirm_me'
    });
    const wrong = await deleteMe(session.accesskey, 'DELETE someone_else');
    assert.equal(wrong.statusCode, 400);
    assert.equal(JSON.parse(wrong.payload).error.code, 'INVALID_CONFIRMATION');

    const cased = await deleteMe(session.accesskey, 'delete confirm_me');
    assert.equal(cased.statusCode, 400, 'the confirmation is case sensitive');
    assert.equal((await me(session.accesskey)).statusCode, 200, 'the account is untouched');
  });

  test('delete without a username is gated, not a crash', async () => {
    const session = await signup(app, { phone: '+919400000002' });
    const res = await deleteMe(session.accesskey, 'DELETE anything');
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.payload).error.code, 'USERNAME_REQUIRED');
  });

  test('delete tombstones the account, revokes every session and tells the gateway', async () => {
    const session = await signupWithUsername(app, {
      phone: '+919400000003',
      username: 'gone_soon',
      deviceId: 'device-a'
    });
    const second = await signup(app, { phone: '+919400000003', deviceId: 'device-b' });
    const reader = await signupWithUsername(app, {
      phone: '+919400000004',
      username: 'watcher_one'
    });
    const revokedBefore = app.revokes.length;

    const res = await deleteMe(session.accesskey, 'DELETE gone_soon');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.payload), { status: true });

    assert.equal((await me(session.accesskey)).statusCode, 401, 'this session is revoked');
    assert.equal((await me(second.accesskey)).statusCode, 401, 'so is the other device');
    assert.deepEqual(app.revokes.slice(revokedBefore), [
      { user_id: session.user_id, reason: 'revoked' }
    ]);

    const row = await app.db.collection('users').findOne({ user_id: session.user_id });
    assert.ok(row.deletedAt instanceof Date, 'the row is tombstoned, not removed');
    assert.equal(row.usernameLower, 'gone_soon', 'the handle stays reserved');

    const fetched = await app.inject({
      method: 'GET',
      url: `/users/${session.user_id}`,
      headers: bearer(reader.accesskey)
    });
    assert.equal(fetched.statusCode, 404);
    assert.equal(JSON.parse(fetched.payload).error.code, 'USER_NOT_FOUND');

    const handle = await app.inject({
      method: 'GET',
      url: '/users/by-username/gone_soon',
      headers: bearer(reader.accesskey)
    });
    assert.equal(handle.statusCode, 404, 'a tombstoned handle resolves to nobody');
  });

  test('the phone comes back, the user_id and username do not', async () => {
    const gone = await signupWithUsername(app, {
      phone: '+919400000005',
      username: 'recycled_one'
    });
    await deleteMe(gone.accesskey, 'DELETE recycled_one');

    // 8.2 step 2: the number is free for a fresh signup, with a fresh identity
    const fresh = await signup(app, { phone: '+919400000005' });
    assert.notEqual(fresh.user_id, gone.user_id);
    assert.equal(fresh.username, null);

    const taken = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: bearer(fresh.accesskey),
      payload: { username: 'recycled_one' }
    });
    assert.equal(taken.statusCode, 409);
    assert.equal(JSON.parse(taken.payload).error.code, 'USERNAME_TAKEN');

    const check = await app.inject({
      method: 'POST',
      url: '/users/username/check',
      headers: bearer(fresh.accesskey),
      payload: { username: 'recycled_one' }
    });
    assert.deepEqual(JSON.parse(check.payload), { available: false, reason: 'taken' });
  });

  test('rebind swaps the phone and keeps the identity and the session', async () => {
    const session = await signupWithUsername(app, {
      phone: '+919400000006',
      username: 'mover_one',
      deviceId: 'device-a'
    });
    const revokedBefore = app.revokes.length;
    const oldPhoneCode = app.sms.lastCode('+919400000006');

    const started = await rebindStart(session.accesskey, '+919400000007');
    assert.equal(started.statusCode, 200);
    const challenge = JSON.parse(started.payload);
    assert.ok(challenge.rebindSessionId);
    assert.equal(challenge.resendAfterSec, 30);
    assert.equal(challenge.expiresInSec, 600);
    assert.equal(
      app.sms.lastCode('+919400000006'),
      oldPhoneCode,
      'the old number is not texted again (9.2)'
    );

    const verified = await rebindVerify(session.accesskey, {
      rebindSessionId: challenge.rebindSessionId,
      code: app.sms.lastCode('+919400000007')
    });
    assert.equal(verified.statusCode, 200);
    assert.deepEqual(JSON.parse(verified.payload), {
      user_id: session.user_id,
      username: 'mover_one',
      phone: '+919400000007'
    });

    const profile = await me(session.accesskey);
    assert.equal(profile.statusCode, 200, 'the accesskey survives the rebind (9.4)');
    assert.equal(JSON.parse(profile.payload).phone, '+919400000007');

    const row = await app.db.collection('users').findOne({ user_id: session.user_id });
    assert.equal(row.phoneHash, sha256('+919400000007'), 'discovery follows the new number');
    assert.deepEqual(app.revokes.slice(revokedBefore), [
      { user_id: session.user_id, reason: 'rebind' }
    ]);

    // the old number is free again, the new one is not
    const other = await signup(app, { phone: '+919400000006' });
    assert.notEqual(other.user_id, session.user_id);
  });

  test('rebind start rejects a malformed, unchanged or taken number', async () => {
    const session = await signupWithUsername(app, {
      phone: '+919400000008',
      username: 'mover_two'
    });
    await signupWithUsername(app, { phone: '+919400000009', username: 'squatter_one' });

    const malformed = await rebindStart(session.accesskey, '9400000010');
    assert.equal(malformed.statusCode, 400);
    assert.equal(JSON.parse(malformed.payload).error.code, 'INVALID_PHONE_FORMAT');

    const same = await rebindStart(session.accesskey, '+919400000008');
    assert.equal(same.statusCode, 409);
    assert.equal(JSON.parse(same.payload).error.code, 'SAME_PHONE');

    const taken = await rebindStart(session.accesskey, '+919400000009');
    assert.equal(taken.statusCode, 409);
    assert.equal(JSON.parse(taken.payload).error.code, 'PHONE_TAKEN');
  });

  test('a rebind challenge is bound to its user and its code', async () => {
    const session = await signupWithUsername(app, {
      phone: '+919400000011',
      username: 'mover_three'
    });
    const outsider = await signupWithUsername(app, {
      phone: '+919400000012',
      username: 'outsider_one'
    });
    const started = await rebindStart(session.accesskey, '+919400000013');
    const { rebindSessionId } = JSON.parse(started.payload);

    const wrongCode = await rebindVerify(session.accesskey, { rebindSessionId, code: '000000' });
    assert.equal(wrongCode.statusCode, 401);
    assert.equal(JSON.parse(wrongCode.payload).error.code, 'INVALID_CODE');

    const stolen = await rebindVerify(outsider.accesskey, {
      rebindSessionId,
      code: app.sms.lastCode('+919400000013')
    });
    assert.equal(stolen.statusCode, 404);
    assert.equal(JSON.parse(stolen.payload).error.code, 'SESSION_NOT_FOUND');

    const unknown = await rebindVerify(session.accesskey, {
      rebindSessionId: 'no-such-session',
      code: '123456'
    });
    assert.equal(unknown.statusCode, 404);
    assert.equal(JSON.parse(unknown.payload).error.code, 'SESSION_NOT_FOUND');
  });

  test('a login challenge cannot be spent as a rebind', async () => {
    const session = await signupWithUsername(app, {
      phone: '+919400000014',
      username: 'mover_four',
      deviceId: 'device-a'
    });
    // same (phone, device) as the rebind below, but no user binding
    const login = await app.inject({
      method: 'POST',
      url: '/auth/otp/send',
      payload: { phone: '+919400000015', deviceId: 'device-a' }
    });
    const loginSessionId = JSON.parse(login.payload).sessionId;
    const loginCode = app.sms.lastCode('+919400000015');

    const started = await rebindStart(session.accesskey, '+919400000015');
    assert.equal(started.statusCode, 200);
    assert.notEqual(
      JSON.parse(started.payload).rebindSessionId,
      loginSessionId,
      'the unbound challenge is not reused'
    );

    const res = await rebindVerify(session.accesskey, {
      rebindSessionId: loginSessionId,
      code: loginCode
    });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.payload).error.code, 'SESSION_NOT_FOUND');
  });
});
