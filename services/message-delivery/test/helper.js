const { MongoClient } = require('mongodb');
const { DeliveryManager } = require('../../../libs/delivery-manager');
const { UndeliveredQueue, COLLECTION } = require('../../../libs/delivery-manager/undelivered-queue');
const { PgUndeliveredQueue } = require('../../../libs/delivery-manager/pg-undelivered-queue');
const { EnvelopeEvent } = require('../../../libs/v3-envelope');
const { MessageDeliveryWorker } = require('../message-delivery-worker');
const { initPgPool } = require('../../../libs/pg-utils');
const {
  TEST_DB,
  mongoUrlFor,
  pgUrlFor,
  freshPgDatabase,
  dropPgDatabase
} = require('../../../test/helpers/db');

const OFFLINE_TOPIC = 'offline-message';

/**
 * One mongo client or pg pool per database for the whole file (a database per
 * test file: files run side by side); `closeQueues` in an `after` drops them.
 */
const clients = new Map();

/**
 * An empty undelivered queue on the real mongo or postgres (`TEST_DB`) from
 * `deployment/docker-compose.infra.yml`.
 * @param {string} dbName unique per test file
 */
async function emptyQueue(dbName) {
  if (TEST_DB === 'pg') {
    if (!clients.has(dbName)) {
      await freshPgDatabase(dbName);
      // `initPgPool`'s pool ends once however often it is ended, like the service's
      clients.set(dbName, initPgPool({ options: { pgUrl: pgUrlFor(dbName) } }));
    }
    const pool = clients.get(dbName);
    const queue = new PgUndeliveredQueue({ pool });
    await queue.init();
    await pool.query('TRUNCATE undelivered');
    return queue;
  }
  if (!clients.has(dbName)) {
    clients.set(dbName, new MongoClient(mongoUrlFor(dbName), { auth: null }));
  }
  const client = clients.get(dbName);
  await client.db().collection(COLLECTION).deleteMany({});
  const queue = new UndeliveredQueue({ client });
  await queue.createIndexes();
  return queue;
}

/** The queue in `dbName` on a connection of its own, as after a restart. */
function reopenQueue(dbName) {
  return TEST_DB === 'pg'
    ? new PgUndeliveredQueue({ pool: initPgPool({ options: { pgUrl: pgUrlFor(dbName) } }) })
    : new UndeliveredQueue({ client: new MongoClient(mongoUrlFor(dbName), { auth: null }) });
}

async function closeQueues() {
  await Promise.all([...clients].map(async ([dbName, client]) => {
    if (TEST_DB === 'pg') {
      await client.end();
      await dropPgDatabase(dbName);
      return;
    }
    await client.db().dropDatabase();
    await client.close();
  }));
  clients.clear();
}

/** Just enough ioredis for DeliveryManager's routing table and pubsub. */
class FakeRedis {
  _kv = new Map();

  _sets = new Map();

  published = [];

  async mget(keys) { return keys.map((key) => this._kv.get(key) ?? null); }

  async get(key) { return this._kv.get(key) ?? null; }

  async set(key, value) { this._kv.set(key, String(value)); }

  async del(key) { this._kv.delete(key); }

  async sadd(key, value) {
    if (!this._sets.has(key)) this._sets.set(key, new Set());
    this._sets.get(key).add(value);
  }

  async smembers(key) { return [...(this._sets.get(key) || [])]; }

  /* eslint-disable-next-line class-methods-use-this, no-empty-function */
  async expire() { }

  async publish(channel, payload) { this.published.push({ channel, payload }); }
}

/**
 * A server-stamped fanout envelope. `recipients` non-empty marks it
 * server-authored (§10.2), which must bypass the membership lookup.
 */
function envelopeEvent({
  opId = 'op-1',
  channelId = 'channel-1',
  senderUserId = '00000000a',
  senderDevice = 'device-1',
  ephemeral = false,
  payload = Buffer.from('chat'),
  recipients = [],
  serverTimestampMs = 1700000000000
} = {}) {
  return EnvelopeEvent.of(
    {
      opId,
      channelId,
      payload,
      ephemeral,
      senderUserId,
      serverTimestampMs
    },
    recipients,
    senderDevice
  );
}

const DB = 'message-delivery-test';

/**
 * Wire up the real worker over a fake redis, a stub event store, a stub
 * channel-ms and an empty queue. `members` maps channel_id -> user_ids.
 */
async function startWorker({ members = new Map() } = {}) {
  const redis = new FakeRedis();
  const emitted = [];
  const context = {
    options: { messageMaxRetries: 3 },
    log: { info() { }, error() { } },
    statsClient: { increment() { }, decrement() { }, gauge() { }, timing() { } },
    events: { 'new-message': 'new-message', 'offline-event': OFFLINE_TOPIC },
    eventStore: {
      emit: async (topic, args, key) => { emitted.push({ topic, args, key }); },
      dispose: async () => { }
    },
    channelServiceClient: {
      members: async (channelId) => new Set(members.get(channelId) || [])
    },
    deliveryManager: new DeliveryManager({ redis, serverId: 'message-delivery', maxRetry: 3 }),
    undeliveredQueue: await emptyQueue(DB)
  };
  const worker = new MessageDeliveryWorker(context);
  worker.init();
  const manager = context.deliveryManager;
  return {
    worker,
    redis,
    emitted,
    queue: context.undeliveredQueue,
    /** Park a device on a live gateway so delivery-manager routes to it. */
    async online(userId, deviceId = 'device-1', gateway = 'gateway-1') {
      await manager.userJoin(userId, deviceId);
      await redis.set(`route:${userId}:${deviceId}`, gateway);
      await redis.set(`gateway:${gateway}:health`, 1);
    },
    /** A device the registry knows but whose socket is closed. */
    async offline(userId, deviceId = 'device-1') {
      await manager.userJoin(userId, deviceId);
      await manager.userLeft(userId, deviceId);
    },
    wakeEvents() { return emitted.filter((e) => e.topic === OFFLINE_TOPIC); }
  };
}

/** delivery-manager publishes from an un-awaited forEach; let it land. */
const settle = () => new Promise(setImmediate);

/** Run `fn` over `items` strictly one at a time — arrival order is under test. */
const eachSeries = (items, fn) => items.reduce(
  (previous, item) => previous.then(() => fn(item)),
  Promise.resolve()
);

module.exports = {
  FakeRedis,
  envelopeEvent,
  startWorker,
  settle,
  eachSeries,
  OFFLINE_TOPIC,
  DB,
  mongoUrlFor,
  emptyQueue,
  reopenQueue,
  closeQueues
};
