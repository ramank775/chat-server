const { IChannelDB } = require('./channel-db');
const mongodb = require('./mongo-channel-db')

const DATABASE_IMPL = [
  mongodb
]

/**
 * Add command line options for database store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--channel-db <channel-db>', 'Which database implementation to use (mongo)', 'mongo');
  DATABASE_IMPL.forEach(impl => {
    cmd = impl.addOptions(cmd)
  })
  return cmd;
}

/**
 * @private
 * Get the database implementation as per the context options
 * @param {{options: {channelDb: string}}} context
 * @returns
 */
function getDatabaseImpl(context) {
  const {
    options: { channelDb }
  } = context;
  const store = DATABASE_IMPL.find((s) => s.code === channelDb);
  if (!store) {
    throw new Error(`${channelDb} is not a registered database implementation for Channel database`);
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
  context.channelDb = db;
  return context;
}


module.exports = {
  IChannelDB,
  addDatabaseOptions: addOptions,
  initializeDatabase: initialize
}
