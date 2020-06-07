const kafka = require('../../libs/kafka-utils'),
    {
        ServiceBase,
        initDefaultOptions,
        initDefaultResources,
        resolveEnvVariables
    } = require('../../libs/service-base'),
    asMain = (require.main === module);

async function prepareEventListFromKafkaTopics(context) {
    const { options } = context;
    const eventName = {
        'send-message-db': options.kafkaPresistenceMessageTopic,
        'user-connected': options.kafkaUserConnectedTopic,
        'new-message': options.kafkaNewMessageTopic
    }
    context.events = eventName;
    context.listenerEvents = [
        options.kafkaUserConnectedTopic,
        options.kafkaPresistenceMessageTopic
    ]
    return context;
}
//#region DB 
async function initDatabase(context) {
    // TODO: add a real db
    const db = {}
    db.save = function (message) {
        this[message.to] = this[message.to] || [message]
    }
    db.getMessageByUser = function (user) {
        return this[user];
    }
    context.db = db;
    return context;
}

function addStandardDbOptions(cmd) {
    // TODO: add db configuration options
    return cmd;
}
//#endregion
async function initResources(options) {
    const context = await initDefaultResources(options)
        .then(prepareEventListFromKafkaTopics)
        .then(kafka.initEventProducer)
        .then(kafka.initEventListener)
        .then(initDatabase);
    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = kafka.addStandardKafkaOptions(cmd);
    cmd = kafka.addKafkaSSLOptions(cmd);
    cmd.option('--kafka-user-connected-topic', 'Used by consumer to consume new message when a user connected to server')
        .option('--kafka-persistence-message-topic', 'Used by producer to produce new message to saved into a persistence db')
        .option('--kafka-new-message-topic', 'Used by producer to produce new message for saved incoming message');
    return resolveEnvVariables(cmd.parse(argv).opts());
}

class PersistenceMessageMS extends ServiceBase {
    constructor(context) {
        super(context);
    }
    init() {
        const { listener, events } = this.context;
        listener.onMessage = (event, message) => {
            switch (event) {
                case events['send-message-db']:
                    db.save(message);
                    break;
                case events['user-connected']:
                    const messages = db.getMessageByUser(message.user);
                    publisher.send(events['new-message'], messages, message.user);
                    break;
            }
        }
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

