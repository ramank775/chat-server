const axios = require('axios');
const {
  ISmsSender,
  SmsGatewayError,
  SmsGatewayUnavailableError,
  otpMessage
} = require('./sms-sender');

/**
 * sms-gate.app (SMS Gateway for Android): basic auth, POST /3rdparty/v1/messages
 * with `{textMessage: {text}, phoneNumbers: []}`.
 * https://docs.sms-gate.app/integration/api/
 */
class SmsGateAppSender extends ISmsSender {
  #client;

  #log;

  constructor(context) {
    super();
    const { smsGateUrl, smsGateUser, smsGatePassword } = context.options;
    this.#log = context.log;
    this.#client = axios.create({
      baseURL: smsGateUrl,
      auth: { username: smsGateUser, password: smsGatePassword },
      timeout: 10000
    });
  }

  async send({ phone, code }) {
    try {
      await this.#client.post('/3rdparty/v1/messages', {
        textMessage: { text: otpMessage(code) },
        phoneNumbers: [phone]
      });
    } catch (error) {
      const status = error.response && error.response.status;
      this.#log.error(`sms-gate.app send failed (status ${status}): ${error.message}`);
      // 4xx is the gateway authoritatively refusing; anything else is retry eligible
      if (status && status >= 400 && status < 500) {
        throw new SmsGatewayError(`sms-gate.app rejected the message (${status})`);
      }
      throw new SmsGatewayUnavailableError(`sms-gate.app unreachable: ${error.message}`);
    }
  }
}

function addOptions(cmd) {
  return cmd
    .option('--sms-gate-url <sms-gate-url>', 'sms-gate.app base url', 'https://api.sms-gate.app')
    .option('--sms-gate-user <sms-gate-user>', 'sms-gate.app basic auth username')
    .option('--sms-gate-password <sms-gate-password>', 'sms-gate.app basic auth password');
}

module.exports = {
  code: 'sms-gate-app',
  addOptions,
  Implementation: SmsGateAppSender
};
