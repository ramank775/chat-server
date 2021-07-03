const kafka = require('../../libs/kafka-utils'),
    {
        ServiceBase,
        initDefaultOptions,
        initDefaultResources,
        resolveEnvVariables
    } = require('../../libs/service-base'),
    { formatMessage } = require('../../libs/message-utils'),
    asMain = (require.main === module);

async function prepareEventListFromKafkaTopics(context) {
    const { options } = context;
    const eventName = {
        'new-message': options.kafkaNewMessageTopic,
        'send-message': options.kafkaSendMessageTopic,
        'group-message': options.kafkaGroupMessageTopic,
        'ack': options.kafkaAckTopic
    }
    context.events = eventName;
    context.listenerEvents = [
        options.kafkaNewMessageTopic
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
    cmd.option('--kafka-new-message-topic <new-message-topic>', 'Used by consumer to consume new message for each new incoming message')
        .option('--kafka-group-message-topic <group-message-topic>', 'Used by producer to produce new message to handle by message router')
        .option('--kafka-send-message-topic <send-message-topic>', 'Used by producer to produce new message to send message to user')
        .option('--kafka-ack-topic <ack-topic>', 'Used by producer to produce new message for acknowledgment')
    return cmd.parse(argv).opts();
}

class MessageRouterMS extends ServiceBase {
    constructor(context) {
        super(context);
        this.maxRetryCount = this.options.messageMaxRetries;
        this.redirectMessageMeter = this.statsClient.meter({
            name: 'redirectMessage/sec',
            type: 'meter'
        });
    }
    init() {
        const { listener } = this.context;
        listener.onMessage = async (_, message) => {
            this.redirectMessageMeter.mark();
            await this.redirectMessage(message);
        }

    }
    async redirectMessage(message) {
        const { publisher, events } = this.context;
        if (!message.META.parsed) {
            message = formatMessage(message);
        }
        const user = message.META.to;

        if (message.META.type === 'ack') {
            const receiver = events['ack']
            publisher.send(receiver, { items: [message] }, message.head.from)
        } else if (message.META.type === 'group') {
            const receiver = events['group-message']
            publisher.send(receiver, message, user);
        } else {
            const receiver = events['send-message'];
            publisher.send(receiver, { items: [message] }, user);
        }
    }

    async shutdown() {
        const { publisher, listener } = this.context;
        await publisher.disconnect();
        await listener.disconnect();
    }

}


if (asMain) {
    const argv = resolveEnvVariables(process.argv);
    const options = parseOptions(argv);
    initResources(options)
        .then(async context => {
            await new MessageRouterMS(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Message Router MS', error);
            process.exit(1);
        })
}
