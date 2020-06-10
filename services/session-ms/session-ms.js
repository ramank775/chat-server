const
    kafka = require('../../libs/kafka-utils'),
    {
        ServiceBase,
        initDefaultOptions,
        initDefaultResources,
        resolveEnvVariables
    } = require('../../libs/service-base'),
    {
        addJsonServerOptions,
        initJsonServer
    } = require('../../libs/json-socket-utils'),
    asMain = (require.main === module);


async function initMemCache(context) {
    const memCache = {};
    memCache.get = function (key) {
        return memCache[key]
    }
    memCache.set = function (key, value) {
        memCache[key] = value
    }
    memCache.remove = function (key) {
        delete memCache[key]
    }

    context.memCache = memCache
    return context;
}

async function prepareEventListFromKafkaTopics(context) {
    const { options } = context;
    const { kafkaUserConnectedTopic, kafkaUserDisconnectedTopic } = options;
    context.events = {
        'user-connected': kafkaUserConnectedTopic,
        'user-disconnected': kafkaUserDisconnectedTopic
    }
    context.listenerEvents = [kafkaUserConnectedTopic, kafkaUserDisconnectedTopic]
    return context;
}
async function initResources(options) {
    const context = await initDefaultResources(options)
        .then(initMemCache)
        .then(prepareEventListFromKafkaTopics)
        .then(kafka.initEventListener)
        .then(initJsonServer);
    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = kafka.addStandardKafkaOptions(cmd);
    cmd = kafka.addKafkaSSLOptions(cmd)
        .option('--kafka-user-connected-topic <new-user-topic>', 'Used by consumer to consume new message when a user connected to server')
        .option('--kafka-user-disconnected-topic <user-disconnected-topic>', 'Used by consumer to consume new message when a user disconnected from the server');
    cmd = addJsonServerOptions(cmd);
    return resolveEnvVariables(cmd.parse(argv).opts());
}

class SessionMS extends ServiceBase {
    constructor(context) {
        super(context);
        this.jsonServer = context.jsonServer;
        this.memCache = context.memCache;
    }
    init() {
        const { listener, events } = this.context;
        listener.onMessage = (event, value) => {
            switch (event) {
                case events['user-connected']:
                    this.memCache.set(value.user, value.server)
                    break;
                case events['user-disconnected']:
                    const server = this.memCache.get(value.user)
                    if (server == value.server) {
                        this.memCache.remove(value.user)
                    }
                    break;
            }
        };
        this.jsonServer.on('request', async (message, socket) => {
            let method = message.func || 'get-server';
            const funcMapping = {
                'get-server': (message) => {
                    const { user } = message;
                    return this.getServer(user);
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
        const { jsonServer, listener } = this.context;
        await jsonServer.disconnect();
        await listener.disconnect();
    }

    async getServer(user) {
        return this.memCache.get(user) || null;
    }
}

if (asMain) {
    const options = parseOptions(process.argv);
    initResources(options)
        .then(async context => {
            await new SessionMS(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Session MS', error);
            process.exit(1);
        })
}
