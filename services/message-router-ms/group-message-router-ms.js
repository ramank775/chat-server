const kafka = require('../../libs/kafka-utils'),
    {
        ServiceBase,
        initDefaultOptions,
        initDefaultResources,
        resolveEnvVariables
    } = require('../../libs/service-base'),
    {
        addMongodbOptions,
        initMongoClient
    } = require('../../libs/mongo-utils'),
    asMain = (require.main === module);

async function prepareEventListFromKafkaTopics(context) {
    const { options } = context;
    const eventName = {
        'send-message': options.kafkaSendMessageTopic
    }
    context.events = eventName;
    context.listenerEvents = [
        options.kafkaNewGroupMessageTopic,
    ]
    return context;
}

async function initResources(options) {
    const context = await initDefaultResources(options)
        .then(initMongoClient)
        .then(prepareEventListFromKafkaTopics)
        .then(kafka.initEventProducer)
        .then(kafka.initEventListener)
    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = kafka.addStandardKafkaOptions(cmd);
    cmd = kafka.addKafkaSSLOptions(cmd);
    cmd = addMongodbOptions(cmd);
    cmd.option('--kafka-new-group-message-topic <new-group-message-topic>', 'Used by consumer to consume new group message for each new incoming message')
        .option('--kafka-send-message-topic <send-message-topic>', 'Used by producer to produce new message to send message to user')

    return cmd.parse(argv).opts();
}

class GroupMessageRouterMS extends ServiceBase {
    constructor(context) {
        super(context);
        this.mongoClient = context.mongoClient;
        this.groupCollection = context.mongodbClient.collection('groups');
    }
    init() {
        const { listener } = this.context;
        listener.onMessage = async (_, message) => {
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
        const messages = []
        for (let user of users) {
            if (typeof user === "object") {
                user = user.username;
            }
            // Set message META property type as single so failed message to be handled by mesasge router
            message.META = { ...message.META, to: user, type: 'single', users: undefined };
            messages.push(message)
        }
        publisher.send(server, { items: messages });
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
        await this.context.mongoClient.close();
    }

    async getGroupUsers(groupId, user) {
        const { groupId, user } = message;
        const group = await this.groupCollection.findOne({ groupId, 'members.username': user });
        const users = group.members.map(x => x.username);
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
