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
        'message-sent-failed': options.kafkaMessageSentFailedTopic,
        'send-message-db': options.kafkaPersistenceMessageTopic,
        'group-message': options.kafkaGroupMessageTopic
    }
    context.events = eventName;
    context.listenerEvents = [
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
    cmd.option('--kafka-error-message-send-topic <message-send-error>', 'Used by consumer to consume new message when there is error while sending a message')
        .option('--kafka-new-message-topic <new-message-topic>', 'Used by consumer to consume new message for each new incoming message')
        .option('--kafka-message-sent-failed-topic <message-sent-failed-topic>', 'Used by producer to produce new message for message failed to sent')
        .option('--kafka-persistence-message-topic <persistence-message-topic>', 'Used by producer to produce new message to saved into a persistence db')
        .option('--kafka-group-message-topic <group-message-topic>', 'Used by producer to produce new message to handle by message router')
        .option('--message-max-retries <message-max-retries>', 'Max no of retries to deliver message (default value is 3)', (value) => parseInt(value), 3)
        .option('--session-service-url <session-service-url>', 'URL of session service')
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
        this.failedMessageMeter = this.statsClient.meter({
            name: 'failedMessage/sec',
            type: 'meter'
        });

        this.retryMessageMeter = this.statsClient.meter({
            name: 'retryMessage/sec',
            type: 'meter'
        });
    }
    init() {
        const { listener, listenerEvents, publisher, events } = this.context;
        listener.onMessage = async (topic, message) => {
            if (topic === listenerEvents['error-message-sent']) {
                message.META.retry = message.META.retry || 0;
                message.META.retry += 1;
                if (message.META.retry > this.maxRetryCount) {
                    this.failedMessageMeter.mark();
                    publisher.send(events['message-sent-failed'], message);
                    return;
                }
                this.retryMessageMeter.mark();
            }
            this.redirectMessageMeter.mark();
            await this.redirectMessage(message);
        }

    }
    async redirectMessage(message) {
        const { publisher, events } = this.context;
        if (!message.META.parsed) {
            message = await this.formatMessage(message);
        }
        const user = message.META.to;
        let receiver;
        if(message.META.type === 'group') {
            receiver = events['group-message']
        } else {
            const tracer = this.tracer.startChildSpan('getServer', 1);
            tracer.start();
            receiver = await this.getServer(user);
            tracer.end();
        }
        publisher.send(receiver, message, user);
    }

    async formatMessage(message) {
        const { META: meta, payload } = message;
        const parsedPayload = JSON.parse(payload);
        const { to, type, ...msg } = parsedPayload;
        msg.from = meta.from;
        msg.to = to;
        msg.type = type;
        const formattedMessage = {
            META: { to, type, ...meta, parsed: true },
            payload: JSON.stringify(msg)
        }
        return formattedMessage;
    }

    async shutdown() {
        const { publisher, listener } = this.context;
        await publisher.disconnect();
        await listener.disconnect();
    }

    async getServer(user) {
        const { events, options } = this.context;
        const client = initJsonClient(options.sessionServiceUrl)
        const request = new Promise((resolve, reject) => {
            client.send({
                func: 'get-server',
                user
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
        const server = await request;
        return server || events['send-message-db']; // if user is not online save the message to the db
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
