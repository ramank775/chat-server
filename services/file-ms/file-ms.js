const {
  initDefaultOptions,
  initDefaultResources,
  addStandardHttpOptions,
  resolveEnvVariables
} = require('../../libs/service-base');
const { HttpServiceBase } = require('../../libs/http-service-base');
const { addDatabaseOptions, initializeDatabase } = require('./database');
const { addFileStorageOptions, initializeFileStorage } = require('./file-storage')
const { extractInfoFromRequest } = require('../../helper');
const { getContentTypeByExt } = require('../../libs/content-type-utils');

const asMain = require.main === module;

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addStandardHttpOptions(cmd);
  cmd = addDatabaseOptions(cmd);
  cmd = addFileStorageOptions(cmd);
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options)
    .then(initializeDatabase)
    .then(initializeFileStorage);
}



class FileMS extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('./database/file-metadata-db').IFileMetadataDB} */
    this.fileMetadataDB = this.context.fileMetadataDB;
    /** @type {import('./file-storage/file-storage').IFileStorage} */
    this.fileStorage = this.context.fileStorage;
  }

  async init() {
    await super.init();
    this.addRoute('/upload/presigned_url', 'POST', this.getUploadURL.bind(this));
    this.addRoute('/download/{fileId}/presigned_url', 'GET', this.getDownloadURL.bind(this));
    this.addRoute('/{fileId}/status', 'PUT', this.updateFileUploadStatus.bind(this));
  }

  async updateFileUploadStatus(req, h) {
    const { fileId } = req.params
    const { status } = req.payload;
    const user = extractInfoFromRequest(req, 'user');
    const file = await this.fileMetadataDB.getRecord(fileId);
    if (!file || file.owner !== user) {
      return h.response({ error: 'file not found' }).code(404);
    }
    if (file.status === true) {
      return h.response({ error: 'bad request' }).code(400);
    }
    await this.fileMetadataDB.updateFileStatus(fileId, !!status);
    return h.response().code(200);
  }

  async getDownloadURL(req, h) {
    const { fileId } = req.params;

    const file = await this.fileMetadataDB.getRecord(fileId);
    if (file == null) {
      return h.response({ error: 'file not found' }).code(404);
    }
    const payload = {
      fileId,
      category: file.category,
      contentType: file.contentType,
    };
    const preSignedURL = await this.getSignedURL(payload, 'download');
    return { url: preSignedURL };
  }

  async getUploadURL(req, _h) {
    const userName = extractInfoFromRequest(req, 'user');
    const { ext, category } = req.payload;
    const contentType = getContentTypeByExt(ext);
    const payload = {
      contentType,
      category,
    };
    const fileRecord = {
      category,
      owner: userName,
      contentType,
    };
    payload.fileId = await this.fileMetadataDB.createRecord(fileRecord);
    const preSignedURL = await this.getSignedURL(payload, 'upload');
    return {
      url: preSignedURL,
      fileId: payload.fileId
    };
  }

  async getSignedURL(payload, operation) {
    const preSignedURL = await this.fileStorage.getSignedUrl({
      operation,
      fileId: payload.fileId,
      category: payload.category,
      contentType: payload.contentType,
    })
    return preSignedURL;
  }

  async shutdown() {
    await super.shutdown();
    await this.fileMetadataDB.dispose();
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResource(options)
    .then(async (context) => {
      await new FileMS(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Image MS', error);
      process.exit(1);
    });
}
