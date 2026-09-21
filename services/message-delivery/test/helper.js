const { DeliveryManager } = require('../../../libs/delivery-manager');
const { UndeliveredQueue } = require('../../../libs/delivery-manager/undelivered-queue');
const { EnvelopeEvent } = require('../../../libs/v3-envelope');
const { MessageDeliveryWorker } = require('../message-delivery-worker');

const OFFLINE_TOPIC = 'offline-message';

/** Just enough ioredis for DeliveryManager's routing table and pubsub. */
class FakeRedis {
  _kv = new Map();

  published = [];

  async mget(keys) { return keys.map((key) => this._kv.get(key) ?? null); }

  async get(key) { return this._kv.get(key) ?? null; }

  async set(key, value) { this._kv.set(key, String(value)); }

  async del(key) { this._kv.delete(key); }

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
  deliverySequence = 1,
  ephemeral = false,
  payload = Buffer.from('chat'),
  recipients = []
} = {}) {
  return EnvelopeEvent.of(
    {
      opId,
      channelId,
      resourceSeq: 1,
      payload,
      ephemeral,
      senderUserId,
      serverTimestampMs: 1700000000000,
      deliverySequence
    },
    recipients
  );
}

/**
 * Wire up the real worker over a fake redis, a stub event store and a stub
 * channel-ms. `members` maps channel_id -> user_ids.
 */
function startWorker({ members = new Map(), maxFrames } = {}) {
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
    undeliveredQueue: new UndeliveredQueue({ redis: null, maxFrames })
  };
  const worker = new MessageDeliveryWorker(context);
  worker.init();
  return {
    worker,
    redis,
    emitted,
    queue: context.undeliveredQueue,
    /** Park `userId` on a live gateway so delivery-manager routes to it. */
    async online(userId, gateway = 'gateway-1') {
      await redis.set(userId, gateway);
      await redis.set(`gateway:${gateway}:health`, 1);
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

module.exports = { FakeRedis, envelopeEvent, startWorker, settle, eachSeries, OFFLINE_TOPIC };
