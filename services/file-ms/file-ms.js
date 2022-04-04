const path = require('path');
const {
  initDefaultOptions,
  initDefaultResources,
  addStandardHttpOptions,
  resolveEnvVariables
} = require('../../libs/service-base');
const { HttpServiceBase } = require('../../libs/http-service-base');
const { addDatabaseOptions, initializeDatabase } = require('./database');
const { addFileStorageOptions, initializeFileStorage } = require('./file-storage')
const { getFilename, extractInfoFromRequest } = require('../../helper');
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
    this.fileStorage = this.context.fileService;
  }

  async init() {
    await super.init();
    this.addRoute('/signed_url', 'POST', async (req, h) => {
      const { type } = req.payload;
      if (type === 'download') {
        return await this.getDownloadURL(req, h);
      } if (type === 'upload') {
        return await this.getUploadURL(req, h);
      }
      return h.send({ error: 'Bad request' }).status(400);
    });
    this.addRoute('/status', 'PUT', this.updateFileUploadStatus);
  }

  async updateFileUploadStatus(req, h) {
    const { fileId, status } = req.payload;
    const user = extractInfoFromRequest(req, 'user');
    const file = await this.fileMetadataDB.getRecord(fileId);
    if (!file || file.owner !== user) {
      return h.send({ error: 'file not found' }).status(404);
    }
    if (file.status === true) {
      return h.send({ error: 'bad request' }).status(400);
    }
    await this.fileMetadataDB.updateFileStatus(fileId, !!status);
  }

  async getDownloadURL(req, h) {
    const payload = {
      fileId: req.payload.fileId,
      contentType: req.payload.contentType
    };
    const file = await this.fileMetadataDB.getRecord(payload.fileId);
    if (file == null) {
      return h.send({ error: 'file not found' }).status(404);
    }
    payload.fileName = file.fileName;
    const preSignedURL = await this.getSignedURL(payload, 'download');
    return { url: preSignedURL };
  }

  async getUploadURL(req, _h) {
    const userName = extractInfoFromRequest(req, 'user');
    const { fileName, type } = req.payload;
    const contentType = getContentTypeByExt(path.extname(fileName));
    const payload = {
      fileName: getFilename(fileName),
      contentType,
      type
    };
    const fileRecord = {
      name: payload.fileName,
      owner: userName,
      contentType,
      type
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
      type: payload.type,
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
