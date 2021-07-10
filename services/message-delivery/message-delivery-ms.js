const kafka = require('../../libs/kafka-utils'),
  { ServiceBase, initDefaultOptions, initDefaultResources, resolveEnvVariables } = require('../../libs/service-base'),
  { addMongodbOptions, initMongoClient } = require('../../libs/mongo-utils'),
  mongo = require('mongodb'),
  { formatMessage } = require('../../libs/message-utils'),
  fs = require('fs'),
  fetch = require('node-fetch'),
  asMain = require.main === module;

// file based static discovery service
async function initDiscoveryService(context) {
  const { options } = context;
  file = fs.readFileSync(options.serviceDiscoveryPath);
  const map = JSON.parse(file);

  const discoveryService = {
    getServiceUrl: (name) => {
      return map[name];
    }
  };

  context.discoveryService = discoveryService;
  return context;
}

async function initMemCache(context) {
  const memCache = {};
  memCache.get = function (key) {
    return memCache[key];
  };
  memCache.set = function (key, value) {
    memCache[key] = value;
  };
  memCache.remove = function (key) {
    delete memCache[key];
  };

  context.memCache = memCache;
  return context;
}

async function initDatabase(context) {
  const { mongodbClient } = context;
  const messageCollection = mongodbClient.collection('ps_message');
  const db = {};
  db.save = async function (messages) {
    messages.forEach(async (message) => {
      let payloads = [];
      if (!Array.isArray(message.payload)) {
        payloads = [message.payload];
      } else {
        payloads = message.payload;
      }
      const payloadToInsert = payloads.map((payload) => ({ _id: new mongo.ObjectID(), payload: payload, META: message.META }));
      const user = message.META.to;
      await messageCollection.updateOne(
        { user },
        {
          $push: {
            messages: { $each: payloadToInsert }
          },
          $setOnInsert: {
            user
          }
        },
        {
          upsert: true
        }
      );
    });
  };
  db.getUndeliveredMessageByUser = async function (user) {
    const user_records = await messageCollection.findOne({ user });
    return user_records ? user_records.messages : [];
  };
  db.removeMessageByUser = async function (user, messages) {
    await messageCollection.updateOne(
      { user },
      {
        $pull: {
          messages: { 'META.id': { $in: messages } }
        }
      }
    );
  };
  context.db = db;
  return context;
}

async function prepareEventListFromKafkaTopics(context) {
  const { options } = context;
  const { kafkaUserConnectionStateTopic, kafkaSendMessageTopic, kafkaOfflineMessageTopic, kafkaAckTopic } = options;
  context.events = {
    'user-connection-state': kafkaUserConnectionStateTopic,
    'send-message': kafkaSendMessageTopic,
    'offline-message': kafkaOfflineMessageTopic,
    'ack': kafkaAckTopic
  };
  context.listenerEvents = [kafkaUserConnectionStateTopic, kafkaSendMessageTopic, kafkaAckTopic];
  return context;
}

async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(initDiscoveryService)
    .then(initMemCache)
    .then(initMongoClient)
    .then(initDatabase)
    .then(prepareEventListFromKafkaTopics)
    .then(kafka.initEventListener)
    .then(kafka.initEventProducer);
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = kafka.addStandardKafkaOptions(cmd);
  cmd = addMongodbOptions(cmd);
  cmd = kafka
    .addKafkaSSLOptions(cmd)
    .option('--service-discovery-path <service-discovery-path>', 'Path to service discovery service')
    .option('--kafka-user-connection-state-topic <user-connection-state-topic>', 'Used by consumer to consume new message when a user connected/disconnected to server')
    .option('--kafka-send-message-topic <send-message-topic>', 'Used by consumer to consume new message to send to user')
    .option('--kafka-offline-message-topic <offline-message-topic>', 'Used by producer to produce new message for offline')
    .option('--kafka-ack-topic <ack-topic>', 'Used by producer to produce new message for acknowledgment')
    .option('--message-max-retries <message-max-retries>', 'Max no of retries to deliver message (default value is 3)', (value) => parseInt(value), 3);
  return cmd.parse(argv).opts();
}

