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
   * Increment a counter, expiring it `expireInSec` after its first increment.
   * ponytail: fixed window, so a burst can straddle two windows and pass 2x the
   * limit. Move to a sorted set (sliding window) if that matters.
   * @param {string} key
   * @param {number} expireInSec
   * @returns {Promise<number>} counter value after the increment
   */
  async incr(key, expireInSec) {
    const count = await this._redis.incr(key);
    if (count === 1) {
      await this._redis.expire(key, expireInSec);
    }
    return count;
  }

  async dispose() {
    await this._redis.quit();
  }
}

module.exports = {
  RedisCache
}
