const crypto = require('crypto');
const axios = require('axios');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 5000;

/**
 * Decision 209: Play builds get their wake as a native FCM message (HTTP v1
 * API): data only, high priority, nothing but `t: wake`. Authorised as the
 * Firebase project's service account with a self signed JWT, so no Google SDK.
 */
class FcmSender {
  #account;

  #http;

  #accessToken = null;

  #expiresAt = 0;

  /**
   * @param {string} base64Key the service account key file, base64 encoded
   * @param {string} [apiUrl] FCM's base url, a stub in tests
   */
  constructor(base64Key, apiUrl = 'https://fcm.googleapis.com') {
    let account;
    try {
      account = JSON.parse(Buffer.from(base64Key, 'base64').toString('utf8'));
    } catch (e) {
      account = {};
    }
    // eslint-disable-next-line camelcase
    const { project_id, client_email, private_key, token_uri } = account;
    // eslint-disable-next-line camelcase
    if (!project_id || !client_email || !private_key || !token_uri) {
      throw new Error('--fcm-service-account-key (FCM_SERVICE_ACCOUNT_KEY) is not a base64 service account key');
    }
    this.#account = account;
    this.#http = axios.create({ baseURL: apiUrl, timeout: TIMEOUT_MS, validateStatus: () => true });
  }

  async #token(refresh) {
    if (!refresh && this.#accessToken && Date.now() < this.#expiresAt) return this.#accessToken;
    const now = Math.floor(Date.now() / 1000);
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
      iss: this.#account.client_email,
      scope: SCOPE,
      aud: this.#account.token_uri,
      iat: now,
      exp: now + 3600
    })}`;
    const signature = crypto.sign('sha256', Buffer.from(unsigned), this.#account.private_key);
    let res;
    try {
      res = await axios.post(
        this.#account.token_uri,
        new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${unsigned}.${signature.toString('base64url')}`
        }).toString(),
        { headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeout: TIMEOUT_MS }
      );
    } catch (e) {
      // never the axios error itself: its config holds the signed assertion
      throw new Error(`FCM sign in failed: ${e.response ? e.response.status : e.code || e.message}`);
    }
    this.#accessToken = res.data.access_token;
    // a minute early, so a token never expires mid send
    this.#expiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
    return this.#accessToken;
  }

  /**
   * @param {string} token the device's FCM registration token
   * @returns {Promise<number>} FCM's status; 404 means the token is gone
   */
  async send(token, refresh = false) {
    const authorization = `Bearer ${await this.#token(refresh)}`;
    let res;
    try {
      res = await this.#http.post(
        `/v1/projects/${this.#account.project_id}/messages:send`,
        {
          message: {
            token,
            data: { t: 'wake' },
            android: { priority: 'HIGH', ttl: '86400s' }
          }
        },
        { headers: { authorization } }
      );
    } catch (e) {
      // never the axios error itself: its config holds the access token
      throw new Error(`FCM unreachable: ${e.code || e.message}`);
    }
    // an access token revoked or expired early: one fresh try
    if (res.status === 401 && !refresh) return this.send(token, true);
    return res.status;
  }
}

module.exports = { FcmSender };
