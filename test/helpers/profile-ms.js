const { MongoClient } = require('mongodb');
const { Pool } = require('pg');
const { ProfileMs, parseOptions, initResource } = require('../../services/profile-ms/profile-ms');
const pgProfileDb = require('../../services/profile-ms/database/profile/pg-profile-db');
const pgAuthDb = require('../../services/profile-ms/database/auth/pg-auth-db');
const {
  TEST_DB,
  MONGO_URL,
  mongoUrlFor,
  pgUrlFor,
  freshPgDatabase,
  dropPgDatabase,
  dbFlags,
  pgDb
} = require('./db');

const REDIS_ENDPOINT = process.env.REDIS_ENDPOINT || 'localhost:6379';

/**
 * The tests' own handle on the stores (`db.collection(...)`), on this run's
 * backend, and how to clean it up.
 * @param {string} dbName
 */
async function openStore(dbName) {
  if (TEST_DB === 'pg') {
    const pool = new Pool({ connectionString: pgUrlFor(dbName) });
    const db = pgDb(pool, {
      users: pgProfileDb.FIELDS,
      sessions: pgAuthDb.SESSION_FIELDS,
      otp_sessions: pgAuthDb.OTP_FIELDS
    });
    return { db, close: () => pool.end(), drop: () => dropPgDatabase(dbName) };
  }
  const client = new MongoClient(mongoUrlFor(dbName), { auth: null });
  await client.connect();
  const db = client.db();
  await db.dropDatabase();
  return {
    db,
    close: async () => {
      await db.dropDatabase();
      await client.close();
    },
    drop: async () => { }
  };
}

/**
 * Boot profile-ms in process against the real mongo or postgres (`TEST_DB`)
 * and redis from `deployment/docker-compose.infra.yml`, with the mock SMS
 * sender and the in-memory event store. No socket is opened: drive it with
 * `inject`.
 * @param {string} dbName database name, unique per test file
 */
async function startProfileMs(dbName) {
  if (TEST_DB === 'pg') await freshPgDatabase(dbName);
  // Drop the test database before init creates the unique indexes used by atomic writes.
  const store = await openStore(dbName);
  const options = parseOptions([
    'node',
    'profile-ms',
    '--app-name=profile-ms-test',
    '--log-level=error',
    ...dbFlags(dbName, ['profile-db', 'auth-db']),
    '--auth-provider=self-hosted-otp',
    '--sms-sender=mock',
    // ponytail: in-process cache so parallel test files never share (or
    // flush) each other's rate counters; the Redis paths are exercised by
    // the conformance suite against the live stack.
    '--cache-type=local',
    '--event-store=memory',
    '--new-login-topic=new-login',
    '--new-message-topic=new-message',
    // no service is listening: `stubChannels` / `revokes` / `pushTopicDeletes` replace all three clients
    '--channel-ms-endpoint=http://channel-ms.invalid',
    '--gateway-endpoint=http://gateway.invalid',
    '--notification-ms-endpoint=http://notification-ms.invalid',
    // every injected request shares one remote address, so the per IP OTP budget
    // would be a cross test file limit. Per phone budgets stay at their defaults.
    '--otp-rate-ip-hour=100000'
  ]);
  const context = await initResource(options);
  const service = new ProfileMs(context);
  await service.init();
  await service.server.ready();

  const { db } = store;

  // rate limit counters outlive a test run (1h TTL), so drop the ones this
  // service writes. Pattern scoped, never a flushdb: a dev stack may share redis.
  const redis = context.memCache._redis;
  if (redis) {
    const found = await Promise.all(
      ['otp:rate:*', 'profile:rate:*', 'lookup:rate:*', 'uname:rate:*'].map((prefix) =>
        redis.keys(prefix)
      )
    );
    const keys = found.flat();
    if (keys.length) await redis.del(keys);
  }

  // Nothing answers the channel-ms / gateway / notification-ms endpoints in a
  // test, so the three http clients are replaced here: `channels` is what
  // channel-ms would list for whoever asks, `revokes` records the gateway's
  // internal revoke calls, `pushTopicDeletes` records notification-ms's.
  let channels = [];
  const revokes = [];
  const pushTopicDeletes = [];
  // trim 4: channel-ms lists groups only, so the stub filters on membership.
  service.channelClient.get = async (_path, request) =>
    channels.filter((channel) => channel.members.includes(request.headers['x-user']));
  service.gatewayClient.post = async (_path, payload) => {
    revokes.push(payload);
    return { status: true };
  };
  service.notificationClient.post = async (_path, payload) => {
    pushTopicDeletes.push(payload);
    return { status: true };
  };

  return {
    server: service,
    db,
    /** @type {import('../../services/profile-ms/auth-provider/sms-sender/mock-sms-sender')} */
    sms: context.smsSender,
    eventStore: context.eventStore,
    revokes,
    pushTopicDeletes,
    /**
     * Stand in for channel-ms's channel list.
     * @param {{channel_id: string, members: string[]}[]} rows channel-ms's view of each
     */
    stubChannels(rows) {
      channels = rows;
    },
    /**
     * @param {import('light-my-request').InjectOptions} request
     * @returns {Promise<import('light-my-request').Response>}
     */
    inject: (request) => service.server.inject(request),
    async stop() {
      await store.close();
      await context.memCache.dispose();
      await service.shutdown();
      await store.drop();
    }
  };
}

/**
 * Run the OTP flow for a phone and return the verify response body
 * @param {{inject: Function, sms: *}} harness
 * @param {{phone: string, deviceId?: string}} args
 */
async function signup(harness, { phone, deviceId = 'device-1' }) {
  const send = await harness.inject({
    method: 'POST',
    url: '/auth/otp/send',
    payload: { phone, deviceId }
  });
  const { sessionId } = JSON.parse(send.payload);
  const verify = await harness.inject({
    method: 'POST',
    url: '/auth/otp/verify',
    payload: { sessionId, code: harness.sms.lastCode(phone), deviceId }
  });
  return JSON.parse(verify.payload);
}

/**
 * Signup and complete the mandatory username pick step
 * @param {{inject: Function, sms: *}} harness
 * @param {{phone: string, username: string, deviceId?: string}} args
 */
async function signupWithUsername(harness, { phone, username, deviceId = 'device-1' }) {
  const session = await signup(harness, { phone, deviceId });
  await harness.inject({
    method: 'PATCH',
    url: '/users/me',
    headers: { authorization: `Bearer ${session.accesskey}` },
    payload: { username }
  });
  return session;
}

/**
 * `Authorization` header for an accesskey
 * @param {string} accesskey
 */
function bearer(accesskey) {
  return { authorization: `Bearer ${accesskey}` };
}

module.exports = {
  MONGO_URL,
  REDIS_ENDPOINT,
  startProfileMs,
  signup,
  signupWithUsername,
  bearer
};
