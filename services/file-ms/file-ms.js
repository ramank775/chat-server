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
    {
        getContentTypeByExt
    } = require('../../libs/context-type-utils')
    fs = require('fs'),
    path = require('path'),
    { Promise } = require('bluebird'),
    { uuidv4, extractInfoFromRequest } = require('../../helper'),
    asMain = (require.main === module);

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = addStandardHttpOptions(cmd);
    cmd = addMongodbOptions(cmd);
    cmd = addFileServiceOptions(cmd);
    return resolveEnvVariables(cmd.parse(argv).opts())
}

async function initResource(options) {
    return await initDefaultResources(options)
        .then(initMongoClient)
        .then(initFileService)
}

function addFileServiceOptions(cmd) {
    cmd.option('--base-upload-dir <upload-dir>', 'base directory for upload', 'uploads')
    return cmd;
}

async function initFileService(context) {
    const { options: { baseUploadDir: basedir } } = context;
    if (!fs.existsSync(basedir)) {
        fs.mkdirSync(basedir);
    }
    const getfilePath = (filename) => {
        return path.join(basedir, filename);
    };
    const fileService = {}
    fileService.save = async (file, options) => {
        const { filename } = options;
        const filepath = getfilePath(filename)
        const fileStream = fs.createWriteStream(filepath);

        const filePromise = new Promise((resolve, reject) => {
            file.on('error', function (err) {
                reject(err);
            });

            file.pipe(fileStream);

            file.on('end', function (err) {

                resolve({ filename });
            })
        })
        const fileDetails = await filePromise;
        return fileDetails
    };
    fileService.get = async (filename) => {
        const exists = Promise.promisify(fs.exists);
        const filepath = getfilePath(filename);
        if (!fs.existsSync(filepath)) return null;
        return fs.createReadStream(filepath);
    }

    fileService.delete = async (filename) => {
        const filepath = getfilePath(filename);
        const deletefile = Promise.promisify(fs.unlink);
        return deletefile(filepath);
    }
    context.fileService = fileService;
    return context;
}

class ImageMS extends HttpServiceBase {
    constructor(context) {
        super(context);
        this.mongoClient = this.context.mongoClient;
        this.filePermission = this.context.mongodbClient.collection('file_permission');
        this.fileService = this.context.fileService;
    }

    async init() {
        await super.init();

        this.addRoute('/upload', 'POST', async (req, _) => {
            const { file, accesslist =[]} = req.payload;
            const user = extractInfoFromRequest(req, 'user');
            const filename = this.getFilename(file);
            accesslist.push(user)
            const finalAccesslist = new Set(accesslist)
            const fileObject = { user, filename, accesslist: [...finalAccesslist], addedon: new Date().toUTCString() };
            await this.filePermission.insert(fileObject);
            await this.fileService.save(file, { filename });
            return { filename }
        }, {
            payload: {
                output: 'stream',
                parse: true,
                allow: 'multipart/form-data',
                multipart: true
            }
        });

        this.addRoute('/{filename}', 'GET', async (req, h) => {
            const { filename } = req.params;
            const user = extractInfoFromRequest(req, user);
            const file_permission = await this.filePermission.findOne({ filename, $or: [{ accesslist: '*' }, { accesslist: user }] });
            if (!file_permission) {
                return h.send({ error: 'file not found' }).status(404);
            }
            const file = await this.fileService.get(filename);
            if (!file) return;
            const fileExt = path.extname(filename);
            const response = h.response(file).type(getContentTypeByExt(fileExt))
            return response;
        });
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
    const options = parseOptions(process.argv);
    initResource(options).then(async context => {
        await new ImageMS(context).run()
    }).catch(async error => {
        console.error('Failed to initialized Image MS', error);
        process.exit(1);
    })
}