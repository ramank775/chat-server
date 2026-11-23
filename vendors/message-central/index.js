/* eslint-disable max-classes-per-file */
/**
 * Message Central VerifyNow: OTPs it makes, texts and checks itself, from
 * its own approved sender and template (India: no DLT registration of ours).
 * https://www.messagecentral.com/product/verify-now/api
 * No dependencies: Node's fetch.
 */

/** The response codes VerifyNow documents, in the body's `responseCode`. */
const RESPONSE = {
  SUCCESS: 200,
  BAD_REQUEST: 400,
  DUPLICATE_RESOURCE: 409,
  SERVER_ERROR: 500,
  INVALID_CUSTOMER_ID: 501,
  INVALID_VERIFICATION_ID: 505,
  REQUEST_ALREADY_EXISTS: 506,
  INVALID_COUNTRY_CODE: 511,
  VERIFICATION_FAILED: 700,
  WRONG_OTP_PROVIDED: 702,
  ALREADY_VERIFIED: 703,
  VERIFICATION_EXPIRED: 705,
  MAXIMUM_LIMIT_REACHED: 800
};

class VerifyNowError extends Error {
  /**
   * @param {string} message never carries a url: the token request has the password in it
   * @param {{responseCode?: number, transient?: boolean}} info transient = network or server side
   */
  constructor(message, { responseCode, transient = false } = {}) {
    super(message);
    this.responseCode = responseCode;
    this.transient = transient;
  }
}

class VerifyNowClient {
  #baseUrl;

  #customerId;

  #key;

  #email;

  #country;

  #timeoutMs;

  #token = null;

  /**
   * @param {{customerId: string, password: string, email?: string, country?: string,
   *   baseUrl?: string, timeoutMs?: number}} options
   */
  constructor({
    customerId,
    password,
    email = '',
    country = '91',
    baseUrl = 'https://cpaas.messagecentral.com',
    timeoutMs = 10000
  }) {
    if (!customerId || !password) {
      throw new Error('VerifyNow needs a customer id and the account password');
    }
    this.#customerId = customerId;
    this.#key = Buffer.from(password).toString('base64');
    this.#email = email;
    this.#country = country;
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Text a new code to the number.
   * @param {{countryCode: string, mobileNumber: string, otpLength?: number, flowType?: string}} args
   * @returns {Promise<{verificationId: string, timeoutSec: number | null}>}
   * @throws {VerifyNowError}
   */
  async sendOtp({ countryCode, mobileNumber, otpLength = 6, flowType = 'SMS' }) {
    const { responseCode, body } = await this.#call('POST', '/verification/v3/send', {
      countryCode,
      customerId: this.#customerId,
      flowType,
      mobileNumber,
      otpLength
    });
    const data = body.data || {};
    if (responseCode !== RESPONSE.SUCCESS || !data.verificationId) {
      throw new VerifyNowError(`send refused: ${responseCode} ${body.message || ''}`.trim(), {
        responseCode,
        transient: responseCode === RESPONSE.SERVER_ERROR
      });
    }
    return { verificationId: String(data.verificationId), timeoutSec: Number(data.timeout) || null };
  }

  /**
   * Check a code against a send.
   * @param {{verificationId: string, code: string}} args
   * @returns {Promise<number>} a RESPONSE code: SUCCESS only when the code is right
   * @throws {VerifyNowError} the check itself failed
   */
  async validateOtp({ verificationId, code }) {
    const { responseCode, body } = await this.#call('GET', '/verification/v3/validateOtp', {
      verificationId,
      code
    });
    if (responseCode === RESPONSE.SERVER_ERROR) {
      throw new VerifyNowError('validate failed: 500', { responseCode, transient: true });
    }
    if (responseCode === RESPONSE.SUCCESS) {
      const status = body.data && body.data.verificationStatus;
      return status === 'VERIFICATION_COMPLETED' ? RESPONSE.SUCCESS : RESPONSE.VERIFICATION_FAILED;
    }
    return responseCode;
  }

  /** An authorised call; a 401 fetches a fresh token once. */
  async #call(method, path, params, retried = false) {
    if (!this.#token) this.#token = await this.#fetchToken();
    const reply = await this.#request(method, path, params, { authToken: this.#token });
    if (reply.status === 401 && !retried) {
      this.#token = null;
      return this.#call(method, path, params, true);
    }
    return reply;
  }

  async #fetchToken() {
    const { status, body } = await this.#request('GET', '/auth/v1/authentication/token', {
      customerId: this.#customerId,
      key: this.#key,
      scope: 'NEW',
      country: this.#country,
      email: this.#email
    });
    if (!body.token) {
      throw new VerifyNowError(`token refused (HTTP ${status})`, { responseCode: status });
    }
    return body.token;
  }

  async #request(method, path, params, headers = {}) {
    const url = new URL(path, this.#baseUrl);
    Object.entries(params).forEach(([name, value]) => {
      if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
    });
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { accept: '*/*', ...headers },
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
    } catch (error) {
      throw new VerifyNowError(`unreachable: ${error.message}`, { transient: true });
    }
    if (res.status >= 500) {
      throw new VerifyNowError(`HTTP ${res.status}`, { responseCode: res.status, transient: true });
    }
    const body = await res.json().catch(() => ({}));
    const responseCode = Number((body.data && body.data.responseCode) || body.responseCode || res.status);
    return { status: res.status, responseCode, body };
  }
}

module.exports = { VerifyNowClient, VerifyNowError, RESPONSE };
