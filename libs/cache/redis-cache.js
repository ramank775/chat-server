const Redis = require('ioredis');

class RedisCache {
  /**
   * @type {Redis.Redis}
   */
  _redis;

  /**
   * Create redis cache instance
   * @param {{redisEndpoint: string}} options 
   */
  constructor(options) {
    this._redis = new Redis(options.redisEndpoint)
    this._defineCommands();
  }

  _defineCommands() {
    // Strictly-next compare-and-set (SYNC_PROTOCOL.md §6): only advances
    // when the incoming value is exactly stored + 1.
    this._redis.defineCommand('v3CasNext', {
      numberOfKeys: 1,
      lua: `
        local current = tonumber(redis.call('GET', KEYS[1]) or '0')
        local want = tonumber(ARGV[1])
        if want ~= current + 1 then return 0 end
        redis.call('SET', KEYS[1], want, 'EX', ARGV[2])
        return 1`
    });

    // Dedup window (§7.1): hash of op_id -> outcome plus a FIFO list that
    // caps it. ponytail: the 7-day TTL is rolled on the whole key rather
    // than per entry; per-entry expiry needs a ZSET sweep, add it if the
    // 10k cap stops being the binding constraint.
    this._redis.defineCommand('v3DedupPut', {
      numberOfKeys: 2,
      lua: `
        if redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) == 1 then
          redis.call('RPUSH', KEYS[2], ARGV[1])
          if redis.call('LLEN', KEYS[2]) > tonumber(ARGV[3]) then
            local evicted = redis.call('LPOP', KEYS[2])
            if evicted then redis.call('HDEL', KEYS[1], evicted) end
          end
        end
        redis.call('EXPIRE', KEYS[1], ARGV[4])
        redis.call('EXPIRE', KEYS[2], ARGV[4])
        return 1`
    });

    // Token bucket (§14). Returns 0 when a token was taken, else the ms to
    // wait before the next one refills.
    this._redis.defineCommand('v3TakeToken', {
      numberOfKeys: 1,
      lua: `
        local capacity = tonumber(ARGV[1])
        local rate = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
        local tokens = tonumber(state[1])
        local ts = tonumber(state[2])
        if tokens == nil or ts == nil then tokens = capacity; ts = now end
        tokens = math.min(capacity, tokens + (now - ts) * rate / 1000)
        local wait = 0
        if tokens < 1 then
          wait = math.ceil((1 - tokens) * 1000 / rate)
        else
          tokens = tokens - 1
        end
        redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
        redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / rate) + 1000)
        return wait`
    });
  }

  async get(key) {
    return await this._redis.get(key)
  }

  async getAll(keys) {
    return await this._redis.mget(keys);
  }

  async set(key, value) {
    await this._redis.set(key, value);
  }

  async del(key) {
    await this._redis.del(key)
  }

  /**
   * Increment a counter. With `expireInSec` it expires that many seconds
   * after its first increment.
   * ponytail: fixed window, so a burst can straddle two windows and pass 2x the
   * limit. Move to a sorted set (sliding window) if that matters.
   * @param {string} key
   * @param {number} [expireInSec]
   * @returns {Promise<number>} counter value after the increment
   */
  async incr(key, expireInSec) {
    const count = await this._redis.incr(key);
    if (expireInSec && count === 1) {
      await this._redis.expire(key, expireInSec);
    }
    return count;
  }

  async dispose() {
    await this._redis.quit();
  }

  async casNext(key, expected, ttlSec) {
    const ok = await this._redis.v3CasNext(key, expected, ttlSec);
    return ok === 1;
  }

  async dedupGet(key, field) {
    return await this._redis.hget(key, field);
  }

  async dedupPut(key, field, value, cap, ttlSec) {
    await this._redis.v3DedupPut(key, `${key}:fifo`, field, value, cap, ttlSec);
  }

  async takeToken(key, capacity, refillPerSec) {
    return await this._redis.v3TakeToken(key, capacity, refillPerSec, Date.now());
  }
}

module.exports = {
  RedisCache
}
