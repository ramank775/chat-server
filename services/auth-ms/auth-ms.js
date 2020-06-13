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
}

class AuthMs extends HttpServiceBase {
    constructor(context) {
        super(context);
        this.mongoClient = context.mongoClient;
        this.dbCollection = context.mongodbClient.collection('auth');
    }

    async init() {
        super.init();
        this.addRoute('/auth', 'POST', async (req, res) => {
            const username = req.headers.user;
            const accessKey = req.headers.accesskey;
            const authProfile = await this.dbCollection.findOne({username: username, accessKey: accessKey})
            if(!authProfile) {
                return res({}).code(401);
            }
            return res({}).code(200);
        });

        this.addRoute('/register', 'POST', async (req, _) => {
            const username = req.headers.username;
            const exist = await this.isExists(payload.username);
            if (exist) {
                return {
                    status: false,
                    error: `username already taken`
                }
            }
            const payload = {
                username,
                accessKey  :this.uuidv4(),
                addedOn = new Date().toUTCString(),
                isActive = true
            }
            
            await this.dbCollection.insertOne(payload);
            return {
                status: true,
                username: payload.username,
                accessKey: payload.accessKey
            }
        })
    }

    async isExists(username) {
        const count = await this.dbCollection.count({ username: username });
        return count > 0;
    }

    uuidv4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    async shutdown() {
        await super.shutdown();
        await this.context.mongoClient.close()
    }
}

if (asMain) {
    const options = parseOptions(process.argv);
    initResource(options).then(async context => {
        await new AuthMs(context).run()
    }).catch(async error => {
        console.error('Failed to initialized Auth MS', error);
        process.exit(1);
    })
}