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

class ProfileMs extends HttpServiceBase {
    constructor(context) {
        super(context);
        this.mongoClient = context.mongoClient;
        this.dbCollection = context.mongodbClient.collection('profile');
    }

    async init() {
        super.init();
        this.addRoute('/exits', 'POST', async (req, _) => {
            const username = req.payload.username;
            const exist = await this.isExists(username)
            return {
                status: exist
            }
        });

        this.addRoute('/register', 'POST', async (req, _) => {
            const { payload } = req;
            const exist = await this.isExists(payload.username);
            if (exist) {
                return {
                    status: false,
                    error: `username already taken`
                }
            }
            payload.addedOn = new Date().toUTCString();
            payload.isActive = true;
            await this.dbCollection.insertOne(payload);
            return {
                status: true,
                username: payload.username
            }
        })
    }

    async isExists(username) {
        const count = await this.dbCollection.count({ username: username });
        return count >0;
    }

    async shutdown() {
        await super.shutdown();
        await this.context.mongoClient.close()
    }
}

if (asMain) {
    const options = parseOptions(process.argv);
    initResource(options).then(async context => {
        await new ProfileMs(context).run()
    }).catch(async error => {
        console.error('Failed to initialized Profile MS', error);
        process.exit(1);
    })
}