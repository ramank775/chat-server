const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const { IMediaStorage } = require('./media-storage');

class S3Storage extends IMediaStorage {
  #options;

  /** @type {S3Client} */
  #client;

  /** @type {S3Client} reads this service makes itself; [#client] signs urls */
  #reader;

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
      bucketName:  context.options.s3BucketName,
      endpoint: context.options.s3Endpoint,
      internalEndpoint: context.options.s3InternalEndpoint,
      forcePathStyle: context.options.s3ForcePathStyle
    };
  }

  /**
   * Get Signed URL
   * @param {{fileId: string; category: string; contentType: string; contentLength?: number; operation: 'upload'|'download'}} payload
   * @returns {Promise<string>}
   */
  async getSignedUrl(payload) {
    const key = `${this.#options.baseDir}/${payload.category}/${payload.fileId}`
    // No Expires here, it is the S3 object expiry header (a Date) and the aws
    // sdk v3 rejects a number; the url lifetime is expiresIn below.
    const params = {
      Bucket: this.#options.bucketName,
      Key: key
    };
    let command
    // Sign content-type and content-length so an upload url cannot be replayed
    // with another payload type or a larger body than the one we authorized.
    const signableHeaders = new Set();
    if (payload.operation === 'upload') {
      params.ContentType = payload.contentType;
      signableHeaders.add('content-type');
      if (payload.contentLength) {
        params.ContentLength = Number(payload.contentLength);
        signableHeaders.add('content-length');
      }
      command = new PutObjectCommand(params);
    } else {
      command = new GetObjectCommand(params);
    }

    const url = await getSignedUrl(this.#client, command, {
      expiresIn: this.#urlExpireTime,
      signableHeaders,
    });
    return url;
  }

  /**
   * SHA-256 (hex) of a stored object, streamed; null when there is none.
   * @param {{fileId: string; category: string}} payload
   * @returns {Promise<string|null>}
   */
  async sha256(payload) {
    let response;
    try {
      response = await this.#reader.send(new GetObjectCommand({
        Bucket: this.#options.bucketName,
        Key: `${this.#options.baseDir}/${payload.category}/${payload.fileId}`
      }));
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
    const hash = crypto.createHash('sha256');
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of response.Body) hash.update(chunk);
    return hash.digest('hex');
  }

  /**
   * Initialize the file storage instance
   */
  async init() {
    const client = (endpoint) => new S3Client({
      credentials: {
        accessKeyId: this.#options.accessKeyId,
        secretAccessKey: this.#options.secretAccessKey,
      },
      signatureVersion: 'v4',
      region: this.#options.region,
      endpoint: endpoint || undefined,
      forcePathStyle: !!this.#options.forcePathStyle,
      // SDK >= 3.729 otherwise signs a CRC32 of the empty body into every
      // upload url; S3, R2 and B2 then reject the real bytes (minio ignores it).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.#client = client(this.#options.endpoint);
    this.#reader = this.#options.internalEndpoint
      ? client(this.#options.internalEndpoint) : this.#client;
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
  cmd.option('--s3-endpoint <endpoint>', 's3 compatible endpoint (eg http://minio:9000), empty for aws');
  cmd.option('--s3-internal-endpoint <endpoint>',
    'where this service itself reaches the store, when it differs from the endpoint signed into urls (a dev stack)');
  cmd.option('--s3-force-path-style', 'use path style bucket addressing (required by minio)', false);
  return cmd;
}

module.exports = {
  code: 's3',
  addOptions: addFileServiceOptions,
  Implementation: S3Storage,
}
