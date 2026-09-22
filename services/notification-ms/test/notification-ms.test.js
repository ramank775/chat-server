const test = require('node:test');
const assert = require('node:assert');
const { NotificationMS } = require('../notification-ms');
const ntfy = require('../pns/ntfy-pn-service');

const NTFY_BASE_URL = 'https://ntfy.vartalap.test';
const USER = 'a1b2c3d4e';
/** Wakes are keyed per `(user_id, device_id)` — TRIM_4_12_CONTRACT §7. */
const SUBJECT = `${USER}:device-1`;
const TOPIC_URL = `${NTFY_BASE_URL}/u/abcdefgh12345678`;

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

/** Records every request an ntfy publish would have made. */
function stubAxios() {
  return {
    posts: [],
    async post(url, body, config) {
      this.posts.push({ url, body, config });
    }
  };
}

async function buildService(db, axiosStub) {
  const options = { port: 0, host: '127.0.0.1', baseRoute: '', ntfyBaseUrl: NTFY_BASE_URL };
  const pnsContext = { options, log, ntfyClient: axiosStub };
  const context = {
    options,
    log,
    statsClient,
    notificationDB: db,
    pns: new ntfy.Implementation(pnsContext),
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

test('ntfy wake posts to the registered topic without message content', async () => {
  const db = stubDb();
  db.topics = [{ deviceId: 'device-1', topicUrl: TOPIC_URL }];
  const axiosStub = stubAxios();
  const service = await buildService(db, axiosStub);

  await service.pushNotification({ type: 'text', text: 'a secret message' }, SUBJECT);

  assert.strictEqual(axiosStub.posts.length, 1);
  const [post] = axiosStub.posts;
  assert.strictEqual(post.url, TOPIC_URL);
  assert.strictEqual(post.body, ntfy.WAKE_BODY);
  assert.strictEqual(post.config.headers.Title, ntfy.WAKE_TITLE);
  assert.ok(!JSON.stringify(post).includes('a secret message'));
});

test('ntfy wake is debounced per (user_id, device_id)', async () => {
  const db = stubDb();
  db.topics = [{ deviceId: 'device-1', topicUrl: TOPIC_URL }];
  const axiosStub = stubAxios();
  const service = await buildService(db, axiosStub);

  await service.pushNotification({ type: 'text' }, SUBJECT);
  await service.pushNotification({ type: 'text' }, SUBJECT);
  assert.strictEqual(axiosStub.posts.length, 1, 'second wake within 5s is dropped');

  await service.pushNotification({ type: 'text' }, 'f00ba4321:device-1');
  assert.strictEqual(axiosStub.posts.length, 2, 'another recipient is not debounced');
});

test('ntfy never publishes to a topic outside the configured base url', async () => {
  const db = stubDb();
  db.topics = [{ deviceId: 'device-1', topicUrl: 'https://evil.test/u/abcdefgh12345678' }];
  const axiosStub = stubAxios();
  const service = await buildService(db, axiosStub);

  await service.pushNotification({ type: 'text' }, SUBJECT);

  assert.strictEqual(axiosStub.posts.length, 0);
});

test('push topic registration stores an in base url https topic', async () => {
  const db = stubDb();
  const service = await buildService(db, stubAxios());

  const res = await service.server.inject({
    method: 'POST',
    url: '/topic',
    headers: authHeaders(),
    payload: { topicUrl: TOPIC_URL }
  });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(db.calls, [
    ['upsert', USER, { deviceId: 'device-1', topicUrl: TOPIC_URL }]
  ]);
});

test('push topic registration rejects a non https topic', async () => {
  const db = stubDb();
  const service = await buildService(db, stubAxios());

  const res = await service.server.inject({
    method: 'POST',
    url: '/topic',
    headers: authHeaders(),
    payload: { topicUrl: 'http://ntfy.vartalap.test/u/abcdefgh12345678' }
  });

  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(db.calls, []);
});

test('push topic registration rejects a topic on another host', async () => {
  const db = stubDb();
  const service = await buildService(db, stubAxios());

  const res = await service.server.inject({
    method: 'POST',
    url: '/topic',
    headers: authHeaders(),
    payload: { topicUrl: 'https://ntfy.vartalap.test.evil.test/u/abcdefgh12345678' }
  });

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(JSON.parse(res.payload).error.code, 'INVALID_TOPIC_URL');
  assert.deepStrictEqual(db.calls, []);
});

test('push topic registration deregisters on null', async () => {
  const db = stubDb();
  const service = await buildService(db, stubAxios());

  const res = await service.server.inject({
    method: 'POST',
    url: '/topic',
    headers: authHeaders(),
    payload: { topicUrl: null }
  });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(db.calls, [['remove', USER, { deviceId: 'device-1' }]]);
});

test('internal push topic delete scopes to one device when deviceId is given', async () => {
  const db = stubDb();
  const service = await buildService(db, stubAxios());

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
  const service = await buildService(db, stubAxios());

  const res = await service.server.inject({
    method: 'POST',
    url: '/_internal/push/topics/delete',
    payload: { user_id: USER }
  });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(db.calls, [['remove', USER, { deviceId: undefined }]]);
});
