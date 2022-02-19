class LocalCache {
  _cache = {};

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
}

module.exports = {
  LocalCache
}
