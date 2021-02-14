const kafka = require('../../libs/kafka-utils'),
    {
        ServiceBase,
        initDefaultOptions,
        initDefaultResources,
        resolveEnvVariables
    } = require('../../libs/service-base'),
    {
        initJsonClient
    } = require('../../libs/json-socket-utils'),
    asMain = (require.main === module);

async function prepareEventListFromKafkaTopics(context) {
    const { options } = context;
    const eventName = {
        'send-message-db': options.kafkaPersistenceMessageTopic
    }
    context.events = eventName;
    context.listenerEvents = [
        options.kafkaNewGroupMessageTopic,
    ]
    return context;
}

async function initResources(options) {
    const context = await initDefaultResources(options)
        .then(prepareEventListFromKafkaTopics)
        .then(kafka.initEventProducer)
        .then(kafka.initEventListener)
    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = kafka.addStandardKafkaOptions(cmd);
    cmd = kafka.addKafkaSSLOptions(cmd);
    cmd.option('--kafka-new-group-message-topic <new-group-message-topic>', 'Used by consumer to consume new group message for each new incoming message')
        .option('--kafka-persistence-message-topic <persistence-message-topic>', 'Used by producer to produce new message to saved into a persistence db')
        .option('--session-service-url <session-service-url>', 'URL of session service')
        .option('--group-service-url <group-service-url>', 'URL of group service')
    return cmd.parse(argv).opts();
}

class GroupMessageRouterMS extends ServiceBase {
    constructor(context) {
        super(context);
    }
    init() {
        const { listener } = this.context;
        listener.onMessage = async (topic, message) => {
            await this.redirectMessage(message);
        }
    }
    async redirectMessage(message) {
        const { publisher } = this.context;
        if (!message.META.parsed) {
            message = await this.formatMessage(message);
        }
        let users = message.META.users;
        if (!users) {
            users = await this.getGroupUsers(message.META.to, message.META.from);
        }
        users = users.filter(x => x !== message.META.from);
        const servers = await this.getServers(users);
        for (const user of users) {
            const server = servers[user];
            message.META = { ...message.META, to: user, type: 'single', users: undefined }; // Set message META property type as single so failed message to be handled by mesasge router
            publisher.send(server, message, user);
        }

    }

    async formatMessage(message) {
        const { META: meta, payload } = message;
        const parsedPayload = JSON.parse(payload);
        const { to, type, chatType, ...msg } = parsedPayload;
        msg.from = meta.from;
        msg.to = to;
        msg.type = type;
        msg.chatType = chatType
        const formattedMessage = {
            META: { to, type, chatType, ...meta, parsed: true },
            payload: JSON.stringify(msg)
        }
        return formattedMessage;
    }

    async shutdown() {
        const { publisher, listener } = this.context;
        await publisher.disconnect();
        await listener.disconnect();
    }

    async getServers(users) {
        const { events, options } = this.context;
        const client = initJsonClient(options.sessionServiceUrl)
        const request = new Promise((resolve, reject) => {
            client.send({
                func: 'get-servers',
                users
            });
            client.on('response', (data) => {
                if (data.code != 200) {
                    reject(data);
                    return;
                }
                resolve(data.result)
            });
            client.on('error', (err) => {
                reject(err);
            })
        })
        const servers = await request;
        for (const server in servers) {
            if (servers.hasOwnProperty(server)) {
                const topic = servers[server];
                if (!topic) {
                    servers[server] = events['send-message-db']
                }
            }
        }
        return servers;
    }

    async getGroupUsers(groupId, user) {
        const { options } = this.context;
        const client = initJsonClient(options.groupServiceUrl);
        const request = new Promise((resolve, reject) => {
            client.send({
                func: 'get-users',
                groupId,
                user
            });
            client.on('response', data => {
                if (data.code != 200) {
                    reject(data);
                    return;
                }
                resolve(data.result);
            });
            client.on('error', (err) => {
                reject(err);
            });
        });
        const users = await request;
        return users;
    }
}


if (asMain) {
    const argv = resolveEnvVariables(process.argv);
    const options = parseOptions(argv);
    initResources(options)
        .then(async context => {
            await new GroupMessageRouterMS(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Group Message Router MS', error);
            process.exit(1);
        })
}
