const axios = require('axios');

class HttpClient {
  constructor(baseUrl) {
    this._client = axios.create({
      baseUrl,
    });
  }

  async get(path, options) {
    const response = await this._client.get(path, options)
    return response.data;
  }

  async post(path, payload, options) {
    const response = await this._client.post(path, payload, options)
    return response.data;
  }

  async put(path, payload, options) {
    const response = await this._client.put(path, payload, options)
    return response.data;
  }

  async delete(path, payload, options) {
    const response = await this._client.delete(path, payload, options);
    return response.data;
  }
}

module.exports = {
  HttpClient
}
