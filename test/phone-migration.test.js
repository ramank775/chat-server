const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sha256 } = require('../helper');
const { TEST_DB } = require('./helpers/db');
const { startProfileMs, signup, bearer } = require('./helpers/profile-ms');
const { phonePepper, pepperFingerprint } = require('../services/profile-ms/phone-key');
const { parseOptions } = require('../services/profile-ms/profile-ms');

const LIVE = '+919500000001';
const PHONE_ONLY = '+919500000002';
const created = new Date('2026-10-01T00:00:00Z');

/** Rows as a server before decision 223 left them: the plain number and its unsalted hash. */
async function seedPlainRows(raw) {
  if (TEST_DB === 'pg') {
    await raw.query(`
      CREATE TABLE users (
        user_id text PRIMARY KEY, phone text, phone_hash text, username text,
        username_lower text UNIQUE, username_key_hash text, username_changed_at timestamptz,
        display_name text, avatar_url text, status_text text,
        created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
      );
      CREATE UNIQUE INDEX users_phone_live ON users (phone) WHERE deleted_at IS NULL;
      CREATE INDEX users_phone_hash ON users (phone_hash);
      CREATE TABLE otp_sessions (
        session_id text PRIMARY KEY, phone text, device_id text, user_id text, code_hash text,
        encrypted_code text, attempts integer, consumed boolean, resend_after timestamptz,
        expires_at timestamptz, created_at timestamptz
      );
      CREATE INDEX otp_sessions_phone_device ON otp_sessions (phone, device_id);
    `);
    await raw.query(
      `INSERT INTO users (user_id, phone, phone_hash, username, username_lower, created_at, deleted_at)
       VALUES ('00000000a', $1, $2, 'legacy_one', 'legacy_one', $4, NULL),
              ('00000000b', $3, NULL, NULL, NULL, $4, NULL),
              ('00000000c', NULL, NULL, 'gone_one', 'gone_one', NULL, $4)`,
      [LIVE, sha256(LIVE), PHONE_ONLY, created]
    );
    await raw.query(
      `INSERT INTO otp_sessions (session_id, phone, device_id, consumed, expires_at, created_at)
       VALUES ('old-session', $1, 'd1', false, $2, now())`,
      [LIVE, new Date(Date.now() + 600000)]
    );
    return;
  }
  const users = raw.collection('users');
  await users.createIndex(
    { phone: 1 },
    { unique: true, partialFilterExpression: { deletedAt: { $type: 'null' } } }
  );
  await users.createIndex({ phoneHash: 1 });
  await users.insertMany([
    { user_id: '00000000a', phone: LIVE, phoneHash: sha256(LIVE), username: 'legacy_one', usernameLower: 'legacy_one', createdAt: created, deletedAt: null },
    { user_id: '00000000b', phone: PHONE_ONLY, username: null, usernameLower: null, createdAt: created, deletedAt: null },
    { user_id: '00000000c', phone: null, phoneHash: null, username: 'gone_one', usernameLower: 'gone_one', createdAt: null, deletedAt: created }
  ]);
  await raw.collection('otp_sessions').createIndex({ phone: 1, deviceId: 1 });
  await raw.collection('otp_sessions').insertOne({
    sessionId: 'old-session', phone: LIVE, deviceId: 'd1', consumed: false, createdAt: new Date()
  });
}

/** Every field of a users row, the dropped legacy ones included. */
async function rawUser(raw, userId) {
  if (TEST_DB === 'pg') {
    const { rows } = await raw.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    return rows[0];
  }
  return raw.collection('users').findOne({ user_id: userId });
}

