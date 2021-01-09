const {
    initDefaultOptions,
    initDefaultResources,
    addStandardHttpOptions,
    resolveEnvVariables
} = require('../../libs/service-base'),
    {
        HttpServiceBase
    } = require('../../libs/http-service-base'),
    {
        addMongodbOptions,
        initMongoClient
    } = require('../../libs/mongo-utils'),
    path = require('path'),
    { uuidv4, extractInfoFromRequest } = require('../../helper'),
    AWS = require('aws-sdk');
    asMain = (require.main === module);

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = addStandardHttpOptions(cmd);
    cmd = addMongodbOptions(cmd);
    cmd = addFileServiceOptions(cmd);
    return cmd.parse(argv).opts();
}

async function initResource(options) {
    return await initDefaultResources(options)
        .then(initMongoClient)
        .then(initFileService)
}

function addFileServiceOptions(cmd) {
    cmd.option('--base-upload-dir <upload-dir>', 'base directory for upload', 'uploads')
    cmd.option('--s3-access-key-id <access-key-id>', 's3 access key id')
    cmd.option('--s3-secret-access-key <secret-access-key>', 's3 secret access key')
    cmd.option('--s3-region <region>', 's3 region', 'ap-south-1')
    cmd.option('--url-expire-time <expire-time>', 'pre signed url expire time', 600)
    cmd.option('--s3-bucket-name <bucket-name>', 's3 bucket name')
    return cmd;
}

async function initFileService(context) {
    const { options } = context;
    const { s3AccessKeyId, s3SecretAccessKey, s3Region } = options;
    const s3 = new AWS.S3();
    s3.config.update(
        {
            accessKeyId: s3AccessKeyId,
            secretAccessKey: s3SecretAccessKey,
            region: s3Region
        }
    );
    context.fileService = s3;
    return context
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
                return await this.getDownloadURL(req, h)
            } else if (type == 'upload') {
                return await this.getUploadURL(req, h)
            }
            return h.send({ error: 'Bad request' }).status(400);
        });
    }

    async getDownloadURL(req, h){
        const payload = {
            fileName: req.payload.fileName,
            contentType: req.payload.contentType,
        };
        const file = await this.fileStore.findOne({ _id: payload.fileName });
        if (file == null) {
            return h.send({ error: 'file not found' }).status(404);
        }
        payload.fileName = file.name
        const preSignedURL = await getSignedURL(payload, 'getObject')
        return { url: preSignedURL
        }
    }

    async getUploadURL(req, h){
        const userName = extractInfoFromRequest(req, 'user');
        const payload = {
            fileName: this.getFilename(req.payload.fileName),
            contentType: req.payload.contentType,
        };
        const file = await this.fileStore.insertOne({ name: payload.fileName, user: userName, createdAt: new Date().toUTCString()});
        const preSignedURL = await getSignedURL(payload, 'putObject')
        return {
            url: preSignedURL,
            fileName: file._id
        }
    }

    async getSignedURL(payload, operation) {
        const params = {
            Bucket: this.options.s3BucketName,
            key: payload.fileName,
            Expires: this.options.urlExpireTime,
            ContentType: payload.contentType
        }
        const preSignedURL = await this.fileService.getSignedUrl(operation, params);
        this.log.info(preSignedURL)
        return preSignedURL
    }

    getFilename(file) {
        const ext = path.extname(file.hapi.filename);
        const filename = path.basename(file.hapi.filename, ext);
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
    initResource(options).then(async context => {
        await new FileMS(context).run()
    }).catch(async error => {
        console.error('Failed to initialized Image MS', error);
        process.exit(1);
    })
}
