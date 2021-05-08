const
    kafka = require('../../libs/kafka-utils'),
    {
        ServiceBase,
        initDefaultOptions,
        initDefaultResources,
        resolveEnvVariables
    } = require('../../libs/service-base'),
    fs = require('fs'),
    fetch = require('node-fetch');
asMain = (require.main === module);

// file based static discovery service
async function initDiscoveryService(context) {
    const { options } = context;
    file = fs.readFileSync(options.serviceDiscoveryPath);
    const map = JSON.parse(file);

    const discoveryService = {
        getServiceUrl: (name) => {
            return map[name]
        }
    }

    context.discoveryService = discoveryService;
    return context;
}

async function initMemCache(context) {
    const memCache = {};
    memCache.get = function (key) {
        return memCache[key]
    }
    memCache.set = function (key, value) {
        memCache[key] = value
    }
    memCache.remove = function (key) {
        delete memCache[key]
    }

    context.memCache = memCache
    return context;
}

async function prepareEventListFromKafkaTopics(context) {
    const { options } = context;
    const { kafkaUserConnectedTopic, kafkaUserDisconnectedTopic, kafkaSendMessageTopic } = options;
    context.events = {
        'user-connected': kafkaUserConnectedTopic,
        'user-disconnected': kafkaUserDisconnectedTopic,
        'send-message': kafkaSendMessageTopic,
        'offline-message': options.kafkaPersistenceMessageTopic,
    }
    context.listenerEvents = [kafkaUserConnectedTopic, kafkaUserDisconnectedTopic, kafkaSendMessageTopic]
    return context;
}

async function initResources(options) {
    const context = await initDefaultResources(options)
        .then(initDiscoveryService)
        .then(initMemCache)
        .then(prepareEventListFromKafkaTopics)
        .then(kafka.initEventListener)
        .then(kafka.initEventProducer);
    return context;
}

function parseOptions(argv) {
    let cmd = initDefaultOptions();
    cmd = kafka.addStandardKafkaOptions(cmd);
    cmd = kafka.addKafkaSSLOptions(cmd)
        .option('--service-discovery-path <service-discovery-path>', 'Path to service discovery service')
        .option('--kafka-user-connected-topic <new-user-topic>', 'Used by consumer to consume new message when a user connected to server')
        .option('--kafka-user-disconnected-topic <user-disconnected-topic>', 'Used by consumer to consume new message when a user disconnected from the server')
        .option('--kafka-send-message-topic <send-message-topic>', 'Used by consumer to consume new message to send to user')
        .option('--kafka-persistence-message-topic <persistence-message-topic>', 'Used by producer to produce new message to saved into a persistence db')
        .option('--message-max-retries <message-max-retries>', 'Max no of retries to deliver message (default value is 3)', (value) => parseInt(value), 3);
    return cmd.parse(argv).opts();
}

class SessionMS extends ServiceBase {
    constructor(context) {
        super(context);
        this.memCache = context.memCache;
        this.discoveryService = context.discoveryService;
        this.maxRetryCount = this.options.messageMaxRetries;
        this.userConnectedCounter = this.statsClient.counter({
            name: 'userconnected'
        });
        this.getServerMeter = this.statsClient.meter({
            name: 'getServer/sec',
            type: 'meter'
        });
    }
    init() {
        const { listener, events } = this.context;
        listener.onMessage = (event, value) => {
            switch (event) {
                case events['user-connected']: {
                    this.memCache.set(value.user, value.server)
                    this.userConnectedCounter.inc(1);
                }
                    break;
                case events['user-disconnected']: {
                    const server = this.memCache.get(value.user)
                    if (server == value.server) {
                        this.memCache.remove(value.user);
                        this.userConnectedCounter.dec(1);
                    }
                }
                    break;
                case events['send-message']: {
                    await this.sendMessage(value);
                }
            }
        };
    }

    async sendMessage(value) {
        const { events, publisher } = this.context;
        const { online, offline } = await this.createMessageGroup(value);

        if (offline.length)
            publisher.send(events['offline-message'], offline);

        Object.keys(online).forEach(async (key) => {
            const messages = online[key];
            let url = await this.discoveryService.getServiceUrl(key);
            fetch(url, {
                method: 'post',
                body: JSON.stringify({ items: messages }),
                headers: { 'Content-Type': 'application/json' },
            })
                .then(res => res.json())
                .then(({ errors }) => {
                    if (!errors.length) {
                        return;
                    }
                    this.sendMessage({ items: errors.map(x = x.message) })
                });
        });
    }

    async createMessageGroup(value) {
        const { items } = value;
        const server_mapping = {};
        const user_mapping = {};
        const users = new Set();
        const dbMessages = [];
        items.forEach((message) => {
            const { to, retry = -1 } = message.META;
            if (retry > this.maxRetryCount) {
                dbMessages.push(message);
                return;
            }
            const user_msgs = user_mapping[to];
            if (user_msgs) {
                user_msgs.payload.push(message.payload);
            } else {
                users.add(to);
                retry++;
                user_mapping[to] = {
                    META: { to, retry },
                    payload: [message.payload]
                };
            }
        });


        for (const u of users) {
            const server = await this.getServer(u);
            if (!server) {
                dbMessages.push(user_mapping[u]);
            } else {
                const item = server_mapping[server];
                if (item) {
                    item.push(user_mapping[u]);
                } else {
                    server_mapping[server].push(user_mapping[u]);
                }
            }
        }
        return {
            online: server_mapping,
            offline: dbMessages
        }
    }

    async shutdown() {
        const { publisher, listener } = this.context;
        await publisher.disconnect();
        await listener.disconnect();
    }

    async getServer(user) {
        return this.memCache.get(user) || null;
    }
    async getUserStatus(user) {
        return (user in this.memCache) ? 'online' : 'offline';
    }
}

if (asMain) {
    const argv = resolveEnvVariables(process.argv);
    const options = parseOptions(argv);
    initResources(options)
        .then(async context => {
            await new SessionMS(context).run()
        }).catch(async error => {
            console.error('Failed to initialized Session MS', error);
            process.exit(1);
        })
}
