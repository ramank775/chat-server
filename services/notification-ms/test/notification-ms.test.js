const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { NotificationMS } = require('../notification-ms');
const {
  EnvelopeEvent, ENVELOPE_FLAG, FRAME_CLASS, classFlags, wakes
} = require('../../../libs/v3-envelope');

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
/** A queued frame with these flags (none: a new message) for an offline device. */
const frame = (flags = 0, payload = Buffer.from('chat')) => EnvelopeEvent.of({ flags, payload }, []);
const MESSAGE = frame();

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

  await service.pushNotification(frame(0, Buffer.from('a secret message')), SUBJECT);

  assert.deepStrictEqual(pns.pushes, [REGISTRATION]);
  assert.deepStrictEqual(db.calls, []);
});

test('wake is debounced per (user_id, device_id), held back not dropped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const db = stubDb();
  db.topics = [REGISTRATION];
  const pns = stubPns();
  const service = await buildService(db, pns);

  await service.pushNotification(MESSAGE, SUBJECT);
  await service.pushNotification(MESSAGE, SUBJECT);
  await service.pushNotification(MESSAGE, SUBJECT);
  assert.strictEqual(pns.pushes.length, 1, 'wakes within 5s wait');

  await service.pushNotification(MESSAGE, 'f00ba4321:device-1');
  assert.strictEqual(pns.pushes.length, 2, 'another recipient is not debounced');

  t.mock.timers.tick(5000);
  await new Promise(setImmediate);
  assert.strictEqual(pns.pushes.length, 3, 'one wake when the window ends, for both held back');
});

test('the wake rule: only MESSAGE and RESEND wake, and never with SILENT (decision 218)', () => {
  const { SILENT } = ENVELOPE_FLAG;
  const table = Object.entries(FRAME_CLASS).map(([name, cls]) => [
    name, wakes(classFlags(cls)), wakes(classFlags(cls) + SILENT)
  ]);
  assert.deepStrictEqual(table, [
    ['MESSAGE', true, false],
    ['MUTATION', false, false],
    ['RECEIPT', false, false],
    ['KEY', false, false],
    ['RESEND', true, false],
    ['EVENT', false, false]
  ]);
  assert.strictEqual(wakes(0), true, 'no flags is a MESSAGE');
  assert.strictEqual(wakes(undefined), true);
  // a bit the server does not know leaves the class alone
  assert.strictEqual(wakes(classFlags(FRAME_CLASS.RESEND) + 32), true);
  assert.strictEqual(wakes(classFlags(FRAME_CLASS.RECEIPT) + 32), false);
});

test('a frame that does not wake leaves the debounce window alone', async () => {
  const db = stubDb();
  db.topics = [REGISTRATION];
  const pns = stubPns();
  const service = await buildService(db, pns);

  const quiet = [
    frame(classFlags(FRAME_CLASS.RECEIPT)),
    frame(classFlags(FRAME_CLASS.MUTATION)),
    frame(classFlags(FRAME_CLASS.KEY)),
    frame(classFlags(FRAME_CLASS.EVENT)),
    frame(ENVELOPE_FLAG.SILENT),
    frame(classFlags(FRAME_CLASS.RESEND) + ENVELOPE_FLAG.SILENT),
    EnvelopeEvent.of({ ephemeral: true }, [])
  ];
  await Promise.all(quiet.map((event) => service.pushNotification(event, SUBJECT)));
  assert.strictEqual(pns.pushes.length, 0, 'none of those wakes');

  await service.pushNotification(frame(classFlags(FRAME_CLASS.RESEND)), SUBJECT);
  assert.strictEqual(pns.pushes.length, 1, 'a resend request wakes at once');
});

test('a pre Web Push topicUrl row is never woken', async () => {
  const db = stubDb();
  db.topics = [{ deviceId: 'device-1', topicUrl: 'https://ntfy.sh/old' }];
  const pns = stubPns();
  const service = await buildService(db, pns);

  await service.pushNotification(MESSAGE, SUBJECT);

  assert.strictEqual(pns.pushes.length, 0);
});

[404, 410].forEach((status) => {
  test(`a ${status} from the push service deletes that registration (5.2 case 4)`, async () => {
    const db = stubDb();
    db.topics = [REGISTRATION];
    const service = await buildService(db, stubPns(status));

    await service.pushNotification(MESSAGE, SUBJECT);

    assert.deepStrictEqual(db.calls, [['remove', USER, { deviceId: 'device-1', endpoint: ENDPOINT }]]);
  });
});

test('a 413 or a 429 keeps the registration', async () => {
  const db = stubDb();
  db.topics = [REGISTRATION];
  await (await buildService(db, stubPns(413))).pushNotification(MESSAGE, SUBJECT);
  await (await buildService(db, stubPns(429))).pushNotification(MESSAGE, SUBJECT);
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

test('push topic registration stores an FCM token as an fcm: registration (decision 209)', async () => {
  const db = stubDb();
  const service = await buildService(db);
  const fcmToken = 'dGVzdA:APA91b-token_0123456789abcdefghijklmnop';

  const res = await register(service, { fcmToken });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(db.calls, [['upsert', USER, {
    deviceId: 'device-1', endpoint: `fcm:${fcmToken}`, p256dh: null, auth: null
  }]]);
  const both = await register(service, { endpoint: ENDPOINT, ...KEYS, fcmToken });
  assert.strictEqual(both.statusCode, 400);
  const junk = await register(service, { fcmToken: 'not a token!' });
  assert.strictEqual(junk.statusCode, 400);
  assert.strictEqual(db.calls.length, 1);
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
