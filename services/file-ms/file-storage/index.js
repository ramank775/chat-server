const { IFileStorage } = require('./file-storage');
const s3 = require('./s3-file-storage');

const FILE_STORAGE_IMPL = [s3];

/**
 * Add command line options for database store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--file-storage <file-storage>', 'Which file storage to use (s3)', 's3');
  FILE_STORAGE_IMPL.forEach((impl) => {
    cmd = impl.addOptions(cmd);
  });
  return cmd;
}

/**
 * @private
 * Get the file storage implementation as per the context options
 * @param {{options: {fileStorage: string}}} context
 * @returns
 */
function getFileStorageImpl(context) {
  const {
    options: { fileStorage },
  } = context;
  const store = FILE_STORAGE_IMPL.find((s) => s.code === fileStorage);
  if (!store) {
    throw new Error(`${fileStorage} is not a registered implementation for Auth provider`);
  }
  return store;
}

/**
 * Initialize File Storage
 * @returns
 */
async function initialize(context) {
  const impl = getFileStorageImpl(context);
  const provider = new impl.Implementation(context);
  await provider.init();
  context.fileStorage = provider;
  return context;
}

module.exports = {
  IFileStorage,
  addFileStorageOptions: addOptions,
  initializeFileStorage: initialize,
};
