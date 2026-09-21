const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startProfileMs, signup, signupWithUsername, bearer } = require('./helpers/profile-ms');

describe('auth/session and the /auth subrequest', () => {
  /** @type {Awaited<ReturnType<typeof startProfileMs>>} */
  let app;

  before(async () => {
    app = await startProfileMs('profile_ms_test_session');
  });

  after(async () => {
    await app.stop();
  });

  const refresh = (payload) =>
    app.inject({ method: 'POST', url: '/auth/session/refresh', payload });

  test('refresh rotates both credentials and a replay is 401', async () => {
    const session = await signup(app, { phone: '+919100000001', deviceId: 'd1' });

    const rotated = await refresh({ refreshToken: session.refreshToken, deviceId: 'd1' });
    assert.equal(rotated.statusCode, 200);
    const next = JSON.parse(rotated.payload);
    assert.equal(next.user_id, session.user_id);
    assert.notEqual(next.accesskey, session.accesskey);
    assert.notEqual(next.refreshToken, session.refreshToken);
    assert.equal(next.username, undefined, 'refresh is a session op, not a profile fetch');
    assert.equal(next.phone, undefined);

    const replay = await refresh({ refreshToken: session.refreshToken, deviceId: 'd1' });
    assert.equal(replay.statusCode, 401);
    assert.equal(JSON.parse(replay.payload).error.code, 'INVALID_REFRESH_TOKEN');

    // the rotated accesskey works, the previous one does not
    assert.equal((await app.inject({ method: 'GET', url: '/users/me', headers: bearer(next.accesskey) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/users/me', headers: bearer(session.accesskey) })).statusCode, 401);
  });

  test('refresh with the wrong deviceId is 401', async () => {
    const session = await signup(app, { phone: '+919100000002', deviceId: 'd1' });
    const res = await refresh({ refreshToken: session.refreshToken, deviceId: 'other-device' });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.payload).error.code, 'INVALID_REFRESH_TOKEN');
  });

  test('revoke is idempotent and kills the accesskey', async () => {
    const session = await signup(app, { phone: '+919100000003', deviceId: 'd1' });
    const revoke = () =>
      app.inject({
        method: 'POST',
        url: '/auth/session/revoke',
        headers: bearer(session.accesskey),
        payload: { refreshToken: session.refreshToken }
      });

    const first = await revoke();
    assert.equal(first.statusCode, 200);
    assert.deepEqual(JSON.parse(first.payload), { status: true });

    const second = await revoke();
    assert.equal(second.statusCode, 200, 'revoking twice is a no-op');

    const me = await app.inject({ method: 'GET', url: '/users/me', headers: bearer(session.accesskey) });
    assert.equal(me.statusCode, 401);
    assert.equal(JSON.parse(me.payload).error.code, 'INVALID_ACCESSKEY');

    const reuse = await refresh({ refreshToken: session.refreshToken, deviceId: 'd1' });
    assert.equal(reuse.statusCode, 401, 'a revoked session cannot be refreshed');
  });

  test('revoke without a bearer is 401 MISSING_ACCESSKEY', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/session/revoke', payload: {} });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.payload).error.code, 'MISSING_ACCESSKEY');
  });

  test('revoke deregisters the device push topic with notification-ms (4.6 step 3)', async () => {
    const session = await signup(app, { phone: '+919100000006', deviceId: 'd-push' });
    const priorCalls = app.pushTopicDeletes.length;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/session/revoke',
      headers: bearer(session.accesskey),
      payload: { refreshToken: session.refreshToken }
    });
    assert.equal(res.statusCode, 200);

    const calls = app.pushTopicDeletes.slice(priorCalls);
    assert.deepEqual(calls, [{ user_id: session.user_id, deviceId: 'd-push' }]);
  });

  test('/auth accepts a bearer accesskey and answers with the identity headers', async () => {
    const session = await signupWithUsername(app, {
      phone: '+919100000004',
      username: 'auth_bearer',
      deviceId: 'device-7'
    });
    const res = await app.inject({
      method: 'GET',
      url: '/auth',
      headers: { ...bearer(session.accesskey), 'x-original-uri': '/v3.0/channels' }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-user'], session.user_id);
    assert.equal(res.headers['x-device'], 'device-7');
  });

  test('/auth accepts the websocket subprotocol accesskey', async () => {
    const session = await signupWithUsername(app, {
      phone: '+919100000005',
      username: 'auth_wss',
      deviceId: 'device-8'
    });
    const res = await app.inject({
      method: 'GET',
      url: '/auth',
      headers: {
        'sec-websocket-protocol': `accesskey.${session.accesskey}`,
        'x-original-uri': '/wss'
      }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-user'], session.user_id);
    assert.equal(res.headers['x-device'], 'device-8');
  });

  test('/auth rejects a missing or unknown accesskey', async () => {
    const none = await app.inject({ method: 'GET', url: '/auth' });
    assert.equal(none.statusCode, 401);
    assert.equal(JSON.parse(none.payload).error.code, 'MISSING_ACCESSKEY');

    const bad = await app.inject({
      method: 'GET',
      url: '/auth',
      headers: bearer('b6d2a0ce-0000-4000-8000-000000000000')
    });
    assert.equal(bad.statusCode, 401);
    assert.equal(JSON.parse(bad.payload).error.code, 'INVALID_ACCESSKEY');

    const badProtocol = await app.inject({
      method: 'GET',
      url: '/auth',
      headers: { 'sec-websocket-protocol': 'chat, superchat' }
    });
    assert.equal(badProtocol.statusCode, 401);
    assert.equal(JSON.parse(badProtocol.payload).error.code, 'MISSING_ACCESSKEY');
  });

  test('/auth ignores a client supplied x-user header', async () => {
    const session = await signupWithUsername(app, {
      phone: '+919100000006',
      username: 'auth_spoof',
      deviceId: 'device-9'
    });
    const res = await app.inject({
      method: 'GET',
      url: '/auth',
      headers: {
        ...bearer(session.accesskey),
        'x-user': 'ffffffff0',
        'x-original-uri': '/v3.0/channels'
      }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-user'], session.user_id);
  });

  test('an expired accesskey is 401', async () => {
    const session = await signup(app, { phone: '+919100000007', deviceId: 'd1' });
    await app.db
      .collection('sessions')
      .updateOne({ accesskey: session.accesskey }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    const res = await app.inject({ method: 'GET', url: '/users/me', headers: bearer(session.accesskey) });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.payload).error.code, 'INVALID_ACCESSKEY');
  });
});
