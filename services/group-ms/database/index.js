const { IGroupDB } = require('./group-db');
const mongodb = require('./mongo-group-db')

const DATABASE_IMPL = [
  mongodb
]

/**
 * Add command line options for database store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--group-db <group-db>', 'Which database implementation to use (mongo)', 'mongo');
  DATABASE_IMPL.forEach(impl => {
    cmd = impl.addOptions(cmd)
  })
  return cmd;
}

/**
 * @private
 * Get the database implementation as per the context options
 * @param {{options: {groupDb: string}}} context
 * @returns
 */
function getDatabaseImpl(context) {
  const {
    options: { groupDb }
  } = context;
  const store = DATABASE_IMPL.find((s) => s.code === groupDb);
  if (!store) {
    throw new Error(`${groupDb} is not a registered database implementation for Group database`);
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
  context.groupDb = db;
  return context;
}


module.exports = {
  IGroupDB,
  addDatabaseOptions: addOptions,
  initializeDatabase: initialize
}
