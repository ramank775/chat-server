const { IFileMetadataDB } = require('./file-metadata-db');
const mongodb = require('./mongo-file-db')

const DATABASE_IMPL = [
  mongodb
]

/**
 * Add command line options for database store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--file-metadata-db <file-metadata-db>', 'Which database implementation to use (mongo)', 'mongo');
  DATABASE_IMPL.forEach(impl => {
    cmd = impl.addOptions(cmd)
  })
  return cmd;
}

/**
 * @private
 * Get the database implementation as per the context options
 * @param {{options: {fileMetadataDb: string}}} context
 * @returns
 */
function getDatabaseImpl(context) {
  const {
    options: { fileMetadataDb }
  } = context;
  const store = DATABASE_IMPL.find((s) => s.code === fileMetadataDb);
  if (!store) {
    throw new Error(`${fileMetadataDb} is not a registered database implementation for Group database`);
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
  context.fileMetadataDB = db;
  return context;
}


module.exports = {
  IFileMetadataDB,
  addDatabaseOptions: addOptions,
  initializeDatabase: initialize
}
