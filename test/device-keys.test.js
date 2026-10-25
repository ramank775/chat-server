const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { bundleSchema, publishKeys, claimKeys } = require('../services/profile-ms/device-keys');
const { ProfileMs, parseOptions } = require('../services/profile-ms/profile-ms');
const { AuthError } = require('../services/profile-ms/auth-provider');
const { LocalCache } = require('../libs/cache/local-cache');

const ALICE = '000000001';
const BOB = '000000002';
const publicKey = () => Buffer.concat([Buffer.from([5]), crypto.randomBytes(32)]).toString('base64');
const bundle = (count = 8) => ({
  identityKey: publicKey(), registrationId: 42,
  signedPreKey: { id: 1, publicKey: publicKey(), signature: crypto.randomBytes(64).toString('base64') },
  preKeys: Array.from({ length: count }, (_, id) => ({ id, publicKey: publicKey() }))
});

function memoryKeys() {
  const rows = new Map();
  const key = (userId, deviceId) => `${userId}/${deviceId}`;
  return {
    getDeviceKeys: async (userId, deviceId) => structuredClone(rows.get(key(userId, deviceId)) || null),
    saveDeviceKeys: async (record, expected) => {
      const id = key(record.user_id, record.deviceId);
      if ((rows.get(id)?.revision || null) !== expected) return false;
      rows.set(id, structuredClone(record));
      return true;
    },
    listDeviceKeys: async (userId) => structuredClone([...rows.values()].filter((r) => r.user_id === userId)),
    deleteDeviceKeys: async (userId, { deviceId, exceptDeviceId } = {}) => {
      rows.forEach((r, id) => {
        if (r.user_id === userId && (!deviceId || r.deviceId === deviceId)
          && r.deviceId !== exceptDeviceId) rows.delete(id);
      });
    }
  };
}

test('public bundle schema rejects private fields, invalid encodings and duplicate prekey ids', () => {
  const valid = bundle();
  assert.equal(bundleSchema.validate(valid).error, undefined);
  for (const invalid of [ // eslint-disable-line no-restricted-syntax
    { ...valid, privateKey: 'secret' },
    { ...valid, deviceId: 'someone-else' },
    { ...valid, identityKey: Buffer.alloc(33).toString('base64') },
    { ...valid, identityKey: 'not-base64' },
    { ...valid, registrationId: 0 },
    { ...valid, signedPreKey: { ...valid.signedPreKey, signature: 'AA==' } },
    { ...valid, preKeys: [valid.preKeys[0], valid.preKeys[0]] },
    { ...valid, preKeys: Array.from({ length: 201 }, (_, id) => ({ id, publicKey: publicKey() })) }
  ]) assert.ok(bundleSchema.validate(invalid).error);
});

test('concurrent claims consume each key once; replayed uploads never replenish consumed ids', async () => {
  const db = memoryKeys();
  const keys = bundle();
  const published = await publishKeys(db, ALICE, 'a', keys);
  const claims = await Promise.all(Array.from({ length: 8 }, () =>
    claimKeys(db, ALICE, 'a', published.generation)));
  assert.equal(new Set(claims.map((r) => r.preKey.id)).size, 8);
  assert.equal((await publishKeys(db, ALICE, 'a', keys)).preKeyCount, 0);
  assert.equal((await claimKeys(db, ALICE, 'a', published.generation)).preKey, null);
  const replenished = await publishKeys(db, ALICE, 'a', {
    ...keys, preKeys: [{ id: 8, publicKey: publicKey() }]
  });
  assert.equal(replenished.generation, published.generation);
  assert.equal(replenished.preKeyCount, 1);
});

test('claim racing replenishment preserves the added keys', async () => {
  const db = memoryKeys();
  const keys = bundle(1);
  const { generation } = await publishKeys(db, ALICE, 'a', keys);
  const [claimed] = await Promise.all([
    claimKeys(db, ALICE, 'a', generation),
    publishKeys(db, ALICE, 'a', { ...keys, preKeys: [{ id: 1, publicKey: publicKey() }] })
  ]);
  assert.equal(claimed.preKey.id, 0);
  assert.equal((await claimKeys(db, ALICE, 'a', generation)).preKey.id, 1);
});

test('signed key ids cannot be overwritten or rolled back; identity replacement retires its generation', async () => {
  const db = memoryKeys();
  const keys = bundle(1);
  const initial = await publishKeys(db, ALICE, 'a', keys);
  await assert.rejects(publishKeys(db, ALICE, 'a', { ...keys, registrationId: 43 }), { code: 'KEY_CONFLICT' });
  await assert.rejects(publishKeys(db, ALICE, 'a', {
    ...keys, signedPreKey: { ...keys.signedPreKey, publicKey: publicKey() }
  }), { code: 'KEY_CONFLICT' });
  const nextSigned = { id: 2, publicKey: publicKey(), signature: crypto.randomBytes(64).toString('base64') };
  await publishKeys(db, ALICE, 'a', { ...keys, signedPreKey: nextSigned });
  assert.deepEqual((await publishKeys(db, ALICE, 'a', keys)).signedPreKey, nextSigned);
  const replaced = await publishKeys(db, ALICE, 'a', bundle(1));
  assert.notEqual(replaced.generation, initial.generation);
  await assert.rejects(claimKeys(db, ALICE, 'a', initial.generation), { code: 'KEYS_NOT_FOUND' });
});

