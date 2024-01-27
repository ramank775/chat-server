const { IMediaStorage } = require('./media-storage');
const s3 = require('./s3-storage')

const MEDIA_STORAGE_IMPL = [
  s3
]

/**
 * Add command line options for database store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--media-storage <media-storage>', 'Which Media storage to use (s3)', 's3');
  MEDIA_STORAGE_IMPL.forEach(impl => {
    cmd = impl.addOptions(cmd)
  })
  return cmd;
}

/**
 * @private
 * Get the storage implementation as per the context options
 * @param {{options: {mediaStorage: string}}} context
 * @returns
 */
function getStorageImpl(context) {
  const {
    options: { mediaStorage }
  } = context;
  const store = MEDIA_STORAGE_IMPL.find((s) => s.code === mediaStorage);
  if (!store) {
    throw new Error(`${mediaStorage} is not a registered implementation for Auth provider`);
  }
  return store;
}

/**
 * Initialize Media Storage
 * @returns 
 */
async function initialize(context) {
  const impl = getStorageImpl(context)
  const provider = new impl.Implementation(context);
  await provider.init();
  context.storage = provider;
  return context;
}


module.exports = {
  IMediaStorage,
  addOptions,
  initialize,
}
