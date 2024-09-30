const { IAuthDB } = require('./auth-db');
const mongodb = require('./mongo-auth-db');

const DATABASE_IMPL = [mongodb];

/**
 * Add command line options for database store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--auth-db <auth-db>', 'Which database implementation to use (mongo)', 'mongo');
  DATABASE_IMPL.forEach((impl) => {
    cmd = impl.addOptions(cmd);
  });
  return cmd;
}

/**
 * @private
 * Get the database implementation as per the context options
 * @param {{options: {authDb: string}}} context
 * @returns
 */
function getDatabaseImpl(context) {
  const {
    options: { authDb },
  } = context;
  const store = DATABASE_IMPL.find((s) => s.code === authDb);
  if (!store) {
    throw new Error(`${authDb} is not a registered database implementation for profile database`);
  }
  return store;
}

/**
 * Initialize database
 * @returns
 */
async function initialize(context) {
  const impl = getDatabaseImpl(context);
  const db = new impl.Implementation(context);
  await db.init();
  context.authDB = db;
  return context;
}

module.exports = {
  IAuthDB,
  addDatabaseOptions: addOptions,
  initializeDatabase: initialize,
};
