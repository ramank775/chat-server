const { IAuthProvider, AuthError } = require('./auth-provider');
const selfHostedOtp = require('./self-hosted-otp-auth-provider');
const { addDatabaseOptions, initializeDatabase } = require('../database/auth');
const { addSmsSenderOptions, initializeSmsSender } = require('./sms-sender');

const AUTH_PROVIDER_IMPL = [selfHostedOtp];

/**
 * Add command line options for auth provider
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option(
    '--auth-provider <auth-provider>',
    'Which auth provider to use (self-hosted-otp)',
    'self-hosted-otp'
  );
  AUTH_PROVIDER_IMPL.forEach((impl) => {
    cmd = impl.addOptions(cmd);
  });
  cmd = addSmsSenderOptions(cmd);
  cmd = addDatabaseOptions(cmd);
  return cmd;
}

/**
 * @private
 * Get the auth provider implementation as per the context options
 * @param {{options: {authProvider: string}}} context
 * @returns
 */
function getAuthProviderImpl(context) {
  const {
    options: { authProvider }
  } = context;
  const store = AUTH_PROVIDER_IMPL.find((s) => s.code === authProvider);
  if (!store) {
    throw new Error(`${authProvider} is not a registered implementation for Auth provider`);
  }
  return store;
}

/**
 * Initialize Auth provider
 * @returns
 */
async function initialize(context) {
  await initializeDatabase(context);
  context.smsSender = context.smsSender || (await initializeSmsSender(context));
  const impl = getAuthProviderImpl(context);
  const provider = new impl.Implementation(context);
  await provider.init();
  context.authProvider = provider;
  return context;
}

module.exports = {
  IAuthProvider,
  AuthError,
  addAuthProviderOptions: addOptions,
  initializeAuthProvider: initialize
};
