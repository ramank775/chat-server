const { IMessageDB } = require('./message-db');
const mongodb = require('./mongo-message-db')

const DATABASE_IMPL = [
  mongodb
]

/**
 * Add command line options for database store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--message-db <message-db>', 'Which database implementation to use (mongo)', 'mongo');
  DATABASE_IMPL.forEach(impl => {
    cmd = impl.addOptions(cmd)
  })
  return cmd;
}

/**
 * @private
 * Get the database implementation as per the context options
 * @param {{options: {messageDb: string}}} context
 * @returns
 */
function getDatabaseImpl(context) {
  const {
    options: { messageDb }
  } = context;
  const store = DATABASE_IMPL.find((s) => s.code === messageDb);
  if (!store) {
    throw new Error(`${messageDb} is not a registered database implementation for Message database`);
  }
  return store;
}

/**
 * Initialize database
 * @returns 
 */
async function initialize(context) {
  const impl = getDatabaseImpl(context)
  const db = new impl.Implementation(context);
  await db.init();
  context.messageDb = db;
  return context;
}


module.exports = {
  IMessageDB,
  addDatabaseOptions: addOptions,
  initializeDatabase: initialize
}
