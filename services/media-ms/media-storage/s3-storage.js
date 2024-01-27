const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const { IMediaStorage } = require('./media-storage');

class S3Storage extends IMediaStorage {
  #options;

  /** @type {S3Client} */
  #client;

  #urlExpireTime

  /**
   * Group Database interface
   * @param {options:{}} context 
   */
  constructor(context) {
    super(context);
    this.#urlExpireTime = context.options.urlExpireTime;
    this.#options = {
      baseDir: context.options.baseUploadDir,
      accessKeyId: context.options.s3AccessKeyId,
      secretAccessKey: context.options.s3SecretAccessKey,
      region: context.options.s3Region,
      expireTime: context.options.urlExpireTime,
      bucketName:  context.options.s3BucketName
    };
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
    let command
    if (payload.operation === 'upload') {
      params.ContentType = payload.contentType;
      command = new PutObjectCommand(params);
    } else {
      command = new GetObjectCommand(params);
    }

    const url = await getSignedUrl(this.#client, command, {
      expiresIn: this.#urlExpireTime,
    });
    return url;
  }

  /**
   * Initialize the file storage instance
   */
  async init() {
    this.#client = new S3Client({
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
  Implementation: S3Storage,
}
