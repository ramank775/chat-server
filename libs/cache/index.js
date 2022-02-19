const { LocalCache } = require('./local-cache');
const { RedisCache } = require('./redis-cache');

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
