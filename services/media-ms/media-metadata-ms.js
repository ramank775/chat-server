const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { HttpServiceBase, addHttpOptions, initHttpResource } = require('../../libs/http-service-base');
const Database = require('./database');
const MediaStorage = require('./media-storage')
const { extractInfoFromRequest, schemas } = require('../../helper');
const { getContentTypeByExt } = require('../../libs/content-type-utils');

const asMain = require.main === module;

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = Database.addOptions(cmd);
  cmd = MediaStorage.addOptions(cmd);
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options)
    .then(initHttpResource)
    .then(Database.initialize)
    .then(MediaStorage.initialize);
}



class MediaMetadataMS extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('./database/media-metadata-db').IMediaMetadataDB} */
    this.db = this.context.db;
    /** @type {import('./media-storage/media-storage').IMediaStorage} */
    this.storage = this.context.storage;
  }

  async init() {
    await super.init();

    this.addRoute(
      '/upload/presigned_url',
      'GET',
      this.getUploadURL.bind(this),
      {
        validate:{
          headers: schemas.authHeaders,
          query: Joi.object({
            ext: Joi.string().required(),
            category: Joi.string().required()
          })
        }
      }
    );

    this.addRoute(
      '/download/{fileId}/presigned_url',
      'GET',
      this.getDownloadURL.bind(this),
      {
        validate: {
          headers: schemas.authHeaders,
          params: Joi.object({
            fileId: Joi.string().required()
          })
        }
      }
    );
    this.addRoute(
      '/{fileId}/status',
      'PUT',
      this.updateFileUploadStatus.bind(this),
      {
        validate:{
          headers: schemas.authHeaders,
          params: Joi.object({
            fileId: Joi.string().required()
          }),
          payload: Joi.object({
            status: Joi.bool().required()
          })
        }
      }
    );
  }

  async updateFileUploadStatus(req, h) {
    const { fileId } = req.params
    const { status } = req.payload;
    const user = extractInfoFromRequest(req, 'user');
    const file = await this.db.getRecord(fileId);
    if (!file || file.owner !== user) {
      return h.response({ error: 'file not found' }).code(404);
    }
    if (file.status === true) {
      return h.response({ error: 'bad request' }).code(400);
    }
    await this.db.updateFileStatus(fileId, !!status);
    return h.response().code(200);
  }

  async getDownloadURL(req, h) {
    const { fileId } = req.params;

    const file = await this.db.getRecord(fileId);
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

  async getUploadURL(req) {
    const username = extractInfoFromRequest(req, 'user');
    const { ext, category } = req.query;
    return await this.getUploadPreSignedUrl(ext, category, username);
  }

  async generateUploadURL(req) {
    const username = extractInfoFromRequest(req, 'user');
    const { ext, category } = req.payload;
    return await this.getUploadPreSignedUrl(ext, category, username);
  }

  async getUploadPreSignedUrl(ext, category, owner) {
    const contentType = getContentTypeByExt(ext);
    const payload = {
      contentType,
      category,
    };
    const fileRecord = {
      category,
      owner,
      contentType,
    };
    payload.fileId = await this.db.createRecord(fileRecord);
    const preSignedURL = await this.getSignedURL(payload, 'upload');
    return {
      url: preSignedURL,
      fileId: payload.fileId
    };
  }

  async getSignedURL(payload, operation) {
    const preSignedURL = await this.storage.getSignedUrl({
      operation,
      fileId: payload.fileId,
      category: payload.category,
      contentType: payload.contentType,
    })
    return preSignedURL;
  }

  async shutdown() {
    await super.shutdown();
    await this.db.dispose();
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResource(options)
    .then(async (context) => {
      await new MediaMetadataMS(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Media Metadata MS', error);
      process.exit(1);
    });
}

module.exports = {
  MediaMetadataMS,
  parseOptions,
  initResource
}
