const {
    initDefaultOptions,
    initDefaultResources,
    addStandardHttpOptions,
    resolveEnvVariables
} = require('../../libs/service-base'),
    {
        HttpServiceBase
    } = require('../../libs/http-service-base'),
    kafka = require('../../libs/kafka-utils'),
    { extractInfoFromRequest } = require('../../helper'),
    asMain = (require.main === module);


async function prepareListEventFromKafkaTopic(context) {
    const { options } = context;
    const eventName = {
        'new-message': options.kafkaNewMessageTopic,
        'message-sent': options.kafkaMessageSentTopic,
    }
    context.events = eventName;
    context.listenerEvents = [options.gatewayName]
    return context;
}

async function initResources(options) {
    const context = await initDefaultResources(options)
        .then(prepareListEventFromKafkaTopic)
        .then(kafka.initEventProducer);
    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = addStandardHttpOptions(cmd);
    cmd = kafka.addStandardKafkaOptions(cmd);
    cmd = kafka.addKafkaSSLOptions(cmd);
    cmd.option('--gateway-name <app-name>', 'Used as gateway server idenitifer for the user connected to this server, as well as the kafka topic for send message')
        .option('--kafka-message-sent-topic <message-sent-topic>', 'Used by producer to produce new message for successfuly sent message')
        .option('--kafka-new-message-topic <new-message-topic>', 'Used by producer to produce new message for each new incoming message');
    return cmd.parse(argv).opts();
}

class HttGateway extends HttpServiceBase {
    constructor(context) {
        super(context);
        const publisher = this.context.publisher;
        const { events } = this.context;
        const publishEvent = (event, user, eventArgs) => {
            publisher.send(event, eventArgs, user)
        }

        this.messageEvents = {
            onNewMessage: function (message) {
                newMessageMeter.mark();
                publishEvent(events['new-message'], message.META.from, message)
            },
            onMessageSent: function (message) {
                messageDeliverySuccessfulMeter.mark();
                publishEvent(events['message-sent'], message.META.from, message)
            }
        }
    }

    async init() {
        await super.init();

        this.addRoute('/message', ['POST'], async(req, res) => {
            const user = extractInfoFromRequest(req, 'user');
            const payload = req.payload;
            this.messageEvents.onNewMessage({
                payload: JSON.stringify(payload),
                META: {
                    from: user
                }
            });
        });

        this.addRoute('/message/reciept', ['POST'], async(req, res) => {
            const user = extractInfoFromRequest(req, 'user');
            const payload = JSON.stringify(req.payload);
            this.messageEvents.onMessageSent({
                META: {
                    from : user
                },
                payload: payload
            });
        });
    }
}


if (asMain) {
    const argv = resolveEnvVariables(process.argv);
    const options = parseOptions(argv);
    initResources(options)
        .then(async context => {
            await new HttGateway(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Http Gateway server', error);
            process.exit(1);
        })
}