class MessageDeliveryMS extends ServiceBase {
  constructor(context) {
    super(context);
    this.memCache = context.memCache;
    this.discoveryService = context.discoveryService;
    this.maxRetryCount = this.options.messageMaxRetries;
    this.db = context.db;
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
    listener.onMessage = async (event, value) => {
      switch (event) {
        case events['user-connection-state']:
          {
            const { action, user, server } = value;
            switch (action) {
              case 'connect':
                {
                  this.memCache.set(user, server);
                  this.sendPendingMessage(user);
                  this.userConnectedCounter.inc(1);
                }
                break;
              case 'disconnect': {
                const exitingServer = this.memCache.get(user);
                if (exitingServer == server) {
                  this.memCache.remove(user);
                  this.userConnectedCounter.dec(1);
                }
              }
            }
          }
          break;
        case events['send-message']:
          {
            await this.db.save(value.items);
            await this.sendMessage(value);
          }
          break;
        case events['ack']:
          {
            const { items } = value;
            this.ackMessage(items);
          }
          break;
      }
    };
  }

  ackMessage(items) {
    const map_user_message = items.reduce((mapping, msg) => {
      const user = msg.META.from;
      if (!mapping[user]) {
        mapping[user] = [];
      }
      mapping[user] = [...msg.payload.body.ids];
      return mapping;
    }, {});
    Object.entries(map_user_message).forEach(async ([user, ids]) => {
      await this.db.removeMessageByUser(user, ids);
    });
  }

  async sendMessage(value) {
    const { events, publisher } = this.context;
    const { online, offline } = await this.createMessageGroup(value);

    if (offline.length) publisher.send(events['offline-message'], offline);

    Object.keys(online).forEach(async (key) => {
      const messages = online[key];
      const url = await this.discoveryService.getServiceUrl(key);
      fetch(`${url}/send`, {
        method: 'post',
        body: JSON.stringify({ items: messages }),
        headers: { 'Content-Type': 'application/json' }
      })
        .then((res) => res.json())
        .then(({ errors }) => {
          if (!errors.length) {
            return;
          }
          this.sendMessage({ items: errors.map((x = x.messages)) });
        });
    });
  }

  async sendPendingMessage(user) {
    const messages = await this.db.getUndeliveredMessageByUser(user);
    if (!(messages && messages.length)) return;

    const payload = messages.map((m) => {
      let { _id, ...msg } = m;
      if (!msg.META) {
        msg.META = { to: message.user, parsed: true, retry: 0, saved: true };
      } else {
        msg.META.saved = this.true;
      }
      if (typeof msg.payload == typeof '') {
        msg = formatMessage(msg);
      }
      return msg;
    });
    const msgs = {
      items: payload
    };
    await this.sendMessage(msgs);
  }

  async createMessageGroup(value) {
    const { items } = value;
    const server_mapping = {};
    const user_mapping = {};
    const users = new Set();
    const offline_messages = [];
    items.forEach((message) => {
      let { to, retry = 0, saved = false } = message.META;
      // If messages is already saved don't send it to offline message again
      // even if retry count exceed
      if (retry > this.maxRetryCount && !saved) {
        offline_messages.push(message);
        return;
      }
      message.META.retry = retry++;
      const user_msgs = user_mapping[to];
      if (user_msgs) {
        user_msgs.push(message);
      } else {
        users.add(to);
        user_mapping[to] = [message];
      }
    });

    for (const u of users) {
      const server = await this.getServer(u);
      if (!server) {
        // If messages is already saved don't send it to offline message again
        const msgs = user_mapping[u].filter((m) => !m.saved);
        offline_messages.push(...msgs);
      } else {
        const item = server_mapping[server];
        if (item) {
          item.push(user_mapping[u]);
        } else {
          server_mapping[server] = [user_mapping[u]];
        }
      }
    }
    return {
      online: server_mapping,
      offline: offline_messages
    };
  }

  async shutdown() {
    const { publisher, listener } = this.context;
    await publisher.disconnect();
    await listener.disconnect();
    await this.context.mongoClient.close();
  }

  async getServer(user) {
    return this.memCache.get(user) || null;
  }
  async getUserStatus(user) {
    return user in this.memCache ? 'online' : 'offline';
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResources(options)
    .then(async (context) => {
      await new MessageDeliveryMS(context).run();
    })
    .catch(async (error) => {
      console.error('Failed to initialized Message delivery MS', error);
      process.exit(1);
    });
}
