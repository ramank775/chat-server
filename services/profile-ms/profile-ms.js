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
    { uuidv4, extractInfoFromRequest } = require('../../helper'),
    admin = require('firebase-admin'),
    asMain = (require.main === module);

function firebaseProjectOptions(cmd) {
    return cmd.option('--firebase-project-id <firebaseProjectId>', 'Firebase Project Id')
}

async function initFirebaseAdmin(context) {
    const { options } = context;
    const app = admin.initializeApp({
        projectId: options.firebaseProjectId
    });
    context.firebaseApp = app;
    context.firebaseAuth = app.auth();
    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = addStandardHttpOptions(cmd);
    cmd = addMongodbOptions(cmd);
    cmd = firebaseProjectOptions(cmd);
    return cmd.parse(argv).opts();
}

async function initResource(options) {
    return await initDefaultResources(options)
        .then(initMongoClient)
        .then(initFirebaseAdmin)
}

class ProfileMs extends HttpServiceBase {
    constructor(context) {
        super(context);
        this.mongoClient = context.mongoClient;
        this.profileCollection = context.mongodbClient.collection('profile');
        this.authCollection = context.mongodbClient.collection('session_auth');
        this.firebaseAuth = context.firebaseAuth;
    }

    async init() {
        await super.init();

        this.addRoute('/auth', ['GET', 'POST'], async (req, res) => {
            const username = extractInfoFromRequest(req, 'user');
            const accesskey = extractInfoFromRequest(req, 'accesskey');
            const token = extractInfoFromRequest(req, 'token');
            try {
                await this.verify(token);

            } catch (error) {
                this.log.error(`Error while authentication : ${error}`);
                return res.response({}).code(401);
            }

            const authProfile = await this.authCollection.findOne({ username, accesskey })
            if (authProfile) {
                return res.response({}).code(200);
            }
            return res.response({}).code(401);
        });

        this.addRoute('/login', 'POST', async (req, res) => {
            const { payload: { username } } = req;
            const token = extractInfoFromRequest(req, 'token');
            let isNew = false;
            let result;
            try {
                result = await this.verify(token);
            } catch (error) {
                this.log.error(`Error while authentication : ${error}`);
                return res.response({}).code(401);
            }
            const isExist = await this.isExists(username);
            if (!isExist) {
                isNew = true;
                const profile = {
                    username,
                    uid: result.uid,
                    addedOn: new Date().toUTCString(),
                    isActive: true
                }
                await this.profileCollection.insertOne(profile);
            }

            const accesskey = await this.getAccessKey(username);
            return {
                status: true,
                username,
                accesskey,
                isNew
            };
        });

        this.addRoute('/get', 'GET', async (req) => {
            const username = extractInfoFromRequest(req);
            if (!username) {
                return {};
            }
            let user = await this.profileCollection.findOne({ username, isActive: true }, { projection: { _id: 0, name: 1, username: 1 } });
            return user || {};
        });

        this.addRoute('/user/sync', 'POST', async (req) => {
            const {users = []} = req.payload;
            const availableUsers = await this.profileCollection.find({username: {$in: users}, isActive: true}, {projection: {_id: 0, username: 1}}).toArray();
            const result = {};
            users.forEach(user => {
                result[user] = availableUsers.find(x=>x.username == user) != null;
            });
            return result|| {};
        })
    }

    async isExists(username) {
        const count = await this.profileCollection.count({ username });
        return count > 0;
    }

    async verify(accesskey) {
        const decodedToken = await this.firebaseAuth.verifyIdToken(accesskey);
        return decodedToken;
    }

    async getAccessKey(username) {
        const newAccessKey = uuidv4();
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

    async shutdown() {
        await super.shutdown();
        await this.context.mongoClient.close()
    }
}

if (asMain) {
    const argv = resolveEnvVariables(process.argv);
    const options = parseOptions(argv);
    initResource(options).then(async context => {
        await new ProfileMs(context).run()
    }).catch(async error => {
        console.error('Failed to initialized Profile MS', error);
        process.exit(1);
    })
}