const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Implementation: OtpProvider } = require('../services/profile-ms/auth-provider/self-hosted-otp-auth-provider');
const { Implementation: VerifyNowSender } = require('../services/profile-ms/auth-provider/sms-sender/verifynow-sms-sender');

/** A stand-in VerifyNow: tokens, sends and checks, as its API page shows them. */
async function fakeVerifyNow() {
  const state = { calls: [], codes: new Map(), tokens: 0, expireNextToken: false, expired: new Set() };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    state.calls.push({ method: req.method, path: url.pathname, q, authToken: req.headers.authtoken });
    const reply = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/auth/v1/authentication/token') {
      state.tokens += 1;
      return reply(200, { status: 200, token: `t${state.tokens}` });
    }
    if (req.headers.authtoken !== `t${state.tokens}` || state.expireNextToken) {
      state.expireNextToken = false;
      return reply(401, { responseCode: 401, message: 'UNAUTHORIZED' });
    }
    if (url.pathname === '/verification/v3/send' && req.method === 'POST') {
      const id = String(1000 + state.codes.size);
      state.codes.set(id, '123456');
      return reply(200, { responseCode: 200, message: 'SUCCESS', data: { verificationId: id, responseCode: '200', timeout: '60' } });
    }
    if (url.pathname === '/verification/v3/validateOtp' && req.method === 'GET') {
      if (state.expired.has(q.verificationId)) {
        return reply(400, { responseCode: 705, message: 'VERIFICATION_EXPIRED', data: { responseCode: '705' } });
      }
      if (state.codes.get(q.verificationId) !== q.code) {
        return reply(400, { responseCode: 702, message: 'WRONG_OTP_PROVIDED', data: { responseCode: '702' } });
      }
      return reply(200, { responseCode: 200, message: 'SUCCESS', data: { responseCode: '200', verificationStatus: 'VERIFICATION_COMPLETED' } });
    }
    return reply(404, {});
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function harness(url) {
  const sessions = new Map();
  const log = { error() {}, warn() {}, debug() {}, info() {} };
  const options = {
    smsSender: 'verifynow',
    verifynowUrl: url,
    verifynowCustomerId: 'C-TEST',
    verifynowPassword: 'pa55',
    verifynowEmail: '',
    verifynowCountries: '91'
  };
  const smsSender = new VerifyNowSender({ options, log });
  const context = {
    options,
    log,
    smsSender,
    authDB: {
      getActiveOtpSession: async () => null,
      createOtpSession: async (session) => sessions.set(session.sessionId, session),
      getOtpSession: async (id) => sessions.get(id),
      updateOtpSession: async (id, updates) => Object.assign(sessions.get(id), updates),
      incrementOtpAttempts: async (id) => {
        sessions.get(id).attempts += 1;
        return sessions.get(id);
      },
      consumeOtpSession: async (id) => {
        const session = sessions.get(id);
        if (session.consumed) return null;
        session.consumed = true;
        return session;
      }
    }
  };
  return { sessions, provider: new OtpProvider(context) };
}

const ONE = { phone: '+919000000001', phoneKey: 'key-one' };

test('VerifyNow makes and checks the code; our session keeps only its reference', async (t) => {
  const vn = await fakeVerifyNow();
  t.after(vn.close);
  const { sessions, provider } = harness(vn.url);

  const started = await provider.startOtp({ ...ONE, deviceId: 'd1' });
  assert.equal(started.resendAfterSec, 60);
  const session = sessions.get(started.sessionId);
  assert.equal(session.gatewayRef, '1000');
  assert.equal(session.codeHash, undefined, 'no code of ours to hash');
  const [token, send] = vn.state.calls;
  assert.equal(token.q.key, Buffer.from('pa55').toString('base64'));
  assert.deepEqual(
    { ...send.q, authToken: send.authToken },
    { countryCode: '91', customerId: 'C-TEST', flowType: 'SMS', mobileNumber: '9000000001', otpLength: '6', authToken: 't1' }
  );

  // a wrong code costs an attempt; an expired token is fetched again once
  vn.state.expireNextToken = true;
  await assert.rejects(provider.verifyOtp({ sessionId: started.sessionId, code: '000000', deviceId: 'd1' }), {
    code: 'INVALID_CODE'
  });
  assert.equal(session.attempts, 1);
  assert.equal(vn.state.tokens, 2);

  // resend: a new send, a new reference, the budget runs first
  session.resendAfter = new Date(0);
  let budgets = 0;
  await provider.resendOtp(started.sessionId, ONE, async () => { budgets += 1; });
  assert.equal(budgets, 1);
  assert.equal(session.gatewayRef, '1001');

  // VerifyNow's own expiry is not a wrong code: no attempt spent
  vn.state.expired.add('1001');
  await assert.rejects(provider.verifyOtp({ sessionId: started.sessionId, code: '123456', deviceId: 'd1' }), {
    code: 'CODE_EXPIRED'
  });
  assert.equal(session.attempts, 1);
  vn.state.expired.clear();

  assert.deepEqual(await provider.verifyOtp({ sessionId: started.sessionId, code: '123456', deviceId: 'd1' }), {
    phoneKey: 'key-one', deviceId: 'd1', userId: null
  });
});

test('a number outside VERIFYNOW_COUNTRIES gets no send, and no session', async (t) => {
  const vn = await fakeVerifyNow();
  t.after(vn.close);
  const { sessions, provider } = harness(vn.url);
  await assert.rejects(provider.startOtp({ phone: '+15550000001', phoneKey: 'k', deviceId: 'd1' }), {
    code: 'SMS_GATEWAY_ERROR'
  });
  assert.equal(vn.state.calls.length, 0);
  assert.equal(sessions.size, 0);
});
