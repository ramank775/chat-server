const
    webSocker = require('ws'),
    {
        ServiceBase,
        addStandardHttpOptions,
        initDefaultOptions,
        initHttpServer,
        initDefaultResources,
        resolveEnvVariables } = require('../../libs/service-base'),
    kafka = require('../../libs/kafka-utils'),
    asMain = (require.main === module)

async function initWebsocket(context) {
    const { httpServer } = context;

    const wss = new webSocker.Server({ noServer: true });
    httpServer.on('upgrade', (request, socket, head) => {
        console.log('upgrade request')
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });
    context.wss = wss;
    return context;
}

async function prepareListEventFromKafkaTopic(context) {
    const { options } = context;
    const eventName = {
        'user-connected': options.kafkaUserConnectedTopic,
        'user-disconnected': options.kafkaUserDisconnectedTopic,
        'new-message': options.kafkaNewMessageTopic,
        'message-sent': options.kafkaMessageSentTopic,
        'error-message-send': options.kafkaErrorMessageSendTopic
    }
    context.events = eventName;
    context.listenerEvents = [options.gatewayName]
    return context;
}
async function initResources(options) {
    const context = await initDefaultResources(options)
        .then(initHttpServer)
        .then(initWebsocket)
        .then(prepareListEventFromKafkaTopic)
        .then(kafka.initEventProducer)
        .then(kafka.initEventListener);

    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = addStandardHttpOptions(cmd);
    cmd = kafka.addStandardKafkaOptions(cmd);
    cmd = kafka.addKafkaSSLOptions(cmd);
    cmd.option('--gateway-name <app-name>', 'Used as gateway server idenitifer for the user connected to this server, as well as the kafka topic for send message')
        .option('--kafka-user-connected-topic <new-user-topic>', 'Used by producer to produce new message when a user connected to server')
        .option('--kafka-user-disconnected-topic <user-disconnected-topic>', 'Used by producer to produce new message when a user disconnected from the server')
        .option('--kafka-message-sent-topic <message-sent-topic>', 'Used by producer to produce new message for successfuly sent message')
        .option('--kafka-error-message-send-topic <message-sent-error-topic>', 'Used by producer to produce new message when there is error while sending a message')
        .option('--kafka-new-message-topic <new-message-topic>', 'Used by producer to produce new message for each new incoming message');
    return resolveEnvVariables(cmd.parse(argv).opts());
}

class Gateway extends ServiceBase {
    constructor(context) {
        super(context);
        const publisher = this.context.publisher;
        const { events } = this.context;
        const serverName = this.options.gatewayName;
        const publishEvent = (event, user, eventArgs) => {
            publisher.send(event, eventArgs, user)
        }
        this.userEvents = {
            onConnect: function (user) {
                publishEvent(events['user-connected'], user, {
                    user: user,
                    server: serverName
                })
            },
            onDisconnect: function (user) {
                publishEvent(events['user-disconnected'], user, {
                    user: user,
                    server: serverName
                })
            }
        }
        this.messageEvents = {
            onNewMessage: function (message) {
                publishEvent(events['new-message'], message.from, message)
            },
            onMessageSent: function (message) {
                publishEvent(events['message-sent'], message.from, message)
            },
            onMessageSentFailed: function (message, err) {
                publishEvent(events['error-message-sent'], message.from, {
                    message: message,
                    error: err
                });
            }
        }
        this.userSockerMapping = {}
    }
    init() {
        const { wss, listener } = this.context;
        const { userEvents, messageEvents, userSockerMapping } = this;
        wss.on('connection', (ws, request) => {
            const user = this.getUserInfoFromRequest(request);
            userSockerMapping[user] = ws;
            ws.user = user;
            userEvents.onConnect(user);
            ws.on('message', function (msg) {
                const message = JSON.parse(msg);
                message.from = this.user;
                messageEvents.onNewMessage(message);
            });
            ws.on('close', function (code, reason) {
                userEvents.onDisconnect(this.user);
                delete userSockerMapping[this.user];
            })
        });
        listener.onMessage = (topic, message) => {
            const msg = message;
            const ws = userSockerMapping[msg.from];
            if (ws) {
                ws.send(msg);
                Message.onMessageSent(message);
                return;
            } else {
                Message.onMessageSentFailed(message, {
                    code: -1,
                    reason: 'user socket not found'
                });
            }
        };
    }

    getUserInfoFromRequest(request) {
        const rc = request.headers.cookie;
        const cookies = {};
        rc & rc.split(';').forEach((cookie) => {
            var parts = cookie.split('=');
            cookies[parts.shift().trim()] = decodeURI(parts.join('='));
        })
        return cookies['user-id'] || this.uuidv4();
    }

    uuidv4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
}

if (asMain) {
    const options = parseOptions(process.argv);
    initResources(options)
        .then(async context => {
            await new Gateway(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Gateway server', error);
            process.exit(1);
        })
}