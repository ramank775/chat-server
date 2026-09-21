const { ISmsSender, otpMessage } = require('./sms-sender');

/**
 * Records every send instead of talking to a gateway. Dev and test default.
 */
class MockSmsSender extends ISmsSender {
  /** @type {{phone: string, code: string, at: Date}[]} */
  sends = [];

  #log;

  constructor(context) {
    super();
    this.#log = context.log;
  }

  async send({ phone, code }) {
    this.sends.push({ phone, code, at: new Date() });
    this.#log.debug(`[mock-sms] ${phone}: ${otpMessage(code)}`);
  }

  /**
   * Last code sent to a phone (tests and local dev)
   * @param {string} phone
   * @returns {string|undefined}
   */
  lastCode(phone) {
    for (let i = this.sends.length - 1; i >= 0; i -= 1) {
      if (this.sends[i].phone === phone) return this.sends[i].code;
    }
    return undefined;
  }
}

function addOptions(cmd) {
  return cmd;
}

module.exports = {
  code: 'mock',
  addOptions,
  Implementation: MockSmsSender
};
