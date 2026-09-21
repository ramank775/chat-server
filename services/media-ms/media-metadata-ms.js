const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { HttpServiceBase, addHttpOptions, initHttpResource } = require('../../libs/http-service-base');
const Database = require('./database');
const MediaStorage = require('./media-storage')
const { extractInfoFromRequest, schemas, errorEnvelope } = require('../../helper');
const { getContentTypeByExt } = require('../../libs/content-type-utils');

const asMain = require.main === module;

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = Database.addOptions(cmd);
  cmd = MediaStorage.addOptions(cmd);
  cmd.option(
    '--max-upload-size <max-upload-size>',
    'Maximum size in bytes of a single upload (default 25MB)',
    (c) => Number(c),
    25 * 1024 * 1024
  );
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

    // every non-envelope error (joi rejection, unknown route, crash) still leaves
    // the service through the AUTH_CONTRACT 11 envelope
    this.hapiServer.ext('onPreResponse', (req, h) => {
      const { response } = req;
      if (!response.isBoom) return h.continue;
      const status = response.output.statusCode;
      if (status >= 500) {
        this.log.error(`Unhandled error on ${req.path}: ${response.message}`);
        return h.response(errorEnvelope('INTERNAL_ERROR', 'Internal server error')).code(status);
      }
      const code = status === 404 ? 'NOT_FOUND' : 'validation_failed';
      return h.response(errorEnvelope(code, response.message)).code(status);
    });

    this.addRoute(
      '/upload/presigned_url',
      'GET',
      this.getUploadURL.bind(this),
      {
        validate:{
          headers: schemas.authHeaders,
          query: Joi.object({
            ext: Joi.string().required(),
            category: Joi.string().required(),
            size: Joi.number().integer().min(1).max(this.options.maxUploadSize).required()
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
    const user = extractInfoFromRequest(req, 'x-user');
    const file = await this.db.getRecord(fileId);
    if (!file || file.owner !== user) {
      return h.response(errorEnvelope('NOT_FOUND', 'file not found')).code(404);
    }
    if (file.status === true) {
      return h.response(errorEnvelope('ALREADY_MARKED', 'file status is already set')).code(400);
    }
    await this.db.updateFileStatus(fileId, !!status);
    return h.response().code(200);
  }

  /**
   * The unguessable fileId is the capability: it only ever reaches a user
   * through a message or profile they are entitled to. So any authenticated
   * caller holding one may download it. Upload and status stay owner scoped.
   */
  async getDownloadURL(req, h) {
    const { fileId } = req.params;

    const file = await this.db.getRecord(fileId);
    if (file == null) {
      return h.response(errorEnvelope('NOT_FOUND', 'file not found')).code(404);
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
    const owner = extractInfoFromRequest(req, 'x-user');
    const { ext, category, size } = req.query;
    return await this.getUploadPreSignedUrl(ext, category, owner, size);
  }

  async getUploadPreSignedUrl(ext, category, owner, contentLength) {
    const contentType = getContentTypeByExt(ext);
    const payload = {
      contentType,
      contentLength,
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
      contentLength: payload.contentLength,
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
