const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { NotificationMS } = require('../notification-ms');

const USER = 'a1b2c3d4e';
/** Wakes are keyed per `(user_id, device_id)` — TRIM_4_12_CONTRACT §7. */
const SUBJECT = `${USER}:device-1`;
/** A public IP literal: registration resolves it without the network. */
const ENDPOINT = 'https://8.8.8.8/up/abcdefgh12345678';
const VAPID_PUBLIC_KEY = `BOr6${'A'.repeat(83)}`;

/** A device's UnifiedPush keys (AUTH_CONTRACT 5.1). */
function deviceKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url')
  };
}
const KEYS = deviceKeys();
const REGISTRATION = { deviceId: 'device-1', endpoint: ENDPOINT, ...KEYS };

// ponytail: hand rolled stubs, the repo has no test framework and these are
// the only three collaborators notification-ms has.
function noop() { }
const log = { info: noop, error: noop, debug: noop };
const statsClient = { increment: noop, timing: noop };

function stubDb() {
  return {
    topics: [],
    calls: [],
    async upsertTopic(userId, options) {
      this.calls.push(['upsert', userId, options]);
    },
    async removeTopic(userId, options) {
      this.calls.push(['remove', userId, options]);
    },
    async getTopics() {
      return this.topics;
    }
  };
}

/** Records every wake, answers with `status`. */
function stubPns(status = 201) {
  return {
    pushes: [],
    async push(subscription) {
      this.pushes.push(subscription);
      return status;
    }
  };
}

async function buildService(db, pns = stubPns()) {
  const options = { port: 0, host: '127.0.0.1', baseRoute: '', vapidPublicKey: VAPID_PUBLIC_KEY };
  const context = {
    options,
    log,
    statsClient,
    notificationDB: db,
    pns,
    eventStore: {},
    events: { 'push-notification': 'offline-message' }
  };
  const service = new NotificationMS(context);
  await service.init();
  return service;
}

function authHeaders(extra = {}) {
  // The auth layer sets x-user/x-device; user/accesskey are kept until
  // helper/schema.js drops them.
  return {
    user: USER,
    accesskey: 'test-accesskey',
    'x-user': USER,
    'x-device': 'device-1',
    ...extra
  };
}

function register(service, payload) {
  return service.server.inject({ method: 'POST', url: '/topic', headers: authHeaders(), payload });
}

test('wake goes to the registered endpoint and never carries message content', async () => {
  const db = stubDb();
  db.topics = [REGISTRATION, { deviceId: 'device-2', endpoint: 'https://8.8.4.4/other', ...KEYS }];
  const pns = stubPns();
  const service = await buildService(db, pns);

  await service.pushNotification({ type: 'text', text: 'a secret message' }, SUBJECT);

  assert.deepStrictEqual(pns.pushes, [REGISTRATION]);
  assert.deepStrictEqual(db.calls, []);
});

test('wake is debounced per (user_id, device_id)', async () => {
  const db = stubDb();
  db.topics = [REGISTRATION];
  const pns = stubPns();
  const service = await buildService(db, pns);

  await service.pushNotification({ type: 'text' }, SUBJECT);
  await service.pushNotification({ type: 'text' }, SUBJECT);
  assert.strictEqual(pns.pushes.length, 1, 'second wake within 5s is dropped');

  await service.pushNotification({ type: 'text' }, 'f00ba4321:device-1');
  assert.strictEqual(pns.pushes.length, 2, 'another recipient is not debounced');
});

test('a pre Web Push topicUrl row is never woken', async () => {
  const db = stubDb();
  db.topics = [{ deviceId: 'device-1', topicUrl: 'https://ntfy.sh/old' }];
  const pns = stubPns();
  const service = await buildService(db, pns);

  await service.pushNotification({ type: 'text' }, SUBJECT);

  assert.strictEqual(pns.pushes.length, 0);
});

[404, 410].forEach((status) => {
  test(`a ${status} from the push service deletes that registration (5.2 case 4)`, async () => {
    const db = stubDb();
    db.topics = [REGISTRATION];
    const service = await buildService(db, stubPns(status));

    await service.pushNotification({ type: 'text' }, SUBJECT);

    assert.deepStrictEqual(db.calls, [['remove', USER, { deviceId: 'device-1', endpoint: ENDPOINT }]]);
  });
});

