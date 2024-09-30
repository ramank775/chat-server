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
    this._redis = new Redis(options.redisEndpoint);
  }

  async get(key) {
    return await this._redis.get(key);
  }

  async getAll(keys) {
    return await this._redis.mget(keys);
  }

  async set(key, value) {
    await this._redis.set(key, value);
  }

  async del(key) {
    await this._redis.del(key);
  }
}

module.exports = {
  RedisCache,
};
