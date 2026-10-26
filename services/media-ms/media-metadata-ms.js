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

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 100;

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
  cmd.option(
    '--media-ttl-days <days>',
    'Delete a message file this many days after it was last sent (0 = keep forever)',
    (c) => Number(c),
    30
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
            size: Joi.number().integer().min(1).max(this.options.maxUploadSize).required(),
            // Decision 190: the MD5 (hex) of a convergently encrypted upload.
            md5: Joi.string().pattern(/^[0-9a-f]{32}$/)
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

    // profile-ms, on a new profile photo or a deleted account: the old photo goes
    this.addInternalRoute('/files/delete', 'POST', this.deleteOwnFile.bind(this), {
      validate: {
        payload: Joi.object({ fileId: Joi.string().required(), owner: Joi.string().required() })
      }
    });

    if (this.options.mediaTtlDays > 0) {
      this.sweepTimer = setInterval(() => {
        this.sweepExpired().catch((error) => this.log.error(`Media sweep failed: ${error.message}`));
      }, SWEEP_EVERY_MS).unref();
    }
  }

  /** Only [owner]'s own file: a profile can name any fileId. */
  async deleteOwnFile(req) {
    const { fileId, owner } = req.payload;
    const file = await this.db.getRecord(fileId);
    if (!file || file.owner !== owner) return { deleted: false };
    await this.deleteFile(fileId, file.category);
    return { deleted: true };
  }

  /** Object first: a record without its object would be reused as if it were there. */
  async deleteFile(fileId, category) {
    await this.storage.delete({ fileId, category });
    await this.db.removeRecord(fileId);
  }

  /**
   * A message file is deleted --media-ttl-days after anyone last sent it
   * (reuse restarts the clock). Profile and group photos never expire. A
   * failed delete stays marked and is retried by the next sweep.
   */
  async sweepExpired(now = Date.now()) {
    const cutoff = new Date(now - this.options.mediaTtlDays * DAY_MS);
    const batch = await this.db.markExpired('message', cutoff, SWEEP_BATCH);
    await Promise.all(batch.map((file) => this.deleteFile(String(file._id), file.category)));
    if (batch.length === SWEEP_BATCH) await this.sweepExpired(now);
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
    // Decision 190: the signed Content-MD5 made the store refuse any other
    // bytes, so a file someone will reuse only needs to exist: marking it
    // complete without uploading cannot claim a real file's hash.
    if (status && file.md5 && !(await this.storage.exists({ fileId, category: file.category }))) {
      return h.response(errorEnvelope('NOT_UPLOADED', 'nothing was stored for this file')).code(409);
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
    const { ext, category, size, md5 } = req.query;
    // Decision 190: the same encrypted file is stored once. A copy already
    // there gets no url and no record: the caller reuses it.
    if (md5) {
      const existing = await this.db.reuseByMd5(md5, category);
      if (existing) return { fileId: String(existing._id), existing: true };
    }
    return await this.getUploadPreSignedUrl(ext, category, owner, size, md5);
  }

  async getUploadPreSignedUrl(ext, category, owner, contentLength, md5) {
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
      ...(md5 ? { md5 } : {}),
    };
    payload.fileId = await this.db.createRecord(fileRecord);
    if (md5) payload.contentMd5 = Buffer.from(md5, 'hex').toString('base64');
    const preSignedURL = await this.getSignedURL(payload, 'upload');
    // The PUT must carry exactly the content-type signed into the url;
    // say which, so clients don't need their own copy of this mapping.
    return {
      url: preSignedURL,
      fileId: payload.fileId,
      contentType,
    };
  }

  async getSignedURL(payload, operation) {
    const preSignedURL = await this.storage.getSignedUrl({
      operation,
      fileId: payload.fileId,
      category: payload.category,
      contentType: payload.contentType,
      contentLength: payload.contentLength,
      contentMd5: payload.contentMd5,
    })
    return preSignedURL;
  }

  async shutdown() {
    clearInterval(this.sweepTimer);
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
