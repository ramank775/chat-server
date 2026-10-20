const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startProfileMs, signupWithUsername, bearer } = require('./helpers/profile-ms');

let app;
let owner;
const publicKey = () => Buffer.concat([Buffer.from([5]), crypto.randomBytes(32)]).toString('base64');
const keys = {
  identityKey: publicKey(), registrationId: 42,
  signedPreKey: { id: 1, publicKey: publicKey(), signature: crypto.randomBytes(64).toString('base64') },
  preKeys: Array.from({ length: 8 }, (_, id) => ({ id, publicKey: publicKey() }))
};

before(async () => {
  app = await startProfileMs('profile_ms_test_device_keys');
  owner = await signupWithUsername(app, { phone: '+919700000001', username: 'key_owner' });
});
after(async () => { await app?.stop(); });

const publish = (payload = keys) => app.inject({
  method: 'PUT', url: '/keys/me', headers: bearer(owner.accesskey), payload
});

test('real store claims atomically and upload replay cannot restore consumed keys', async () => {
  const [published, duplicate] = await Promise.all([publish(), publish()]);
  assert.equal(published.statusCode, 200);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(published.json().generation, duplicate.json().generation);
  assert.equal((await app.server.context.authDB.listDeviceKeys(owner.user_id)).length, 1);
  const device = published.json();
  const claim = () => app.inject({
    method: 'POST', url: `/keys/${owner.user_id}/claim`, headers: bearer(owner.accesskey),
    payload: { deviceId: device.deviceId, generation: device.generation }
  });
  const claims = await Promise.all(Array.from({ length: 8 }, claim));
  claims.forEach((response) => assert.equal(response.statusCode, 200, response.payload));
  assert.equal(new Set(claims.map((response) => response.json().preKey.id)).size, 8);
  assert.equal((await publish()).json().preKeyCount, 0);
  assert.equal((await claim()).json().preKey, null);
  assert.equal((await publish({ ...keys, preKeys: [{ id: 8, publicKey: publicKey() }] })).json().preKeyCount, 1);
  assert.equal((await claim()).json().preKey.id, 8);
});

test('real store preserves signed keys through JSON serialization and account deletion purges all keys', async () => {
  const rotated = { ...keys, signedPreKey: { ...keys.signedPreKey, id: 2 } };
  assert.equal((await publish(rotated)).statusCode, 200);
  const replay = await publish(keys);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().signedPreKey.id, 2);
  const deleted = await app.inject({
    method: 'POST', url: '/users/me/delete', headers: bearer(owner.accesskey),
    payload: { confirmation: 'DELETE key_owner' }
  });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(await app.server.context.authDB.listDeviceKeys(owner.user_id), []);
});
