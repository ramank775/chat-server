const { formatMessage } = require('../../libs/message-utils');

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
    mongo = require('mongodb'),
    asMain = (require.main === module);

async function prepareEventListFromKafkaTopics(context) {
    const { options } = context;
    const eventName = {
        'send-message-db': options.kafkaPersistenceMessageTopic,
        'user-connected': options.kafkaUserConnectedTopic,
        'send-message': options.kafkaSendMessageTopic
    }
    context.events = eventName;
    context.listenerEvents = [
        options.kafkaUserConnectedTopic,
        options.kafkaPersistenceMessageTopic
    ]
    return context;
}
//#region DB 
async function initDatabase(context) {
    const { mongodbClient } = context;
    const messageCollection = mongodbClient.collection("ps_message")
    const db = {}
    db.save = async function (messages) {
        messages.forEach(async (message) => {
            let payloads = []
            if (typeof message.payload != typeof []) {
                payloads = [message.payload]
            } else {
                payloads = message.payload;
            }
            const payloadToInsert = payloads.map(payload => ({ _id: new mongo.ObjectID(), payload: payload, META: message.META }))
            const user = message.META.to;
            await messageCollection.updateOne({ user }, {
                $push: {
                    messages: { $each: payloadToInsert }
                },
                $setOnInsert: {
                    user
                }
            }, {
                upsert: true
            });
        })

    }
    db.getUndeliveredMessageByUser = async function (user) {
        const user_records = await messageCollection.findOne({ user });
        return user_records ? user_records.messages : [];
    }
    db.removeMessageByUser = async function (user, messages) {
        await messageCollection.updateOne({ user }, {
            $pull: {
                messages: { _id: { $in: messages } }
            }
        });
    }
    context.db = db;
    return context;
}

//#endregion
async function initResources(options) {
    const context = await initDefaultResources(options)
        .then(prepareEventListFromKafkaTopics)
        .then(kafka.initEventProducer)
        .then(kafka.initEventListener)
        .then(initMongoClient)
        .then(initDatabase);
    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = kafka.addStandardKafkaOptions(cmd);
    cmd = kafka.addKafkaSSLOptions(cmd);
    cmd = addMongodbOptions(cmd);
    cmd.option('--kafka-user-connected-topic <user-connect-topic>', 'Used by consumer to consume new message when a user connected to server')
        .option('--kafka-persistence-message-topic <presistence-message-topic>', 'Used by producer to produce new message to saved into a persistence db')
        .option('--kafka-send-message-topic <send-message-topic>', 'Used by producer to produce new message to send message to user');
    return cmd.parse(argv).opts();
}

class PersistenceMessageMS extends ServiceBase {
    constructor(context) {
        super(context);
        this.saveMessageMeter = this.statsClient.meter({
            name: 'saveMessage/sec',
            type: 'meter'
        });
        this.sendMessageMeter = this.statsClient.meter({
            name: 'sendMessage/sec',
            type: 'meter'
        });
    }
    init() {
        const { listener, events, publisher, db, options: { appName } } = this.context;
        listener.onMessage = async (event, message) => {
            switch (event) {
                case events['send-message-db']:
                    {
                        this.saveMessageMeter.mark();
                        let messages = [];
                        if (typeof message != typeof []) {
                            messages = [message]
                        } else {
                            messages = message
                        }
                        await db.save(messages);
                    }
                    break;
                case events['user-connected']:
                    {
                        if (message.action != 'connect') return;
                        const messages = await db.getUndeliveredMessageByUser(message.user);
                        if (!(messages && messages.length)) break;

                        this.sendMessageMeter.mark();
                        const payload = messages.map(m => {
                            let { _id, ...msg } = m;
                            if (!msg.META) {
                                msg.META = { to: message.user, parsed: true, retry: 0, from: appName }
                            } else {
                                msg.META.from = appName
                            }
                            if(typeof msg.payload == typeof '') {
                                msg = formatMessage(msg);
                            }
                            return msg;
                        });
                        const sendMessage = {
                            items: payload
                        }
                        publisher.send(events['send-message'], sendMessage, message.user);
                        const messages_ids = messages.map(x => x._id);
                        await db.removeMessageByUser(message.user, messages_ids);
                    }
                    break;
            }
        }
    }

    async shutdown() {
        const { listener, publisher } = this.context;
        await publisher.disconnect();
        await listener.disconnect();
    }
}


if (asMain) {
    const argv = resolveEnvVariables(process.argv);
    const options = parseOptions(argv);
    initResources(options)
        .then(async context => {
            await new PersistenceMessageMS(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Persistence Message MS', error);
            process.exit(1);
        })
}

