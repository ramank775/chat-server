const { IAuthProvider } = require('./auth-provider');
const firebase = require('./firebase-auth-provider');
const mock = require('./mock-auth-provider');
const { addDatabaseOptions, initializeDatabase } = require('../database/auth');

const AUTH_PROVIDER_IMPL = [firebase, mock];

/**
 * Add command line options for database store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option(
    '--auth-provider <auth-provider>',
    'Which auth provider to use (firebase)',
    'firebase'
  );
  AUTH_PROVIDER_IMPL.forEach((impl) => {
    cmd = impl.addOptions(cmd);
  });
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
    options: { authProvider },
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
  const impl = getAuthProviderImpl(context);
  const provider = new impl.Implementation(context);
  await provider.init();
  context.authProvider = provider;
  return context;
}

module.exports = {
  IAuthProvider,
  addAuthProviderOptions: addOptions,
  initializeAuthProvider: initialize,
};
