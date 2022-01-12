const { shortuuid } = require('../../helper');

const kafka = require('../../libs/kafka-utils'),
  {
    ServiceBase,
    initDefaultOptions,
    initDefaultResources,
    resolveEnvVariables
  } = require('../../libs/service-base'),
  fetch = require('node-fetch'),
  cache = require('../../libs/cache-utils'),
  disoveryService = require('../../libs/discovery-service-utils'),
  database = require('./database'),
  asMain = require.main === module;

async function prepareEventListFromKafkaTopics(context) {
  const { options } = context;
  const {
    kafkaUserConnectionStateTopic,
    kafkaSendMessageTopic,
    kafkaOfflineMessageTopic,
    kafkaAckTopic
  } = options;
  context.events = {
    'user-connection-state': kafkaUserConnectionStateTopic,
    'send-message': kafkaSendMessageTopic,
    'offline-message': kafkaOfflineMessageTopic,
    ack: kafkaAckTopic
  };
  context.listenerEvents = [kafkaUserConnectionStateTopic, kafkaSendMessageTopic, kafkaAckTopic];
  return context;
}

async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(cache.initMemCache)
    .then(database.initDatabase)
    .then(prepareEventListFromKafkaTopics)
    .then(disoveryService.initDiscoveryService)
    .then(kafka.initEventListener)
    .then(kafka.initEventProducer);
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = kafka.addStandardKafkaOptions(cmd);
  cmd = database.addDatabaseOptions(cmd);
  cmd = disoveryService.addDiscoveryServiceOptions(cmd);
  cmd = cache.addMemCacheOptions(cmd);
  cmd = kafka
    .addKafkaSSLOptions(cmd)
    .option(
      '--kafka-user-connection-state-topic <user-connection-state-topic>',
      'Used by consumer to consume new message when a user connected/disconnected to server'
    )
    .option(
      '--kafka-send-message-topic <send-message-topic>',
      'Used by consumer to consume new message to send to user'
    )
    .option(
      '--kafka-offline-message-topic <offline-message-topic>',
      'Used by producer to produce new message for offline'
    )
    .option(
      '--kafka-ack-topic <ack-topic>',
      'Used by producer to produce new message for acknowledgment'
    )
    .option(
      '--message-max-retries <message-max-retries>',
      'Max no of retries to deliver message (default value is 3)',
      (value) => parseInt(value),
      3
    );
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
                this.onConnect(user, server);
                break;
              case 'disconnect': {
                this.onDisconnect(user, server);
              }
            }
          }
          break;
        case events['send-message']:
          this.onMessage(value);
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

  async onConnect(user, server) {
    await this.memCache.set(user, server);
    this.sendPendingMessage(user);
    this.userConnectedCounter.inc(1);
  }

  async onDisconnect(user, server) {
    const exitingServer = await this.memCache.get(user);
    if (exitingServer == server) {
      await this.memCache.del(user);
      this.userConnectedCounter.dec(1);
    }
  }

  async onMessage(value) {
    this.db.save(value.items);
    await this.sendMessage(value);
  }

  ackMessage(items) {
    const state_ack_msgs = items.filter(msg => msg.META.action === 'state')
    this.onMessage({items: state_ack_msgs})
    const map_user_message = items.reduce((mapping, msg) => {
      const user = msg.META.from;
      if (!mapping[user]) {
        mapping[user] = [];
      }
      mapping[user].push(...msg.payload.body.ids);
      return mapping;
    }, {});
    Object.entries(map_user_message).forEach(async ([user, ids]) => {
      await this.db.markMessageDeliveredByUser(user, ids);
    });
  }

  async sendMessage(value) {
    const { asyncStorage } = this.context;
    const track_id = asyncStorage.getStore() || shortuuid()
    const { online, offline } = await this.createMessageGroup(value);

    if (offline.length) this.sendOfflineMessage(offline);

    Object.keys(online).forEach(async (key) => {
      const messages = online[key];
      const url = await this.discoveryService.getServiceUrl(key);
      fetch(`${url}/send`, {
        method: 'post',
        body: JSON.stringify({ items: messages }),
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': track_id
        }
      })
        .then((res) => res.json())
        .then(({ errors }) => {
          const failed_messages = errors.map((x) => x.messages);
          // HACK: until client implements the proper ack and
          // server has rest endpoint for message sync and ack
          // remove successfully sent messages
          this.markMessagesAsSent(messages, failed_messages);
          if (!errors.length) {
            return;
          }
          this.sendMessage({ items: failed_messages.flat() });
        })
        .catch((e) => {
          this.log.error('Error while sending messages', e);
        });
    });
  }

  async sendOfflineMessage(messages) {
    const { events, publisher } = this.context;
    publisher.send(events['offline-message'], messages);
  }

  async sendPendingMessage(user) {
    const messages = await this.db.getUndeliveredMessageByUser(user);
    if (!(messages && messages.length)) return;
    this.log.info(`Processing pending message for ${user}, length : ${messages.length}`);

    const payload = messages.map((m) => {
      let { _id: _, ...msg } = m;
      msg.META.saved = true;
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
      let { to, retry = -1, saved = false } = message.META;
      // If messages is already saved don't send it to offline message again
      // even if retry count exceed
      if (retry > this.maxRetryCount && !saved) {
        offline_messages.push(message);
        return;
      }
      message.META.retry = ++retry;
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

  async markMessagesAsSent(messages, failed_messages) {
    const flatten_failed_msgs = failed_messages.reduce((acc, item) => {
      if (!item || !(item && item.length)) return acc;
      const user = item[0].META.to;
      acc[user] = item.reduce((acc, msg) => {
        acc[msg.META.id] = msg;
        return acc;
      }, {});
      return acc;
    }, {});

    const delivered_messages = messages.reduce((acc, msgs) => {
      //if(!msgs || !(msgs && msgs.length)) return acc;
      if (!msgs.length) return acc;
      const user = msgs[0].META.to;
      const failed_msgs = flatten_failed_msgs[user] || {};

      acc[user] = acc[user] || [];
      const msgIds = msgs.reduce((acc, msg) => {
        if (!failed_msgs[msg.META.id]) {
          acc.push(msg.META.id);
        }
        return acc;
      }, []);
      acc[user].push(...msgIds);
      return acc;
    }, {});

    Object.entries(delivered_messages).forEach(async ([user, ids]) => {
      await this.db.markMessageDeliveredByUser(user, ids);
    });
  }

  async shutdown() {
    const { publisher, listener } = this.context;
    await publisher.disconnect();
    await listener.disconnect();
    await this.db.close();
  }

  async getServer(user) {
    return (await this.memCache.get(user)) || null;
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
