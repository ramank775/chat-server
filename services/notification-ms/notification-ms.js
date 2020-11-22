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
    admin = require('firebase-admin'),
    asMain = (require.main === module);

async function prepareEventListFromKafkaTopics(context) {
    const { options } = context;
    const eventName = {
        'push-notification': options.kafkaOfflineMessageTopic,
        'new-login': options.kafkaNewLoginTopic
    }
    context.events = eventName;
    context.listenerEvents = [
        options.kafkaOfflineMessageTopic,
        options.kafkaNewLoginTopic
    ]
    return context;
}

async function initFirebaseAdmin(context) {
    const { options } = context;
    const { firebaseAdminCredentialJsonPath } = options;
    const serviceAccount = require(firebaseAdminCredentialJsonPath);
    const app = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
    context.firebaseApp = app;
    context.firebaseMessaging = app.messaging();
    return context;
}


async function initResources(options) {
    const context = await initDefaultResources(options)
        .then(prepareEventListFromKafkaTopics)
        .then(kafka.initEventListener)
        .then(initMongoClient)
        .then(initFirebaseAdmin);
    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = kafka.addStandardKafkaOptions(cmd);
    cmd = kafka.addKafkaSSLOptions(cmd);
    cmd = addMongodbOptions(cmd);
    cmd.option('--kafka-offline-message-topic <offline-message-topic>', 'Used by producer to produce new message to send the push notification')
    cmd.option('--kafka-new-login-topic <new-login-topic>', 'New login kafka topic')
    cmd.option('--firebase-admin-credential-json-path <firebaes-admin-cred-file>', 'Path to the firebase admin credentials file')
    cmd.option('--db-app-initial <db-app-initial>', 'Initial of db apps', 'persistence-message')
    return cmd.parse(argv).opts();
}

class NotificationMS extends ServiceBase {
    constructor(context) {
        super(context);
        this.mongoClient = context.mongoClient;
        this.notificationTokensCollection = context.mongodbClient.collection('notification_tokens');
        this.firebaseMessaging = context.firebaseMessaging;
        
        this.notificationMeter = this.statsClient.meter({
            name: 'notificationMeter/sec',
            type: 'meter'
        });

        this.failedNotificationMeter = this.statsClient.meter({
            name: 'failedNotification/sec',
            type: 'meter'
        });
    }
    init() {
        const { listener, events, options: { dbAppInitial } } = this.context;
        listener.onMessage = async (event, message) => {
            switch (event) {
                case events['new-login']:
                    {
                        const { username, notificationToken } = message;
                        await this.notificationTokensCollection.updateOne({ username }, {
                            $set: {
                                notificationToken
                            },
                            $setOnInsert: {
                                username
                            }
                        }, {
                            upsert: true
                        });
                    }
                    break;
                case events['push-notification']:
                    {
                        const { to, from } = message.META;
                        if (from && from.startsWith(dbAppInitial)) return;
                        const payload = JSON.parse(message.payload);
                        if (payload.type == 'notification') return;
                        const record = await this.notificationTokensCollection.findOne({ username: to }, { projection: { _id: 0, notificationToken: 1 } });
                        if (record) {
                            this.notificationMeter.mark();
                            const { notificationToken } = record;
                            const chatPayload = {
                                data: {
                                    message: message.payload
                                }
                            };
                            const options = {
                                priority: "high",
                                timeToLive: 60 * 60 * 24
                            };
                            this.firebaseMessaging.sendToDevice(notificationToken, chatPayload, options).catch(err => {
                                this.failedNotificationMeter.mark();
                                this.log.error(`Error while sending push notification ${err}`, err);
                            });
                            
                            // This is to keep the backward compatibility before build 1.0.0+18 will be remove in future
                            const notification = {
                                notification: {
                                    title: "New Message",
                                    body: payload.text.length > 30 ? payload.text.substring(0, 25) + '...' : payload.text
                                },
                                data: {
                                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                                }
                            };
                             this.firebaseMessaging.sendToDevice(notificationToken, notification, options).catch(err => {
                                this.log.error(`Error while sending push notification ${err}`, err);
                            });

                        }
                    }
                    break;
            }
        }
    }

    async shutdown() {
        const { listener } = this.context;
        await listener.disconnect();
        await this.context.mongoClient.close()
    }
}


if (asMain) {
    const argv = resolveEnvVariables(process.argv);
    const options = parseOptions(argv);
    initResources(options)
        .then(async context => {
            await new NotificationMS(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Notification MS', error);
            process.exit(1);
        })
}

