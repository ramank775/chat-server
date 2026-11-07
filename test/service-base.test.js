const test = require('node:test');
const assert = require('node:assert');
const { ServiceBase } = require('../libs/service-base');

test('the startup line hides every secret option', async () => {
  const lines = [];
  const log = { info: (m) => lines.push(m), error: () => {} };
  const options = {
    phonePepper: 'pepper-value',
    natsAuthPass: 'nats-pass-value',
    natsAuthJwt: 'nats-jwt-value',
    otpEncryptionKey: 'otp-key-value',
    pgUrl: 'postgres://vartalap:pg-pass-value@postgres:5432/chat',
    port: 8000
  };
  await new ServiceBase({ options, log }).run();
  assert.doesNotMatch(lines[0], /pepper-value|nats-pass-value|nats-jwt-value|otp-key-value|pg-pass-value/);
  assert.match(lines[0], /"port":8000/);
});
