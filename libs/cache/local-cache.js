/**
 * In-process cache. Single-threaded, so every method below is atomic by
 * construction — the Redis implementation buys the same guarantee with Lua.
 */
class LocalCache {
  _cache = {};

  _counters = {};

  /** @type {Map<string, {map: Map<string,string>, order: string[], expiry: number}>} */
  _dedup = new Map();

  /** @type {Map<string, {tokens: number, ts: number}>} */
  _buckets = new Map();

  async get(key) {
    return this._cache[key];
  }

  async getAll(keys) {
    return keys.map((key) => this._cache[key]);
  }

  async set(key, value) {
    this._cache[key] = value;
  }

  async del(key) {
    delete this._cache[key];
  }

  /**
   * Increment a counter. With `expireInSec` it expires that many seconds
   * after its first increment (fixed window); without it, never.
   * ponytail: per process, so limits multiply by the number of replicas. Use the
   * redis cache for anything horizontally scaled (AUTH_CONTRACT 10.1).
   * @param {string} key
   * @param {number} [expireInSec]
   * @returns {Promise<number>} counter value after the increment
   */
  async incr(key, expireInSec) {
    const now = Date.now();
    const entry = this._counters[key];
    if (!entry || entry.expiresAt <= now) {
      this._counters[key] = {
        count: 1,
        expiresAt: expireInSec ? now + expireInSec * 1000 : Infinity,
      };
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  // eslint-disable-next-line class-methods-use-this, no-empty-function
  async dispose() {}

  /**
   * Atomic "next in sequence" compare-and-set: succeeds only when `expected`
   * is exactly one past the stored value (so the first op on a resource is 1).
   * A failed compare never advances the counter.
   */
  async casNext(key, expected, _ttlSec) {
    const current = Number(this._cache[key]) || 0;
    if (expected !== current + 1) return false;
    this._cache[key] = expected;
    return true;
  }

  async dedupGet(key, field) {
    const entry = this._dedup.get(key);
    if (!entry || entry.expiry <= Date.now()) return null;
    return entry.map.get(field) ?? null;
  }

  async dedupPut(key, field, value, cap, ttlSec) {
    let entry = this._dedup.get(key);
    if (!entry || entry.expiry <= Date.now()) {
      entry = { map: new Map(), order: [], expiry: 0 };
      this._dedup.set(key, entry);
    }
    if (!entry.map.has(field)) entry.order.push(field);
    entry.map.set(field, value);
    while (entry.order.length > cap) {
      entry.map.delete(entry.order.shift());
    }
    entry.expiry = Date.now() + ttlSec * 1000;
  }

  /**
   * Token bucket. Returns 0 when a token was taken, else the ms to wait
   * before one is available.
   */
  async takeToken(key, capacity, refillPerSec) {
    const now = Date.now();
    const bucket = this._buckets.get(key) || { tokens: capacity, ts: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.ts) * refillPerSec) / 1000);
    bucket.ts = now;
    this._buckets.set(key, bucket);
    if (bucket.tokens < 1) {
      return Math.ceil(((1 - bucket.tokens) * 1000) / refillPerSec);
    }
    bucket.tokens -= 1;
    return 0;
  }
}

module.exports = {
  LocalCache
}
