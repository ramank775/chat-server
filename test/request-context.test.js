const test = require('node:test');
const assert = require('node:assert');
const { HttpServiceBase, initHttpResource } = require('../libs/http-service-base');
const { initMemCache } = require('../libs/cache');
const { getRequestId } = require('../libs/request-context');

const noop = () => { };

/**
 * A bare http service with one route that reads the request id back after a
 * real redis round trip and after a timer callback. If the ALS store were
 * entered anywhere but around the whole lifecycle, one of the three reads
 * would come back undefined (or, worse, be another request's id).
 */
async function startService() {
  const context = await initHttpResource({
    options: {
      port: 0,
      host: '127.0.0.1',
      cacheType: 'redis',
      redisEndpoint: process.env.REDIS_ENDPOINT || 'localhost:6379'
    },
    log: { info: noop, error: noop, warn: noop, debug: noop },
    statsClient: { increment: noop, timing: noop }
  });
  await initMemCache(context);
  const service = new HttpServiceBase(context);
  await service.init();
  service.addRoute('/trace', 'GET', async () => {
    const onEntry = getRequestId();
    await context.memCache.incr(`als:${onEntry}`, 5);
    const afterCache = getRequestId();
    const afterTimer = await new Promise((resolve) => {
      setTimeout(() => resolve(getRequestId()), 10);
    });
    return { onEntry, afterCache, afterTimer };
  });
  await service.server.ready();
  return { service, context };
}

test('the request id survives a cache call and a nested timer', async (t) => {
  const { service, context } = await startService();
  t.after(async () => {
    await context.memCache.dispose();
    await service.shutdown();
  });

  const response = await service.server.inject({
    method: 'GET',
    url: '/trace',
    headers: { 'x-request-id': 'req-from-the-edge' }
  });
  assert.deepStrictEqual(response.json(), {
    onEntry: 'req-from-the-edge',
    afterCache: 'req-from-the-edge',
    afterTimer: 'req-from-the-edge'
  });
  assert.strictEqual(response.headers['x-request-id'], 'req-from-the-edge');
});

test('concurrent requests never see each other ids', async (t) => {
  const { service, context } = await startService();
  t.after(async () => {
    await context.memCache.dispose();
    await service.shutdown();
  });

  const trace = (id) =>
    service.server.inject({
      method: 'GET',
      url: '/trace',
      ...(id ? { headers: { 'x-request-id': id } } : {})
    });

  const [first, second] = await Promise.all([trace('first'), trace('second')]);
  assert.deepStrictEqual(first.json(), { onEntry: 'first', afterCache: 'first', afterTimer: 'first' });
  assert.deepStrictEqual(second.json(), {
    onEntry: 'second',
    afterCache: 'second',
    afterTimer: 'second'
  });

  // with no header the id is minted per request, so two are never the same
  const [a, b] = await Promise.all([trace(), trace()]);
  assert.ok(a.json().afterTimer);
  assert.notStrictEqual(a.json().afterTimer, b.json().afterTimer);
});
