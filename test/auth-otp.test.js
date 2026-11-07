const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startProfileMs, signup, bearer } = require('./helpers/profile-ms');

describe('auth/otp', () => {
  /** @type {Awaited<ReturnType<typeof startProfileMs>>} */
  let app;

  before(async () => {
    app = await startProfileMs('profile_ms_test_otp');
  });

  after(async () => {
    await app.stop();
  });

  const send = (payload) => app.inject({ method: 'POST', url: '/auth/otp/send', payload });
  const verify = (payload) => app.inject({ method: 'POST', url: '/auth/otp/verify', payload });

  test('send rejects a non E.164 phone', async () => {
    const res = await send({ phone: '9876543210', deviceId: 'd1' });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.payload).error.code, 'INVALID_PHONE_FORMAT');
  });

  test('send then verify signs up a new user', async () => {
    const phone = '+919000000001';
    const res = await send({ phone, deviceId: 'd1' });
    assert.equal(res.statusCode, 200);
    const challenge = JSON.parse(res.payload);
    assert.equal(challenge.isExistingAccount, undefined);
    assert.equal(challenge.resendAfterSec, 30);
    assert.equal(challenge.expiresInSec, 600);

    const verified = await verify({
      sessionId: challenge.sessionId,
      code: app.sms.lastCode(phone),
      deviceId: 'd1'
    });
    assert.equal(verified.statusCode, 200);
    const body = JSON.parse(verified.payload);
    assert.equal(body.isNew, true);
    assert.equal(body.username, null);
    assert.equal(body.phone, undefined, 'the server no longer has the number to echo (223)');
    assert.match(body.user_id, /^[0-9a-f]{9}$/);
    assert.match(body.refreshToken, /^rt_[0-9a-f]{32}$/);
    assert.ok(body.accesskeyExpiresAt > Date.now());
    assert.ok(body.refreshTokenExpiresAt > body.accesskeyExpiresAt);
  });

  test('send and resend answer alike for an existing and a new number (234)', async () => {
    const known = '+919000000002';
    const first = await signup(app, { phone: known });
    const shape = (res) => ({ status: res.statusCode, keys: Object.keys(JSON.parse(res.payload)).sort() });
    const resendOf = (phone, sessionId) =>
      app.inject({ method: 'POST', url: '/auth/otp/resend', payload: { sessionId, phone } });
    const a = await send({ phone: known, deviceId: 'd2' });
    const b = await send({ phone: '+919000000003', deviceId: 'd2' });
    assert.deepEqual(shape(a), shape(b));
    assert.deepEqual(JSON.parse(a.payload).resendAfterSec, JSON.parse(b.payload).resendAfterSec);
    assert.equal(JSON.parse(a.payload).isExistingAccount, undefined);
    assert.deepEqual(
      shape(await resendOf(known, JSON.parse(a.payload).sessionId)),
      shape(await resendOf('+919000000003', JSON.parse(b.payload).sessionId))
    );
    assert.ok(first.user_id);
  });

  test('a returning user keeps the same user_id and verify says it is not new', async () => {
    const phone = '+919000000005';
    const first = await signup(app, { phone });
    assert.equal(first.isNew, true);
    const second = await signup(app, { phone, deviceId: 'd2' });
    assert.equal(second.isNew, false);
    assert.equal(second.user_id, first.user_id);
    assert.notEqual(second.accesskey, first.accesskey);
  });

  test('a login on another phone signs the first one out and withdraws its keys (183)', async () => {
    const phone = '+919000000012';
    const first = await signup(app, { phone, deviceId: 'phone-1' });
    await app.inject({
      method: 'PATCH', url: '/users/me', headers: bearer(first.accesskey), payload: { username: 'one_phone' }
    });
    const key = () => Buffer.concat([Buffer.from([5]), crypto.randomBytes(32)]).toString('base64');
    const keys = {
      identityKey: key(), registrationId: 9,
      signedPreKey: { id: 1, publicKey: key(), signature: crypto.randomBytes(64).toString('base64') },
      preKeys: [{ id: 1, publicKey: key() }]
    };
    const put = (accesskey) => app.inject({ method: 'PUT', url: '/keys/me', headers: bearer(accesskey), payload: keys });
    assert.equal((await put(first.accesskey)).statusCode, 200);
    app.revokes.length = 0;
    app.pushTopicDeletes.length = 0;

    const second = await signup(app, { phone, deviceId: 'phone-2' });
    assert.equal(second.user_id, first.user_id);
    const me = (accesskey) => app.inject({ method: 'GET', url: '/users/me', headers: bearer(accesskey) });
    assert.equal((await me(first.accesskey)).statusCode, 401, 'the old phone is signed out');
    assert.equal((await me(second.accesskey)).statusCode, 200);
    assert.deepEqual(app.revokes, [{ user_id: first.user_id, reason: 'revoked', deviceId: 'phone-1' }]);
    assert.deepEqual(app.pushTopicDeletes, [{ user_id: first.user_id, deviceId: 'phone-1' }]);
    assert.deepEqual(await app.server.context.authDB.listDeviceKeys(first.user_id), []);

    assert.equal((await put(second.accesskey)).statusCode, 200);
    const listed = await app.inject({ method: 'GET', url: `/keys/${first.user_id}`, headers: bearer(second.accesskey) });
    assert.deepEqual(listed.json().devices.map((device) => device.deviceId), ['phone-2']);
    // signing in again on the same phone retires nothing
    await signup(app, { phone, deviceId: 'phone-2' });
    assert.equal((await app.server.context.authDB.listDeviceKeys(first.user_id)).length, 1);
  });

  test('send is idempotent inside the resend window', async () => {
    const phone = '+919000000003';
    const first = JSON.parse((await send({ phone, deviceId: 'd1' })).payload);
    const sends = app.sms.sends.length;
    const second = JSON.parse((await send({ phone, deviceId: 'd1' })).payload);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(app.sms.sends.length, sends, 'no second SMS inside the resend window');
  });

  test('re-verify of a consumed session is 410 SESSION_CONSUMED', async () => {
    const phone = '+919000000004';
    const challenge = JSON.parse((await send({ phone, deviceId: 'd1' })).payload);
    const code = app.sms.lastCode(phone);
    const ok = await verify({ sessionId: challenge.sessionId, code, deviceId: 'd1' });
    assert.equal(ok.statusCode, 200);
    const again = await verify({ sessionId: challenge.sessionId, code, deviceId: 'd1' });
    assert.equal(again.statusCode, 410);
    assert.equal(JSON.parse(again.payload).error.code, 'SESSION_CONSUMED');
  });

  test('unknown session is 404, unknown fields are rejected', async () => {
    const missing = await verify({ sessionId: 'nope', code: '123456', deviceId: 'd1' });
    assert.equal(missing.statusCode, 404);
    assert.equal(JSON.parse(missing.payload).error.code, 'SESSION_NOT_FOUND');

    const phone = '+919000000005';
    const challenge = JSON.parse((await send({ phone, deviceId: 'd1' })).payload);
    const extra = await verify({
      sessionId: challenge.sessionId,
      code: app.sms.lastCode(phone),
      deviceId: 'd1',
      username: 'legacy_field'
    });
    assert.equal(extra.statusCode, 400);
    assert.equal(JSON.parse(extra.payload).error.code, 'validation_failed');
  });

  test('five wrong codes lock the session with 423', async () => {
    const phone = '+919000000006';
    const challenge = JSON.parse((await send({ phone, deviceId: 'd1' })).payload);
    const wrong = app.sms.lastCode(phone) === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await verify({ sessionId: challenge.sessionId, code: wrong, deviceId: 'd1' });
      assert.equal(res.statusCode, 401, `attempt ${attempt}`);
      assert.equal(JSON.parse(res.payload).error.code, 'INVALID_CODE');
    }

    const locked = await verify({ sessionId: challenge.sessionId, code: wrong, deviceId: 'd1' });
    assert.equal(locked.statusCode, 423);
    const { error } = JSON.parse(locked.payload);
    assert.equal(error.code, 'SESSION_LOCKED');
    assert.equal(error.scope, 'session');
    assert.ok(error.retryAfterSec > 0);

    // even the right code no longer works on a locked session
    const right = await verify({
      sessionId: challenge.sessionId,
      code: app.sms.lastCode(phone),
      deviceId: 'd1'
    });
    assert.equal(right.statusCode, 423);
  });

  test('resend reuses the session and code and is throttled', async () => {
    const phone = '+919000000007';
    const challenge = JSON.parse((await send({ phone, deviceId: 'd1' })).payload);
    const firstCode = app.sms.lastCode(phone);
    const sends = app.sms.sends.length;

    const row = await app.db.collection('otp_sessions').findOne({ sessionId: challenge.sessionId });
    assert.equal(row.phone, undefined, 'the challenge keeps no number (223)');
    assert.match(row.phoneKey, /^[0-9a-f]{64}$/);

    // an app from before decision 223 names no number: it starts over with /send
    const legacy = await app.inject({
      method: 'POST',
      url: '/auth/otp/resend',
      payload: { sessionId: challenge.sessionId }
    });
    assert.equal(legacy.statusCode, 410);
    assert.equal(JSON.parse(legacy.payload).error.code, 'RESEND_UNAVAILABLE');

    const throttled = await app.inject({
      method: 'POST',
      url: '/auth/otp/resend',
      payload: { sessionId: challenge.sessionId, phone }
    });
    assert.equal(throttled.statusCode, 200);
    assert.equal(JSON.parse(throttled.payload).sessionId, challenge.sessionId);
    assert.equal(app.sms.sends.length, sends, 'no SMS while the resend window is open');

    // let the window elapse
    await app.db.collection('otp_sessions').updateOne(
      { sessionId: challenge.sessionId },
      { $set: { resendAfter: new Date(Date.now() - 1000) } }
    );
    const elsewhere = await app.inject({
      method: 'POST',
      url: '/auth/otp/resend',
      payload: { sessionId: challenge.sessionId, phone: '+919000000099' }
    });
    assert.equal(elsewhere.statusCode, 404, 'the code goes only to the number it was sent to');
    assert.equal(app.sms.sends.length, sends);

    const resent = await app.inject({
      method: 'POST',
      url: '/auth/otp/resend',
      payload: { sessionId: challenge.sessionId, phone }
    });
    const body = JSON.parse(resent.payload);
    assert.equal(body.sessionId, challenge.sessionId, 'resend never allocates a new session');
    assert.ok(body.expiresInSec <= 600, 'resend does not extend the session lifetime');
    assert.equal(app.sms.sends.length, sends + 1);

    assert.equal(app.sms.lastCode(phone), firstCode, 'late SMS messages still contain a valid code');

    const fresh = await verify({
      sessionId: challenge.sessionId,
      code: firstCode,
      deviceId: 'd1'
    });
    assert.equal(fresh.statusCode, 200);
  });

  test('resend spends the SMS budgets and refuses a locked session', async () => {
    const phone = '+919000000009';
    const challenge = JSON.parse((await send({ phone, deviceId: 'd1' })).payload);
    const resend = () =>
      app.inject({
        method: 'POST',
        url: '/auth/otp/resend',
        payload: { sessionId: challenge.sessionId, phone }
      });
    const openWindow = () =>
      app.db
        .collection('otp_sessions')
        .updateOne(
          { sessionId: challenge.sessionId },
          { $set: { resendAfter: new Date(Date.now() - 1000) } }
        );
    // the send spent one of the phone's 5 an hour; 4 resends spend the rest
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await openWindow();
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await resend()).statusCode, 200);
    }
    await openWindow();
    const limited = await resend();
    assert.equal(limited.statusCode, 429);
    assert.equal(JSON.parse(limited.payload).error.code, 'OTP_RATE_LIMITED');

    await app.db
      .collection('otp_sessions')
      .updateOne({ sessionId: challenge.sessionId }, { $set: { attempts: 5 } });
    const sends = app.sms.sends.length;
    const locked = await resend();
    assert.equal(locked.statusCode, 423);
    assert.equal(app.sms.sends.length, sends, 'no SMS for a locked session');
  });

  test('an expired session is 410 SESSION_EXPIRED', async () => {
    const phone = '+919000000008';
    const challenge = JSON.parse((await send({ phone, deviceId: 'd1' })).payload);
    await app.db
      .collection('otp_sessions')
      .updateOne(
        { sessionId: challenge.sessionId },
        { $set: { expiresAt: new Date(Date.now() - 1000) } }
      );
    const res = await verify({
      sessionId: challenge.sessionId,
      code: app.sms.lastCode(phone),
      deviceId: 'd1'
    });
    assert.equal(res.statusCode, 410);
    assert.equal(JSON.parse(res.payload).error.code, 'SESSION_EXPIRED');
  });
});
