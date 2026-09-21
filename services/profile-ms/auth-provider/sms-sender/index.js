const { ISmsSender, SmsGatewayError, SmsGatewayUnavailableError } = require('./sms-sender');
const mock = require('./mock-sms-sender');
const smsGateApp = require('./sms-gate-app-sms-sender');

const SMS_SENDER_IMPL = [mock, smsGateApp];

/**
 * Add command line options for sms sender
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--sms-sender <sms-sender>', 'Which sms sender to use (mock, sms-gate-app)', 'mock');
  SMS_SENDER_IMPL.forEach((impl) => {
    cmd = impl.addOptions(cmd);
  });
  return cmd;
}

/**
 * Initialize the sms sender
 * @param {{options: {smsSender: string}}} context
 * @returns {Promise<ISmsSender>}
 */
async function initialize(context) {
  const {
    options: { smsSender }
  } = context;
  const impl = SMS_SENDER_IMPL.find((s) => s.code === smsSender);
  if (!impl) {
    throw new Error(`${smsSender} is not a registered sms sender`);
  }
  const sender = new impl.Implementation(context);
  await sender.init();
  return sender;
}

module.exports = {
  ISmsSender,
  SmsGatewayError,
  SmsGatewayUnavailableError,
  addSmsSenderOptions: addOptions,
  initializeSmsSender: initialize
};
