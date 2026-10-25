const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Implementation: OtpProvider } = require('../services/profile-ms/auth-provider/self-hosted-otp-auth-provider');
const { parseOptions } = require('../services/profile-ms/profile-ms');

function harness() {
  const sessions = new Map();
  const sends = [];
  const context = {
    options: { smsSender: 'mock', otpEncryptionKey: crypto.randomBytes(32).toString('hex') },
    authDB: {
      getActiveOtpSession: async () => null,
      createOtpSession: async (session) => sessions.set(session.sessionId, session),
      getOtpSession: async (id) => sessions.get(id),
      updateOtpSession: async (id, updates) => Object.assign(sessions.get(id), updates),
      consumeOtpSession: async (id) => {
        const session = sessions.get(id);
        if (session.consumed) return null;
        session.consumed = true;
        return session;
      }
    },
    smsSender: { send: async (sms) => sends.push(sms) }
  };
  return { context, sessions, sends, provider: new OtpProvider(context) };
}

test('same-code resend survives provider restart without changing attempts, hash or expiry', async () => {
  const { context, sessions, sends, provider } = harness();
  const { sessionId } = await provider.startOtp({ phone: '+919000000001', deviceId: 'd1' });
  const session = sessions.get(sessionId);
  const { codeHash, expiresAt, encryptedCode } = session;
  const { code } = sends[0];
  assert.notEqual(codeHash, code);
  assert.equal(Buffer.from(encryptedCode, 'base64').length, 34);
  session.resendAfter = new Date(0);
  session.attempts = 2;
  const restarted = new OtpProvider(context);
  let budgets = 0;
  await restarted.resendOtp(sessionId, async () => { budgets += 1; });
  assert.deepEqual(sends[1], sends[0]);
  assert.equal(budgets, 1);
  assert.equal(session.codeHash, codeHash);
  assert.equal(session.encryptedCode, encryptedCode);
  assert.equal(session.expiresAt, expiresAt);
  assert.equal(session.attempts, 2);
  await restarted.resendOtp(sessionId);
  assert.equal(sends.length, 2, 'the new resend window suppresses another SMS');
  assert.deepEqual(await restarted.verifyOtp({ sessionId, code, deviceId: 'd1' }), {
    phone: '+919000000001', deviceId: 'd1', userId: null
  });
});

test('tampered ciphertext, tags and swapped sessions send no SMS', async () => {
  const { sessions, sends, provider } = harness();
  const first = await provider.startOtp({ phone: '+919000000001', deviceId: 'd1' });
  const second = await provider.startOtp({ phone: '+919000000002', deviceId: 'd2' });
  const session = sessions.get(first.sessionId);
  const original = session.encryptedCode;
  session.resendAfter = new Date(0);
  // eslint-disable-next-line no-restricted-syntax
  for (const offset of [0, 12, 33]) {
    const damaged = Buffer.from(original, 'base64');
    damaged[offset] ^= 1; // eslint-disable-line no-bitwise
    session.encryptedCode = damaged.toString('base64');
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(provider.resendOtp(first.sessionId));
  }
  session.encryptedCode = sessions.get(second.sessionId).encryptedCode;
  await assert.rejects(provider.resendOtp(first.sessionId));
  assert.equal(sends.length, 2);
});

test('resend refuses expired, locked and consumed challenges', async () => {
  const { sessions, sends, provider } = harness();
  const { sessionId } = await provider.startOtp({ phone: '+919000000001', deviceId: 'd1' });
  const session = sessions.get(sessionId);
  session.resendAfter = new Date(0);
  session.attempts = 5;
  await assert.rejects(provider.resendOtp(sessionId), { code: 'SESSION_LOCKED' });
  session.attempts = 0;
  const { expiresAt } = session;
  session.expiresAt = new Date(0);
  await assert.rejects(provider.resendOtp(sessionId), { code: 'SESSION_EXPIRED' });
  session.expiresAt = expiresAt;
  session.consumed = true;
  await assert.rejects(provider.resendOtp(sessionId), { code: 'SESSION_CONSUMED' });
  assert.equal(sends.length, 1);
});

test('a wrong encryption key cannot resend but does not break hash verification', async () => {
  const { context, sessions, sends, provider } = harness();
  const { sessionId } = await provider.startOtp({ phone: '+919000000001', deviceId: 'd1' });
  const session = sessions.get(sessionId);
  session.resendAfter = new Date(0);
  context.options.otpEncryptionKey = crypto.randomBytes(32).toString('hex');
  const changedKey = new OtpProvider(context);
  // 410 is what sends the app back to /otp/send for a fresh code
  await assert.rejects(changedKey.resendOtp(sessionId), { status: 410, code: 'RESEND_UNAVAILABLE' });
  assert.equal(sends.length, 1);
  await changedKey.verifyOtp({ sessionId, code: sends[0].code, deviceId: 'd1' });
});

test('failed budgets and failed SMS leave the challenge intact and retryable', async () => {
  const { context, sessions, sends, provider } = harness();
  const { sessionId } = await provider.startOtp({ phone: '+919000000001', deviceId: 'd1' });
  const session = sessions.get(sessionId);
  session.resendAfter = new Date(0);
  const saved = { ...session };
  await assert.rejects(provider.resendOtp(sessionId, async () => { throw new Error('budget'); }));
  assert.equal(sends.length, 1);
  context.smsSender.send = async () => { throw new Error('gateway'); };
  await assert.rejects(provider.resendOtp(sessionId), /gateway/);
  assert.deepEqual(session, saved);
  context.smsSender.send = async (sms) => sends.push(sms);
  await provider.resendOtp(sessionId);
  assert.deepEqual(sends[1], sends[0]);
});

test('real SMS requires a valid encryption key; option and environment both configure it', () => {
  const { context } = harness();
  context.options.smsSender = 'sms-gate-app';
  [undefined, '', 'ab'.repeat(31), 'gg'.repeat(32)].forEach((key) => {
    context.options.otpEncryptionKey = key;
    assert.throws(() => new OtpProvider(context), /OTP_ENCRYPTION_KEY/);
  });
  const key = crypto.randomBytes(32).toString('hex');
  context.options = parseOptions(['node', 'test', '--sms-sender=sms-gate-app', `--otp-encryption-key=${key}`]);
  assert.doesNotThrow(() => new OtpProvider(context));
  const previous = process.env.OTP_ENCRYPTION_KEY;
  try {
    process.env.OTP_ENCRYPTION_KEY = key;
    assert.equal(parseOptions(['node', 'test']).otpEncryptionKey, key);
  } finally {
    if (previous === undefined) delete process.env.OTP_ENCRYPTION_KEY;
    else process.env.OTP_ENCRYPTION_KEY = previous;
  }
});
