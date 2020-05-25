const kafka = require('../../libs/kafka-utils'),
    {
        ServiceBase,
        initDefaultOptions,
        initDefaultResources
    } = require('../../libs/service-base'),
    asMain = (require.main === module);

async function prepareEventListFromKafkaTopics(context) {
    const { options } = context;
    const eventName = {
        'message-sent-failed': options.kafkaMessageSendFailedTopic,
        'send-message-db': options.kafkaPresistenceMessageTopic
    }
    context.events = eventName;
    constext.listenerEvents = [
        options.kafkaNewMessageTopic,
        options.kafkaErrorMessageSendTopic
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
    cmd.option('--kafka-error-message-send-topic', 'Used by consumer to consume new message when there is error while sending a message')
        .option('--kafka-new-message-topic', 'Used by consumer to consume new message for each new incoming message')
        .option('--kafka-message-sent-failed-topic', 'Used by producer to produce new message for message failed to sent')
        .option('--kafka-persistence-message-topic', 'Used by producer to produce new message to saved into a persistence db')
        .option('--message-max-retries', 'Max no of retries to deliver message (default value is 3)', (value) => parseInt(value), 3)
        .option('--session-service-url', 'URL of session service')
    return cmd.parse(argv).opts();
}

class MessageRouterMS extends ServiceBase {
    constructor(context) {
        super(context);
        this.maxRetryCount = this.options.messageMaxRetries;
    }
    init() {
        const { listener, listenerEvents, producers, events } = this.context;
        listener.onMessage = (topic, message) => {
            if (topic === listenerEvents['error-message-sent']) {
                message.retry = message.retry || 0;
                message.retry += 1;
                if (message.retry > this.maxRetryCount) {
                    producers.send(events['message-sent-failed'], message);
                    return;
                }
            }
            redirectMessage(message.to, message);
        }

    }
    redirectMessage(user, message) {
        const { producers } = this.context;
        const server = getServer(user);
        producers.send(server, message)
    }

    getServer(user) {
        const { events } = this.context;
        // TODO: call session service and get server user connected to
        const server = ''
        return server || events['send-message-db']; // if user is not online save the message to the db
    }
}


if (asMain) {
    const options = parseOptions(process.argv);
    initResources(options)
        .then(async context => {
            await new MessageRouterMS(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Message Router MS', error);
            process.exit(1);
        })
}