test('a 413 or a 429 keeps the registration', async () => {
  const db = stubDb();
  db.topics = [REGISTRATION];
  await (await buildService(db, stubPns(413))).pushNotification({ type: 'text' }, SUBJECT);
  await (await buildService(db, stubPns(429))).pushNotification({ type: 'text' }, SUBJECT);
  assert.deepStrictEqual(db.calls, []);
});

test('GET /vapid returns the configured public key (5.0)', async () => {
  const service = await buildService(stubDb());

  const res = await service.server.inject({ method: 'GET', url: '/vapid', headers: authHeaders() });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.payload), { vapidPublicKey: VAPID_PUBLIC_KEY });
});

test('push topic registration stores endpoint and keys', async () => {
  const db = stubDb();
  const service = await buildService(db);

  const res = await register(service, { endpoint: ENDPOINT, ...KEYS });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.payload), { status: true });
  assert.deepStrictEqual(db.calls, [['upsert', USER, REGISTRATION]]);
});

test('push topic registration rejects a bad endpoint with INVALID_PUSH_ENDPOINT', async () => {
  const db = stubDb();
  const service = await buildService(db);

  const bad = [
    'http://8.8.8.8/up/x',
    'https://user:pw@8.8.8.8/up/x',
    `https://8.8.8.8/${'a'.repeat(2048)}`,
    'https://127.0.0.1/up/x',
    'https://10.0.0.1/up/x',
    'https://[::1]/up/x',
    'https://[::ffff:192.168.1.1]/up/x',
    'https://localhost/up/x',
    'not a url'
  ];
  // eslint-disable-next-line no-restricted-syntax
  for (const endpoint of bad) {
    // eslint-disable-next-line no-await-in-loop
    const res = await register(service, { endpoint, ...KEYS });
    assert.strictEqual(res.statusCode, 400, endpoint);
    assert.strictEqual(JSON.parse(res.payload).error.code, 'INVALID_PUSH_ENDPOINT', endpoint);
  }
  assert.deepStrictEqual(db.calls, []);
});

test('push topic registration rejects bad keys with INVALID_PUSH_KEYS', async () => {
  const db = stubDb();
  const service = await buildService(db);
  const offCurve = Buffer.from(KEYS.p256dh, 'base64url');
  offCurve[64] = offCurve[64] === 0 ? 1 : 0; // y no longer matches x

  const bad = [
    {},
    { p256dh: KEYS.p256dh },
    { auth: KEYS.auth },
    { ...KEYS, p256dh: KEYS.p256dh.slice(0, -2) },
    { ...KEYS, p256dh: offCurve.toString('base64url') },
    { ...KEYS, auth: crypto.randomBytes(15).toString('base64url') },
    { ...KEYS, auth: `${KEYS.auth.slice(0, -1)}+` }
  ];
  // eslint-disable-next-line no-restricted-syntax
  for (const keys of bad) {
    // eslint-disable-next-line no-await-in-loop
    const res = await register(service, { endpoint: ENDPOINT, ...keys });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(keys));
    assert.strictEqual(JSON.parse(res.payload).error.code, 'INVALID_PUSH_KEYS', JSON.stringify(keys));
  }
  assert.deepStrictEqual(db.calls, []);
});

test('push topic registration with the dev flag takes an http private endpoint', async () => {
  const db = stubDb();
  const service = await buildService(db);
  service.options.pushAllowPrivateEndpoints = true;

  const res = await register(service, { endpoint: 'http://10.0.2.2:8090/upTopic', ...KEYS });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(db.calls.length, 1);
});

test('push topic registration deregisters on null', async () => {
  const db = stubDb();
  const service = await buildService(db);

  const res = await service.server.inject({
    method: 'POST',
    url: '/topic',
    headers: authHeaders(),
    payload: { endpoint: null }
  });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(db.calls, [['remove', USER, { deviceId: 'device-1' }]]);
});

test('internal push topic delete scopes to one device when deviceId is given', async () => {
  const db = stubDb();
  const service = await buildService(db);

  const res = await service.server.inject({
    method: 'POST',
    url: '/_internal/push/topics/delete',
    payload: { user_id: USER, deviceId: 'device-1' }
  });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.payload), { status: true });
  assert.deepStrictEqual(db.calls, [['remove', USER, { deviceId: 'device-1' }]]);
});

test('internal push topic delete removes every device when deviceId is absent', async () => {
  const db = stubDb();
  const service = await buildService(db);

  const res = await service.server.inject({
    method: 'POST',
    url: '/_internal/push/topics/delete',
    payload: { user_id: USER }
  });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(db.calls, [['remove', USER, { deviceId: undefined }]]);
});
