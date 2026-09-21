const { Redis } = require('ioredis');
const { decodeWsEnvelope } = require('../v3-envelope');

/** SYNC_PROTOCOL.md §19 decisions 1-2: 30 days, 10,000 frames, drop-oldest. */
const MAX_FRAMES = 10000;
const TTL_SEC = 30 * 24 * 60 * 60;

/** One list per user; the drain deletes it. */
const queueKey = (userId) => `sync:pending:${userId}`;

/**
 * SYNC_PROTOCOL.md §10.4 / §10.6 — frames go out in `delivery_sequence`
 * order per channel. `delivery_sequence` is minted per channel
 * (`dseq:<channel_id>` in the gateway), so channels cannot be compared;
 * each channel keeps the position of its first queued frame instead.
 * @param {Buffer[]} frames
 */
function orderPerChannel(frames) {
  const channelOrder = new Map();
  const keyed = frames.map((frame, arrival) => {
    let channelId = '';
    let sequence = 0;
    try {
      const { push } = decodeWsEnvelope(frame);
      channelId = push.channelId || '';
      sequence = Number(push.deliverySequence) || 0;
    } catch (e) {
      // Undecodable frame: leave it where it arrived rather than drop it.
    }
    if (!channelOrder.has(channelId)) channelOrder.set(channelId, channelOrder.size);
    return { frame, group: channelOrder.get(channelId), sequence, arrival };
  });
  keyed.sort((a, b) => a.group - b.group || a.sequence - b.sequence || a.arrival - b.arrival);
  return keyed.map((entry) => entry.frame);
}

/**
 * The undelivered queue of SYNC_PROTOCOL.md §10.6: `toPushFrame()` bytes
 * held for a user whose sockets were all closed, drained in one shot by
 * `GET /v3.0/sync/pending`.
 *
 * Written by message-delivery, read by message-ms. The cache lib has no
 * list primitive, so this talks to ioredis directly.
 * ponytail: without a redis client it keeps the queue in process — enough
 * for tests and a single-node dev run, useless the moment there are two
 * replicas. Pass a client for anything real.
 */
class UndeliveredQueue {
  /** @type {Map<string, Buffer[]>} */
  _local = new Map();

  constructor({ redis = null, maxFrames = MAX_FRAMES, ttlSec = TTL_SEC } = {}) {
    this._redis = redis;
    this._maxFrames = maxFrames;
    this._ttlSec = ttlSec;
  }

  /**
   * Append one push frame for `userId`, dropping the oldest past the cap and
   * rolling the TTL forward.
   * @param {string} userId
   * @param {Buffer} frame serialized WsEnvelope{type: WS_PUSH}
   */
  async enqueue(userId, frame) {
    if (!this._redis) {
      const frames = this._local.get(userId) || [];
      frames.push(frame);
      this._local.set(userId, frames.slice(-this._maxFrames));
      return;
    }
    await this._redis
      .multi()
      .rpush(queueKey(userId), frame)
      .ltrim(queueKey(userId), -this._maxFrames, -1)
      .expire(queueKey(userId), this._ttlSec)
      .exec();
  }

  /**
   * Hand back everything queued for `userId` and clear it — at-most-once by
   * design (§10.6 drain semantics).
   * @param {string} userId
   * @returns {Promise<Buffer[]>}
   */
  async drain(userId) {
    if (!this._redis) {
      const frames = this._local.get(userId) || [];
      this._local.delete(userId);
      return orderPerChannel(frames);
    }
    const replies = await this._redis
      .multi()
      .lrangeBuffer(queueKey(userId), 0, -1)
      .del(queueKey(userId))
      .exec();
    const [error, frames] = replies[0];
    if (error) throw error;
    return orderPerChannel(frames || []);
  }

  async dispose() {
    if (this._redis) await this._redis.quit();
  }
}

function addOptions(cmd) {
  return cmd
    .option('--cache-type <cache-type>', 'Type of cache service (local, redis)', 'local')
    .option(
      '--redis-endpoint <redis-endpoint>',
      'Redis endpoint to connet with in case of cache type redis',
      '127.0.0.1:6379'
    );
}

async function init(context) {
  const { cacheType, redisEndpoint } = context.options;
  context.undeliveredQueue = new UndeliveredQueue({
    redis: cacheType === 'redis' ? new Redis(redisEndpoint) : null
  });
  return context;
}

module.exports = {
  UndeliveredQueue,
  MAX_FRAMES,
  TTL_SEC,
  addOptions,
  init
};
