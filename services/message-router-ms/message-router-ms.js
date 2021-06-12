const kafka = require('../../libs/kafka-utils'),
    {
        ServiceBase,
        initDefaultOptions,
        initDefaultResources,
        resolveEnvVariables
    } = require('../../libs/service-base'),
    { getUTCEpoch } = require('../../helper')
    asMain = (require.main === module);

async function prepareEventListFromKafkaTopics(context) {
    const { options } = context;
    const eventName = {
        'new-message': options.kafkaNewMessageTopic,
        'send-message': options.kafkaSendMessageTopic,
        'group-message': options.kafkaGroupMessageTopic
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
            message = await this.formatMessage(message);
        }
        const user = message.META.to;
        let receiver;
        if (message.META.chatType === 'group') {
            receiver = events['group-message']
            publisher.send(receiver, message, user);
        } else {
            receiver = events['send-message'];
            publisher.send(receiver, { items: [message] }, user);
        }

    }

    async formatMessage(message) {
        const { META, payload } = message;
        const parsedPayload = JSON.parse(payload);
        const msg = {
            _v: parsedPayload._v || 1.0,
        };


        if (msg._v >= 2.0) {
            const { id, head, meta, body } = parsedPayload;
            head.from = META.from;
            msg.head = head;
            msg.id = id;
            msg.body = body;
            msg.body.ts = getUTCEpoch();

            Object.assign(META, meta);
            META.to = head.to;
            META.id = id;
            META.type = head.type;
            META.contentType = head.contentType

            // Add legacy keys for backward compatibility
            // TODO: remove this in next stable build
            msg.from = META.from;
            msg.to = head.to;
            msg.msgId = id;
            msg.type = head.contentType;
            msg.chatId = head.chatId; // to be deperciated, added for backward comptibility only
            msg.text = body.text;
            msg.module = head.type;
            msg.action = head.action;
            msg.chatType = head.type;

        } else {
            const { to, type, chatType, ..._msg } = parsedPayload;
            Object.assign(msg, _msg);
            msg.from = META.from;
            msg.to = to;
            msg.type = type;
            msg.chatType = chatType;

            // Add new format keys
            msg.id = msg.msgId;
            msg.head = {
                type: chatType || msg.module,
                to: to,
                from: META.from,
                chatid: msg.chatId,
                contentType: msg.type,
                action: msg.action || 'message'
            };
            msg.body = {
                text: _msg.text,
                ts: getUTCEpoch()
            };

            Object.assign(META, {
                to: to,
                id: msg.id,
                type: chatType,
                contentType: type
            })
        }

        const formattedMessage = {
            META: { ...META, parsed: true },
            payload: msg
        }
        return formattedMessage;
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
