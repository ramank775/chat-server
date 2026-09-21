/* eslint-disable max-classes-per-file */
/* eslint-disable class-methods-use-this */

/**
 * @abstract
 * Pluggable SMS gateway (AUTH_CONTRACT 12)
 */
class ISmsSender {
  /**
   * Send an OTP code
   * @param {{phone: string, code: string}} _args
   * @returns {Promise<void>}
   * @throws {SmsGatewayError} unrecoverable (bad number, no credits) -> 502
   * @throws {SmsGatewayUnavailableError} transient (network, gateway 5xx) -> 503
   */
  // eslint-disable-next-line no-unused-vars
  async send(_args) {
    throw new Error('Method not implemented');
  }

  /* eslint-disable-next-line no-empty-function */
  async init() {}

  /* eslint-disable-next-line no-empty-function */
  async dispose() {}
}

class SmsGatewayError extends Error {
  code = 'SMS_GATEWAY_ERROR';
}

class SmsGatewayUnavailableError extends Error {
  code = 'SMS_GATEWAY_UNAVAILABLE';
}

/**
 * AUTH_CONTRACT 12 message template, kept under 160 chars (one SMS segment)
 * @param {string} code
 * @returns {string}
 */
function otpMessage(code) {
  return `Your Vartalap code is ${code}. Expires in 10 minutes. Do not share.`;
}

module.exports = {
  ISmsSender,
  SmsGatewayError,
  SmsGatewayUnavailableError,
  otpMessage
};
