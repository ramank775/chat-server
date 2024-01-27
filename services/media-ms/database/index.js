const { IMediaMetadataDB } = require('./media-metadata-db');
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
  cmd = cmd.option('--media-metadata-db <media-metadata-db>', 'Which database implementation to use (mongo)', 'mongo');
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
    options: { mediaMetadataDb }
  } = context;
  const store = DATABASE_IMPL.find((s) => s.code === mediaMetadataDb);
  if (!store) {
    throw new Error(`${mediaMetadataDb} is not a registered database implementation for media metadata database`);
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
  context.db = db;
  return context;
}


module.exports = {
  IMediaMetadataDB,
  addOptions,
  initialize
}
