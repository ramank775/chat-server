const AWS = require('aws-sdk');
const { IFileStorage } = require('./file-storage')

class S3FileStorage extends IFileStorage {
  #options;

  /** @type {AWS.S3} */
  #client;

  /**
   * Group Database interface
   * @param {options:{}} context 
   */
  constructor(context) {
    super(context);
    this.#options = {
      baseDir: context.options.baseUploadDir,
      accessKeyId: context.options.s3AccessKeyId,
      secretAccessKey: context.options.s3SecretAccessKey,
      region: context.options.s3Region,
      expireTime: context.options.urlExpireTime,
      bucketName:  context.options.s3BucketName
    }
  }

  /**
   * Get Signed URL
   * @param {{fileId: string; category: string; contentType: string, operation: 'upload'|'download'}} payload
   * @returns {Promise<string>}
   */
  async getSignedUrl(payload) {
    const key = `${this.#options.baseDir}/${payload.category}/${payload.fileId}`
    const params = {
      Bucket: this.#options.bucketName,
      Key: key,
      Expires: this.#options.expireTime
    };
    if (payload.operation === 'upload') {
      params.ContentType = payload.contentType;
    }
    const operation = payload.operation === 'upload'? 'putObject' : 'getObject';
    const preSignedURL = this.#client.getSignedUrl(operation, params);
    return preSignedURL;
  }

  /**
   * Initialize the file storage instance
   */
  async init() {
    this.#client = new AWS.S3({
      credentials: {
        accessKeyId: this.#options.accessKeyId,
        secretAccessKey: this.#options.secretAccessKey,
      },
      signatureVersion: 'v4',
      region: this.#options.region,
    });
  }

  /**
   * Dispose the database internal resources
   */
  async dispose() {
    this.#client = null;
  }
}

function addFileServiceOptions(cmd) {
  cmd.option('--base-upload-dir <upload-dir>', 'base directory for upload', 'uploads');
  cmd.option('--s3-access-key-id <access-key-id>', 's3 access key id');
  cmd.option('--s3-secret-access-key <secret-access-key>', 's3 secret access key');
  cmd.option('--s3-region <region>', 's3 region', 'ap-south-1');
  cmd.option('--url-expire-time <expire-time>', 'pre signed url expire time', (c) => Number(c), 600);
  cmd.option('--s3-bucket-name <bucket-name>', 's3 bucket name');
  return cmd;
}

module.exports = {
  code: 's3',
  addOptions: addFileServiceOptions,
  Implementation: S3FileStorage,
}
