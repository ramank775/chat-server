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
        this.profileCollection = context.mongodbClient.collection('profile');
        this.authCollection = context.mongodbClient.collection('auth');
    }

    async init() {
        await super.init();
        this.addRoute('/exist', 'POST', async (req, _) => {
            this.log.info(`new request for exist with username ${req.payload}`)
            const username = req.payload.username;
            const exist = await this.isExists(username)
            return {
                status: exist
            }
        });

        this.addRoute('/register', 'POST', async (req, _) => {
            const { payload: { username, secretPhase, name } } = req;
            const exist = await this.isExists(username);
            if (exist) {
                return {
                    status: false,
                    error: `username already taken`
                }
            }
            const profile = {
                name,
                username,
                secretPhase,
                addedOn: new Date().toUTCString(),
                isActive: true
            }
            await this.profileCollection.insertOne(profile);
            const accesskey = await this.getAccessKey(username)
            return {
                status: true,
                username,
                accesskey
            }
        });

        this.addRoute('/auth', ['GET', 'POST'], async (req, res) => {
            const username = req.headers.user || req.state.user;
            const accesskey = req.headers.accesskey || req.state.accesskey;
            const authProfile = await this.authCollection.findOne({ username, accesskey })
            if (!authProfile) {
                return res({}).code(401);
            }
            return res({}).code(200);
        });

        this.addRoute('/login', 'POST', async (req, res) => {
            const { payload: { username, secretPhase } } = req;
            const profile = await this.profileCollection.findOne({ username, secretPhase });
            if (!profile) {
                return res.send({}).status(401);
            }
            const accesskey = await this.getAccessKey(username);
            return {
                status: true,
                username,
                accesskey
            };
        })

    }

    async isExists(username) {
        const count = await this.profileCollection.count({ username });
        return count > 0;
    }

    async auth(username, accesskey) {
        const resp = await this.authCollection.findOne({ username, accesskey });
        return !!resp;
    }

    async getAccessKey(username) {
        const newAccessKey = this.uuidv4();
        const newAuthDoc = {
            username,
            accesskey: newAccessKey,
            updatedOn: new Date().toUTCString()
        }
        await this.authCollection.update({ username }, {
            $set: newAuthDoc,
            $setOnInsert: {
                addedOn: new Date().toUTCString()
            }
        }, {
            upsert: true
        });
        return newAccessKey;
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
        await new ProfileMs(context).run()
    }).catch(async error => {
        console.error('Failed to initialized Profile MS', error);
        process.exit(1);
    })
}