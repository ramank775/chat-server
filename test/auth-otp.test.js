const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startProfileMs, signup } = require('./helpers/profile-ms');

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
    assert.equal(challenge.isExistingAccount, false);
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
    assert.equal(body.phone, phone);
    assert.match(body.user_id, /^[0-9a-f]{9}$/);
    assert.match(body.refreshToken, /^rt_[0-9a-f]{32}$/);
    assert.ok(body.accesskeyExpiresAt > Date.now());
    assert.ok(body.refreshTokenExpiresAt > body.accesskeyExpiresAt);
  });

  test('a returning user keeps the same user_id and is flagged existing', async () => {
    const phone = '+919000000002';
    const first = await signup(app, { phone });
    const res = await send({ phone, deviceId: 'd2' });
    assert.equal(JSON.parse(res.payload).isExistingAccount, true);
    const second = await signup(app, { phone, deviceId: 'd2' });
    assert.equal(second.isNew, false);
    assert.equal(second.user_id, first.user_id);
    assert.notEqual(second.accesskey, first.accesskey);
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

  test('resend reuses the session, replaces the code and is throttled', async () => {
    const phone = '+919000000007';
    const challenge = JSON.parse((await send({ phone, deviceId: 'd1' })).payload);
    const firstCode = app.sms.lastCode(phone);
    const sends = app.sms.sends.length;

    const throttled = await app.inject({
      method: 'POST',
      url: '/auth/otp/resend',
      payload: { sessionId: challenge.sessionId }
    });
    assert.equal(throttled.statusCode, 200);
    assert.equal(JSON.parse(throttled.payload).sessionId, challenge.sessionId);
    assert.equal(app.sms.sends.length, sends, 'no SMS while the resend window is open');

    // let the window elapse
    await app.db.collection('otp_sessions').updateOne(
      { sessionId: challenge.sessionId },
      { $set: { resendAfter: new Date(Date.now() - 1000) } }
    );
    const resent = await app.inject({
      method: 'POST',
      url: '/auth/otp/resend',
      payload: { sessionId: challenge.sessionId }
    });
    const body = JSON.parse(resent.payload);
    assert.equal(body.sessionId, challenge.sessionId, 'resend never allocates a new session');
    assert.ok(body.expiresInSec <= 600, 'resend does not extend the session lifetime');
    assert.equal(app.sms.sends.length, sends + 1);

    const stale = await verify({ sessionId: challenge.sessionId, code: firstCode, deviceId: 'd1' });
    assert.equal(stale.statusCode, 401, 'the previous code is invalid immediately');

    const fresh = await verify({
      sessionId: challenge.sessionId,
      code: app.sms.lastCode(phone),
      deviceId: 'd1'
    });
    assert.equal(fresh.statusCode, 200);
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
