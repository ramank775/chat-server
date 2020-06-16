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
    fs = require('fs'),
    path = require('path'),
    { Promise } = require('bluebird'),
    asMain = (require.main === module);

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = addStandardHttpOptions(cmd);
    cmd = addMongodbOptions(cmd);
    return resolveEnvVariables(cmd.parse(argv).opts())
}

async function initResource(options) {
    return await initDefaultResources(options)
        .then(initMongoClient)
        .then(initFileService)
}

async function addFileServiceOptions(cmd) {
    cmd.options('--basedir', 'base directory for upload', 'uploads')
    return cmd;
}

async function initFileService(context) {
    const { options: { basedir } } = context;
    if (!fs.existsSync(basedir)) {
        fs.mkdirSync(basedir);
    }
    const getfilePath = (filename) => {
        return path.join(basedir, filename);
    };
    const fileService = {}
    fileService.save = async (filestream, options) => {
        const { filename } = options;
        const filepath = getfilePath(filename)
        const writeFile = Promise.promisify(fs.writeFile)
        await writeFile(filepath, filestream);
        return { filename }
    };
    fileService.get = async (filename) => {
        const filepath = getfilePath(filename)
        const readfile = Promise.promisify(fs.readFile);
        return readfile(filepath);
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
    }

    async init() {
        await super.init();
        this.addRoute('/upload', 'POST', (res, h) => {

        });

        this.addRoute('/share', 'POST', (res, h) => {

        });

        this.addRoute('/{filename}', 'GET', (res, h) => {

        });
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