class LocalCache {
  _cache = {};

  _counters = {};

  async get(key) {
    return this._cache[key];
  }

  async getAll(keys) {
    const values = keys.map(key => values.push(this._cache[key]));
  }

  async set(key, value) {
    this._cache[key] = value;
  }

  async del(key) {
    delete this._cache[key];
  }

  /**
   * Increment a counter, expiring it `expireInSec` after its first increment.
   * ponytail: per process, so limits multiply by the number of replicas. Use the
   * redis cache for anything horizontally scaled (AUTH_CONTRACT 10.1).
   * @param {string} key
   * @param {number} expireInSec
   * @returns {Promise<number>} counter value after the increment
   */
  async incr(key, expireInSec) {
    const now = Date.now();
    const entry = this._counters[key];
    if (!entry || entry.expiresAt <= now) {
      this._counters[key] = { count: 1, expiresAt: now + expireInSec * 1000 };
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  // eslint-disable-next-line class-methods-use-this, no-empty-function
  async dispose() {}
}

module.exports = {
  LocalCache
}