describe(`plain phone numbers become phone keys at boot (decision 223, ${TEST_DB})`, () => {
  /** @type {Awaited<ReturnType<typeof startProfileMs>>} */
  let app;

  before(async () => {
    app = await startProfileMs('profile_ms_test_phone_migration', { seed: seedPlainRows });
  });

  after(async () => {
    await app.stop();
  });

  test('no row keeps the number or its unsalted hash', async () => {
    const live = await rawUser(app.raw, '00000000a');
    assert.equal(live.phone, undefined);
    assert.equal(live.phone_hash ?? live.phoneHash, undefined);
    const key = live.phone_key ?? live.phoneKey;
    assert.equal(key, app.server.keyOfPhone(LIVE));
    assert.notEqual(key, sha256(LIVE), 'keyed, not the plain SHA-256');

    const phoneOnly = await rawUser(app.raw, '00000000b');
    assert.equal(phoneOnly.phone_key ?? phoneOnly.phoneKey, app.server.keyOfPhone(PHONE_ONLY));

    const tombstone = await rawUser(app.raw, '00000000c');
    assert.equal(tombstone.phone, undefined);
    assert.equal(tombstone.phone_key ?? tombstone.phoneKey ?? null, null);

    if (TEST_DB === 'pg') {
      const { rows } = await app.raw.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name IN ('users', 'otp_sessions') AND column_name IN ('phone', 'phone_hash')`
      );
      assert.deepEqual(rows, [], 'the plain columns are dropped');
    }
    assert.equal(await app.db.collection('otp_sessions').findOne({ sessionId: 'old-session' }), null,
      'a challenge holding a plain number is dropped');
  });

  test('the migrated account is still found by its number and still signs in', async () => {
    const reader = await signup(app, { phone: '+919500000010' });
    await app.inject({
      method: 'PATCH', url: '/users/me', headers: bearer(reader.accesskey), payload: { username: 'reader_mig' }
    });
    const lookup = await app.inject({
      method: 'POST',
      url: '/contacts/lookup',
      headers: bearer(reader.accesskey),
      payload: { phoneHashes: [sha256(LIVE), sha256(PHONE_ONLY)] }
    });
    const ids = JSON.parse(lookup.payload).matches.map((match) => match.user_id).sort();
    assert.deepEqual(ids, ['00000000a', '00000000b']);

    const again = await signup(app, { phone: LIVE });
    assert.equal(again.isNew, false);
    assert.equal(again.user_id, '00000000a');
    assert.equal(again.username, 'legacy_one');

    // the old unique index on `phone` is gone: phoneless rows no longer collide
    const fresh = await signup(app, { phone: '+919500000011' });
    assert.equal(fresh.isNew, true);
  });

  test('a second boot changes nothing; another pepper refuses to boot', async () => {
    const fingerprint = pepperFingerprint;
    const keyOf = (hash) => app.server.keyOfHash(hash);
    await app.server.profileDB.migratePhones(keyOf, fingerprint(app.server.pepper));
    const live = await rawUser(app.raw, '00000000a');
    assert.equal(live.phone_key ?? live.phoneKey, app.server.keyOfPhone(LIVE));

    await assert.rejects(
      app.server.profileDB.migratePhones(keyOf, fingerprint(Buffer.alloc(32, 7))),
      /PHONE_PEPPER differs/
    );
  });
});

test('a real SMS sender needs a 64 hex PHONE_PEPPER; only mock SMS runs without', () => {
  [undefined, '', 'ab'.repeat(31), 'gg'.repeat(32)].forEach((hex) => {
    assert.throws(() => phonePepper({ smsSender: 'sms-gate-app', phonePepper: hex }), /PHONE_PEPPER/);
  });
  assert.equal(phonePepper({ smsSender: 'telegram', phonePepper: 'ab'.repeat(32) }).length, 32);
  assert.ok(phonePepper({ smsSender: 'mock' }).length > 0);
  const previous = process.env.PHONE_PEPPER;
  try {
    process.env.PHONE_PEPPER = 'cd'.repeat(32);
    assert.equal(parseOptions(['node', 'test']).phonePepper, 'cd'.repeat(32));
  } finally {
    if (previous === undefined) delete process.env.PHONE_PEPPER;
    else process.env.PHONE_PEPPER = previous;
  }
});
