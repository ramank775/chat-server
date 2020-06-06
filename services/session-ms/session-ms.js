const
    kafka = require('../../libs/kafka-utils'),
    {
        ServiceBase,
        initDefaultOptions,
        initDefaultResources,
        resolveEnvVariables
    } = require('../../libs/service-base'),
    asMain = (require.main === module);


async function initMemCache(context) {
    const memCahce = {};
    memCahce.get = function (key) {
        return memCahce[key]
    }
    memCahce.set = function (key, value) {
        memCahce[key] = value
    }
    memCahce.remove = function (key) {
        delete memCahce[key]
    }

    context.memCahce = memCahce
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
        .then(kafka.initEventListener);
    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = kafka.addStandardKafkaOptions(cmd);
    cmd = kafka.addKafkaSSLOptions(cmd)
        .option('--kafka-user-connected-topic <new-user-topic>', 'Used by consumer to consume new message when a user connected to server')
        .option('--kafka-user-disconnected-topic <user-disconnected-topic>', 'Used by consumer to consume new message when a user disconnected from the server')
    return resolveEnvVariables(cmd.parse(argv).opts());
}

class SessionMS extends ServiceBase {
    constructor(context) {
        super(context);
    }
    init() {
        const { listener, events } = this.context;
        listener.onMessage = (event, value) => {
            switch (event) {
                case events['user-connected']:
                    memCahce.set(value.user, value.server)
                    break;
                case events['user-disconnected']:
                    const server = memCahce.get(value.user)
                    if (server == value.server) {
                        memChahe.remove(value.user)
                    }
                    break;
            }
        };
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
