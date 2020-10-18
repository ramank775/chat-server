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
    { uuidv4 } = require('../../helper'),
    io = require('@pm2/io').init({ tracing: true }),
    asMain = (require.main === module)

async function initWebsocket(context) {
    const tracker = io.getTracer();
    const upgradeMeter = io.meter({
        name: 'upgradeSocket/sec',
        type: 'meter'
    });
    const { httpServer } = context;
    
    const wss = new webSocker.Server({ noServer: true });
    httpServer.on('upgrade', (request, socket, head) => {
        const upgradeTracker = tracker.startChildSpan('upgradeRequest', 1);
        upgradeTracker.start();
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
            upgradeMeter.mark();
            upgradeTracker.end();
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
    return cmd.parse(argv).opts();
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
        const userConnectedCounter = io.counter({
            name: 'userConnected'
        });
        this.userEvents = {
            onConnect: function (user) {
                userConnectedCounter.inc(1);
                publishEvent(events['user-connected'], user, {
                    user: user,
                    server: serverName
                })
            },
            onDisconnect: function (user) {
                userConnectedCounter.dec(1);
                publishEvent(events['user-disconnected'], user, {
                    user: user,
                    server: serverName
                })
            }
        }

        const newMessageMeter = io.meter({
            name: 'newMessage/sec',
            type: 'meter'
        });

        const messageDeliverySuccessfulMeter = io.meter({
            name: 'messageDeliverySuccessful/sec',
            type: 'meter'
        });

        const messageDeliveryFailureMeter = io.meter({
            name: 'messageDeliveryFailure/sec',
            type: 'meter'
        });

        this.messageEvents = {
            onNewMessage: function (message) {
                newMessageMeter.mark();
                publishEvent(events['new-message'], message.META.from, message)
            },
            onMessageSent: function (message) {
                messageDeliverySuccessfulMeter.mark();
                publishEvent(events['message-sent'], message.META.from, message)
            },
            onMessageSentFailed: function (message, err) {
                messageDeliveryFailureMeter.mark();
                publishEvent(events['error-message-sent'], message.META.from, {
                    message: message,
                    error: err
                });
            }
        }
        this.userSocketMapping = {}
        this.pingTimer;
    }
    init() {
        const { wss, listener } = this.context;
        const { userEvents, messageEvents, userSocketMapping } = this;
        wss.on('connection', (ws, request) => {
            const user = this.getUserInfoFromRequest(request);
            userSocketMapping[user] = ws;
            ws.user = user;
            userEvents.onConnect(user);
            ws.on('message', function (msg) {
                const message = {
                    payload: msg,
                    META: {
                        from: this.user
                    }
                };
                messageEvents.onNewMessage(message);
            });
            ws.on('close', function (code, reason) {
                userEvents.onDisconnect(this.user);
                delete userSocketMapping[this.user];
            })
        });
        listener.onMessage = (topic, message) => {
            const ws = userSocketMapping[message.META.to];
            if (ws) {
                const payload = message.payload;
                ws.send(payload);
                messageEvents.onMessageSent(message);
                return;
            } else {
                messageEvents.onMessageSentFailed(message, {
                    code: -1,
                    reason: 'user socket not found'
                });
            }
        };
        this.enablePing();
    }

    enablePing() {
        const { userSocketMapping } = this;
        this.pingTimer = setInterval(() => {
            Object.keys(userSocketMapping).forEach(user => {
                userSocketMapping[user].ping();
            });
        }, (50 * 1000));
    }

    disablePing() {
        clearInterval(this.pingTimer);
    }

    async shutdown() {
        const { publisher, listener } = this.context;
        publisher.disconnect();
        listener.disconnect();
        this.disablePing();

    }

    getUserInfoFromRequest(request) {
        let user = request.headers.user;
        if(user) return user;
        const rc = request.headers.cookie;
        const cookies = {};
        rc & rc.split(';').forEach((cookie) => {
            var parts = cookie.split('=');
            cookies[parts.shift().trim()] = decodeURI(parts.join('='));
        })
        return cookies['user'] || uuidv4();
    }
}

if (asMain) {
    const argv = resolveEnvVariables(process.argv);
    const options = parseOptions(argv);
    initResources(options)
        .then(async context => {
            await new Gateway(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Gateway server', error);
            process.exit(1);
        })
}