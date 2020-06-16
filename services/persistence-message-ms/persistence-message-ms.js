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
        'send-message-db': options.kafkaPersistenceMessageTopic,
        'user-connected': options.kafkaUserConnectedTopic,
        'new-message': options.kafkaNewMessageTopic
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
    db.save = async function (message) {
        const user = message.to;
        delete message.to;
        await messageCollection.update({ user }, {
            $push: {
                messages: { ...message }
            },
            $setOnInsert: {
                user
            }
        }, {
            upsert: true
        });
    }
    db.getUndeliveredMessageByUser = async function (user) {
        const user_records = await messageCollection.findOne({ user });
        return user_records?user_records.messages: [];
    }
    db.removeMessageByUser = async function (user, messages) {
        const messages_ids = messages.map(x => x._id);
        await messageCollection.update({ user }, {
            $pull: {
                "messages._id": { $in: messages_ids }
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
        .option('--kafka-new-message-topic <new-message-topic>', 'Used by producer to produce new message for saved incoming message');
    return resolveEnvVariables(cmd.parse(argv).opts());
}

class PersistenceMessageMS extends ServiceBase {
    constructor(context) {
        super(context);
    }
    init() {
        const { listener, events, publisher, db } = this.context;
        listener.onMessage = async (event, message) => {
            switch (event) {
                case events['send-message-db']:
                    await db.save(message);
                    break;
                case events['user-connected']:
                    const messages = await db.getUndeliveredMessageByUser(message.user);
                    if (!(messages && messages.length)) break;
                    // remove the unncessary keys which are not intented to be shared with user
                    const messagesToSend = messages.map(x => {
                        const { _id, to, ...y } = x;
                        return y;
                    });
                    const sendMessage = {
                        to: message.user,
                        messages: messagesToSend
                    }
                    publisher.send(events['new-message'], sendMessage, message.user);
                    await db.removeMessageByUser(message.user, messages);
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
    const options = parseOptions(process.argv);
    initResources(options)
        .then(async context => {
            await new PersistenceMessageMS(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Persistence Message MS', error);
            process.exit(1);
        })
}

