const Redis = require('ioredis');

class LocalCache {
  _cache = {};
  async get(key) {
    return this._cache[key];
  }

  async set(key, value) {
    this._cache[key] = value;
  }

  async del(key) {
    delete this._cache[key];
  }
}

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

  async set(key, value) {
    await this._redis.set(key, value);
  }

  async del(key) {
    await this._redis.del(key)
  }

}

function addMemCacheOptions(cmd) {
  cmd = cmd
    .option('--cache-type <cache-type>', 'Type of cache service (local, redis)', 'local')
    .option('--redis-endpoint <redis-endpoint>', 'Redis endpoint to connet with in case of cache type redis', '127.0.0.1:6379')
  return cmd;
}

async function initMemCache(context) {
  const { cacheType } = context.options;
  let memCache;
  switch (cacheType) {
    case 'local':
      memCache = new LocalCache();
      break;
    case 'redis':
      memCache = new RedisCache(context.options)
      break;
    default:
      memCache = new LocalCache();
      break;
  }
  context.memCache = memCache;
  return context;
}

module.exports = {
  addMemCacheOptions,
  initMemCache
}