test('prekey queue and contention are bounded', async () => {
  const db = memoryKeys();
  const keys = bundle(200);
  await publishKeys(db, ALICE, 'a', keys);
  await assert.rejects(publishKeys(db, ALICE, 'a', {
    ...keys, preKeys: [{ id: 200, publicKey: publicKey() }]
  }), { code: 'PREKEY_CAPACITY' });
  db.saveDeviceKeys = async () => false;
  await assert.rejects(publishKeys(db, BOB, 'b', bundle(1)), { code: 'KEYS_BUSY' });
});

test('signed key comparison ignores JSON field order', async () => {
  const db = memoryKeys();
  const keys = bundle(1);
  await publishKeys(db, ALICE, 'a', keys);
  const { signature, publicKey: key, id } = keys.signedPreKey;
  assert.equal((await publishKeys(db, ALICE, 'a', {
    ...keys, signedPreKey: { signature, publicKey: key, id }
  })).preKeyCount, 1);
});

async function serviceHarness(t) {
  const db = memoryKeys();
  const users = new Map([ALICE, BOB].map((id) => [id, { user_id: id, username: `user_${id}` }]));
  const noop = () => {};
  const service = new ProfileMs({
    options: parseOptions(['node', 'test']), authDB: db,
    log: { info: noop, warn: noop, error: noop, debug: noop },
    statsClient: { increment: noop, timing: noop }, memCache: new LocalCache(),
    profileDB: {
      getByUserId: async (id) => users.get(id) || null,
      updateUser: async (id) => users.delete(id)
    },
    authProvider: {
      verifyAccessKey: async (token) => {
        if (![ALICE, BOB].includes(token)) throw new AuthError(401, 'INVALID_ACCESSKEY', 'Invalid session');
        return { user_id: token, deviceId: token === ALICE ? 'a' : 'b' };
      },
      revokeAll: async () => {}
    }
  });
  await service.init();
  await service.server.ready();
  service.revokeGatewaySessions = async () => {};
  service.revokePushTopics = async () => {};
  t.after(() => service.server.close());
  const inject = (method, url, payload, caller = ALICE) => service.server.inject({
    method, url, payload, headers: { authorization: `Bearer ${caller}` }
  });
  return { service, db, inject, users };
}

test('routes authenticate, bind publishing to the session and disclose only public bundles', async (t) => {
  const { inject } = await serviceHarness(t);
  assert.equal((await inject('GET', `/keys/${ALICE}`, undefined, 'bad')).statusCode, 401);
  assert.equal((await inject('PUT', '/keys/me', { ...bundle(), deviceId: 'b' })).statusCode, 400);
  const published = await inject('PUT', '/keys/me', bundle(1));
  assert.equal(published.statusCode, 200);
  assert.equal(published.json().deviceId, 'a');
  const listed = await inject('GET', `/keys/${ALICE}`, undefined, BOB);
  const device = listed.json().devices[0];
  assert.deepEqual(Object.keys(device).sort(), ['deviceId', 'generation', 'identityKey', 'registrationId', 'signedPreKey']);
  const claim = { deviceId: 'a', generation: device.generation };
  assert.equal((await inject('POST', `/keys/${ALICE}/claim`, claim, BOB)).json().preKey.id, 0);
  assert.equal((await inject('POST', `/keys/${ALICE}/claim`, claim, BOB)).json().preKey, null);
  assert.equal((await inject('POST', `/keys/${BOB}/claim`, claim, BOB)).statusCode, 404);
});

test('account deletion removes every published device; racing registration cleans itself up', async (t) => {
  const { db, inject, users } = await serviceHarness(t);
  await inject('PUT', '/keys/me', bundle(1));
  await publishKeys(db, ALICE, 'second-device', bundle(1));
  assert.equal((await inject('POST', '/users/me/delete', { confirmation: `DELETE user_${ALICE}` })).statusCode, 200);
  assert.deepEqual(await db.listDeviceKeys(ALICE), []);
  assert.equal((await inject('GET', `/keys/${ALICE}`, undefined, BOB)).statusCode, 404);
  const save = db.saveDeviceKeys;
  db.saveDeviceKeys = async (...args) => {
    const saved = await save(...args);
    users.delete(BOB);
    return saved;
  };
  assert.equal((await inject('PUT', '/keys/me', bundle(1), BOB)).statusCode, 401);
  assert.deepEqual(await db.listDeviceKeys(BOB), []);
});

test('an upload racing the login that signed its phone out withdraws itself (183)', async (t) => {
  const { service, db, inject } = await serviceHarness(t);
  const save = db.saveDeviceKeys;
  db.saveDeviceKeys = async (...args) => {
    const saved = await save(...args);
    service.authProvider.verifyAccessKey = async () => {
      throw new AuthError(401, 'INVALID_ACCESSKEY', 'Signed out');
    };
    return saved;
  };
  assert.equal((await inject('PUT', '/keys/me', bundle(1))).statusCode, 401);
  assert.deepEqual(await db.listDeviceKeys(ALICE), []);
});

test('key publications enforce rate limits', async (t) => {
  const { inject } = await serviceHarness(t);
  const keys = bundle(1);
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await inject('PUT', '/keys/me', keys)).statusCode, 200);
  }
  const limited = await inject('PUT', '/keys/me', keys);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
});
