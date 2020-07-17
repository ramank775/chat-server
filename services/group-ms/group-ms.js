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
    { 
        addJsonServerOptions,
        initJsonServer 
    } = require('../../libs/json-socket-utils'),
    asMain = (require.main === module);


function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = addStandardHttpOptions(cmd);
    cmd = addMongodbOptions(cmd);
    cmd = addJsonServerOptions(cmd);
    return resolveEnvVariables(cmd.parse(argv).opts())
}

async function initResource(options) {
    return await initDefaultResources(options)
        .then(initMongoClient)
        .then(initJsonServer)
}


class GroupMs extends HttpServiceBase {
    constructor(context) {
        super(context);
        this.mongoClient = context.mongoClient;
        this.groupCollection = context.mongodbClient.collection('group');
    }

    async init() {
        await super.init();
        this.addRoute('/create', 'POST', async (req, _) => {
            const { name, members, profilePic } = req.payload;
            const user = extractInfoFromRequest(req, 'user');
            const payload = {
                groupId: uuidv4(),
                name,
                members: [],
                profilePic,
                addedOn: new Date().toUTCString()
            }
            if (members.indexOf(user) == -1) {
                members.push(user)
            }
            members.forEach(member => {
                payload.members.push({ username: member, role: (member === user) ? 'admin' : 'user' });
            });
            await this.groupCollection.insertOne(payload);
            return {
                groupId: payload.groupId
            }
        });

        this.addRoute('/{groupId}/add', 'POST', async (req, h) => {
            const user = extractInfoFromRequest(req, 'user');
            const { groupId } = req.params;
            const group = await this.groupCollection.findOne({ groupId, 'members.username': user, 'members.role': 'admin' });
            if (!group) {
                return res.response({ status: false }).code(404);
            }
            const { members } = req.payload;
            if (!members) {
                return {
                    status: true
                };
            }
            const newMembers = members.map(member => ({ username: member, role: 'user' }));
            await this.groupCollection.updateOne({ _id: group._id }, { $addToSet: { members: { $each: newMembers } } });
            return { status: true }
        });

        this.addRoute('/{groupId}/remove', 'POST', async (req, h) => {
            const user = extractInfoFromRequest(req, 'user');
            const { member } = req.payload;
            const { groupId } = req.params;
            const group = await this.groupCollection.findOne({ groupId });
            if (!group) {
                return res.response({ status: false }).code(404);
            }
            const isSelf = user === member;
            const self = group.members.find(x => x.username === user);
            if (!isSelf && self.role !== 'admin') {
                return {
                    status: false
                }
            }
            const query = {
                $pull: { 'members.username': member }
            }

            await this.groupCollection.updateOne({ _id: group._id }, query);

            if (isSelf && self.role === 'admin') {
                const admin = group.members.find(x => x.username !== user && x.role === 'admin');
                if (!admin) {
                    const nextAdmin = group.members.find(x => x.username !== user);
                    nextAdmin.role = 'admin';
                    await this.groupCollection.updateOne({ _id: group._id, 'members.username': nextAdmin.username }, { 'members.$.role': 'admin' });
                }
            }

            return {
                status: true
            }
        });

        this.addRoute('/{groupId}', 'GET', async (req, h) => {
            const user = extractInfoFromRequest(req, 'user');
            const { groupId } = req.params;
            const group = await this.groupCollection.findOne({
                groupId,
                'members.username': user
            }, {
                projection: { _id: 0, groupId: 1, name: 1, members: 1, profilePic: 1 }
            });
            if (!group) {
                return h.response({ status: false }).status(404);
            }
            return group;
        })

        this.addRoute('/get', 'GET', async (req) => {
            const user = extractInfoFromRequest(req, 'user');
            const groups = await this.groupCollection.find({ 'members.username': user },
                {
                    projection: { _id: 0, groupId: 1, name: 1, members: 1, profilePic: 1 }
                }).toArray();
            return (groups || []);

        });

        this.jsonServer.on('request', async (message, socket) => {
            let method = message.func || 'get-users';
            const funcMapping = {
                'get-users': async (message) => {
                    const { groupId, user } = message;
                    const group = await this.groupCollection.findOne({groupId, 'members.username': user});
                    return group.members.map(x=>x.username);
                }
            };

            const func = funcMapping[method]
            if (!func) {
                socket.write({
                    error: 'bad request',
                    code: 400
                });
                return;
            }
            let result = await func(message);
            socket.write({
                code: 200,
                result
            });
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
        await new GroupMs(context).run()
    }).catch(async error => {
        console.error('Failed to initialized Group MS', error);
        process.exit(1);
    })
}