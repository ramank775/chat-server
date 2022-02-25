const { INotificationDB } = require('./notification-db');
const mongodb = require('./mongo-notification-db')

const DATABASE_IMPL = [
  mongodb
]

/**
 * Add command line options for database store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--notification-db <profile-db>', 'Which database implementation to use (mongo)', 'mongo');
  DATABASE_IMPL.forEach(impl => {
    cmd = impl.addOptions(cmd)
  })
  return cmd;
}

/**
 * @private
 * Get the database implementation as per the context options
 * @param {{options: {notificationDb: string}}} context
 * @returns
 */
function getDatabaseImpl(context) {
  const {
    options: { notificationDb }
  } = context;
  const store = DATABASE_IMPL.find((s) => s.code === notificationDb);
  if (!store) {
    throw new Error(`${notificationDb} is not a registered database implementation for notification database`);
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
  context.notificationDB = db;
  return context;
}


module.exports = {
  INotificationDB,
  addDatabaseOptions: addOptions,
  initializeDatabase: initialize
}
