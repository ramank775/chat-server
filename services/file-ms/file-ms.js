const { initDefaultOptions, initDefaultResources, addStandardHttpOptions, resolveEnvVariables } = require('../../libs/service-base'),
  { HttpServiceBase } = require('../../libs/http-service-base'),
  { addMongodbOptions, initMongoClient } = require('../../libs/mongo-utils'),
  path = require('path'),
  { uuidv4, extractInfoFromRequest } = require('../../helper'),
  AWS = require('aws-sdk'),
  { ObjectId } = require('mongodb'),
  { getContentTypeByExt } = require('../../libs/content-type-utils'),
  asMain = require.main === module;

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addStandardHttpOptions(cmd);
  cmd = addMongodbOptions(cmd);
  cmd = addFileServiceOptions(cmd);
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options).then(initMongoClient).then(initFileService);
}

function addFileServiceOptions(cmd) {
  cmd.option('--base-upload-dir <upload-dir>', 'base directory for upload', 'uploads');
  cmd.option('--s3-access-key-id <access-key-id>', 's3 access key id');
  cmd.option('--s3-secret-access-key <secret-access-key>', 's3 secret access key');
  cmd.option('--s3-region <region>', 's3 region', 'ap-south-1');
  cmd.option('--url-expire-time <expire-time>', 'pre signed url expire time', 600);
  cmd.option('--s3-bucket-name <bucket-name>', 's3 bucket name');
  return cmd;
}

async function initFileService(context) {
  const { options } = context;
  const { s3AccessKeyId, s3SecretAccessKey, s3Region } = options;
  const s3 = new AWS.S3();
  s3.config.update({
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    region: s3Region,
    signatureVersion: 'v4'
  });
  context.fileService = s3;
  return context;
}

class FileMS extends HttpServiceBase {
  constructor(context) {
    super(context);
    this.mongoClient = this.context.mongoClient;
    this.fileStore = this.context.mongodbClient.collection('file_store');
    this.fileService = this.context.fileService;
  }

  async init() {
    await super.init();
    this.addRoute('/signed_url', 'POST', async (req, h) => {
      const type = req.payload.type;
      if (type == 'download') {
        return await this.getDownloadURL(req, h);
      } else if (type == 'upload') {
        return await this.getUploadURL(req, h);
      }
      return h.send({ error: 'Bad request' }).status(400);
    });
    this.addRoute('/status', 'PUT', this.updateFileUploadStatus);
  }

  async updateFileUploadStatus(req, h) {
    const { fileName, status } = req.payload;
    const user = extractInfoFromRequest(req, 'user');
    const file = await this.fileStore.findOne({ _id: fileName, user: user });
    if (!file) {
      return h.send({ error: 'file not found' }).status(404);
    }
    if (file.status === true) {
      return h.send({ error: 'bad request' }).status(400);
    }
    await this.fileStore.updateOne(
      { _id: fileName },
      {
        $set: { status: !!status }
      }
    );
  }

  async getDownloadURL(req, h) {
    const payload = {
      fileName: req.payload.fileName,
      contentType: req.payload.contentType
    };
    const file = await this.fileStore.findOne({ _id: ObjectId(payload.fileName), status: true });
    if (file == null) {
      return h.send({ error: 'file not found' }).status(404);
    }
    payload.fileName = file.name;
    const preSignedURL = await this.getSignedURL(payload, 'getObject');
    return { url: preSignedURL };
  }

  async getUploadURL(req, h) {
    const userName = extractInfoFromRequest(req, 'user');
    const { fileName } = req.payload;
    const contentType = getContentTypeByExt(path.extname(fileName));
    const payload = {
      fileName: this.getFilename(fileName),
      contentType: contentType
    };
    const fileRecord = { name: payload.fileName, user: userName, createdAt: new Date().toUTCString() };
    const file = await this.fileStore.insertOne(fileRecord);
    const preSignedURL = await this.getSignedURL(payload, 'putObject');
    return {
      url: preSignedURL,
      fileName: fileRecord._id
    };
  }

  async getSignedURL(payload, operation) {
    const params = {
      Bucket: this.options.s3BucketName,
      Key: payload.fileName,
      Expires: this.options.urlExpireTime
    };
    if (operation == 'putObject') {
      params.ContentType = payload.contentType;
    }
    try {
      const preSignedURL = await this.fileService.getSignedUrl(operation, params);
      this.log.info(preSignedURL);
      return preSignedURL;
    } catch (error) {
      throw error;
    }
  }

  getFilename(file) {
    const ext = path.extname(file);
    const filename = path.basename(file, ext);
    return `${filename}.${uuidv4()}${ext}`;
  }

  async shutdown() {
    await super.shutdown();
    await this.mongoClient.close();
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
      console.error('Failed to initialized Image MS', error);
      process.exit(1);
    });
}
