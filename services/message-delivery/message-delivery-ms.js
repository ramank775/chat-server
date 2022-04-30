const fetch = require('node-fetch');
const eventStore = require('../../libs/event-store');
const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const cache = require('../../libs/cache');
const disoveryService = require('../../libs/discovery-service-utils');
const database = require('./database');
const { shortuuid } = require('../../helper');

const asMain = require.main === module;

async function prepareEventList(context) {
  const { options } = context;
  const { userConnectionStateTopic, sendMessageTopic, offlineMessageTopic, ackTopic, systemMessageTopic } = options;
  context.events = {
    'user-connection-state': userConnectionStateTopic,
    'send-message': sendMessageTopic,
    'offline-message': offlineMessageTopic,
    'system-message': systemMessageTopic || ackTopic,
  };
  context.listenerEvents = [userConnectionStateTopic, sendMessageTopic, systemMessageTopic || ackTopic];
  return context;
}

async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(cache.initMemCache)
    .then(database.initializeDatabase)
    .then(prepareEventList)
    .then(disoveryService.initDiscoveryService)
    .then(eventStore.initializeEventStore({ producer: true, consumer: true }));
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd = database.addDatabaseOptions(cmd);
  cmd = disoveryService.addDiscoveryServiceOptions(cmd);
  cmd = cache.addMemCacheOptions(cmd);
  cmd = cmd.option(
    '--user-connection-state-topic <user-connection-state-topic>',
    'Used by consumer to consume new message when a user connected/disconnected to server'
  )
    .option(
      '--send-message-topic <send-message-topic>',
      'Used by consumer to consume new message to send to user'
    )
    .option(
      '--offline-message-topic <offline-message-topic>',
      'Used by producer to produce new message for offline'
    )
    .option(
      '--ack-topic <ack-topic>',
      'Used by consumer to consume new message for acknowledgment (depericated use --system-message-topic instead)'
    )
    .option(
      '--system-message-topic <system-message-topic>',
      'Used by consumer to consume new message for system message'
    )
    .option(
      '--message-max-retries <message-max-retries>',
      'Max no of retries to deliver message (default value is 3)',
      (value) => Number(value),
      3
    )
    .option(
      '--ack-action-alias <ack-action-alias>',
      'Alias for acknowledgement message. For multiple value supply comma seperate value default (ack,state)',
      (value) => value.split(','),
      'ack,state'
    );
  return cmd.parse(argv).opts();
}

class MessageDeliveryMS extends ServiceBase {
  constructor(context) {
    super(context);
    this.memCache = context.memCache;
    this.discoveryService = context.discoveryService;
    this.maxRetryCount = this.options.messageMaxRetries;

    /** @type {import('./database/message-db').IMessageDB} */
    this.db = context.messageDb;

    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
    this.events = this.context.events;
    this.ackAlias = this.options.ackActionAlias;
    this.userConnectedCounter = this.statsClient.counter({
      name: 'userconnected'
    });
    this.getServerMeter = this.statsClient.meter({
      name: 'getServer/sec',
      type: 'meter'
    });
  }

  init() {
    const { events } = this;
    this.eventStore.on = async (event, value) => {
      switch (event) {
        case events['user-connection-state']:
          {
            const { action, user, server } = value;
            switch (action) {
              case 'connect':
                this.onConnect(user, server);
                break;
              case 'disconnect':
                this.onDisconnect(user, server);
                break;
              default:
                throw new Error('Unkown action');
            }
          }
          break;
        case events['send-message']:
          this.onMessage(value);
          break;
        case events['system-message']:
          this.onSystemMessage(value);
          break;
        default:
          throw new Error(`Unknown event ${event}`);
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
    if (exitingServer === server) {
      await this.memCache.del(user);
      this.userConnectedCounter.dec(1);
    }
  }

  async onMessage(value) {
    const nonEphemeralMessages = value.items.filter((msg) => !msg.META.ephemeral)
    this.db.save(nonEphemeralMessages);
    await this.sendMessage(value);
  }

  async onSystemMessage(value) {
    const { acks, other } = value.items.reduce((acc, msg) => {
      if (this.ackAlias.includes(msg.META.action)) {
        acc.acks.push(msg)
        if (msg.META.to !== 'server') {
          acc.other.push(msg)
        }
      } else {
        acc.other.push(msg)
      }
      return acc
    }, { acks: [], other: [] });

    if (acks.length) {
      this.ackMessage(acks)
    }
    if (other.length) {
      this.onMessage({ items: other })
    }
  }

  ackMessage(items) {
    const userMessages = items.reduce((mapping, msg) => {
      const user = msg.META.from;
      if (!mapping[user]) {
        mapping[user] = [];
      }
      mapping[user].push(...msg.payload.body.ids);
      return mapping;
    }, {});
    Object.entries(userMessages).forEach(async ([user, ids]) => {
      await this.db.markMessageDeliveredByUser(user, ids);
    });
  }

  async sendMessage(value) {
    const { asyncStorage } = this.context;
    const trackId = asyncStorage.getStore() || shortuuid();
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
          'x-request-id': trackId
        }
      })
        .then((res) => res.json())
        .then(({ errors }) => {
          const failedMessages = errors.map((x) => x.messages);
          // HACK: until client implements the proper ack and
          // server has rest endpoint for message sync and ack
          // remove successfully sent messages
          this.markMessagesAsSent(messages, failedMessages);
          if (!errors.length) {
            return;
          }
          this.sendMessage({ items: failedMessages.flat() });
        })
        .catch((e) => {
          this.log.error('Error while sending messages', e);
        });
    });
  }

  async sendOfflineMessage(messages) {
    this.eventStore.emit(this.events['offline-message'], messages);
  }

  async sendPendingMessage(user) {
    const messages = await this.db.getUndeliveredMessageByUser(user);
    if (!(messages && messages.length)) return;
    this.log.info(`Processing pending message for ${user}, length : ${messages.length}`);

    const payload = messages.map((m) => {
      const { _id: _, ...msg } = m;
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
    const serverMapping = {};
    const userMapping = {};
    const users = new Set();
    const offlineMessages = [];
    items.forEach((message) => {
      const { to, retry = -1, saved = false } = message.META;
      // If messages is already saved don't send it to offline message again
      // even if retry count exceed
      if (retry > this.maxRetryCount && !saved) {
        offlineMessages.push(message);
        return;
      }
      message.META.retry = retry + 1;
      const userMsgs = userMapping[to];
      if (userMsgs) {
        userMsgs.push(message);
      } else {
        users.add(to);
        userMapping[to] = [message];
      }
    });
    const userServers = await this.getServer([...users]);
    users.forEach(user => {
      const server = userServers[user];
      if (!server) {
        // If messages is already saved don't send it to offline message again
        const msgs = userMapping[user].filter((m) => !m.saved);
        offlineMessages.push(...msgs);
      } else {
        const item = serverMapping[server];
        if (item) {
          item.push(userMapping[user]);
        } else {
          serverMapping[server] = [userMapping[user]];
        }
      }
    })
    return {
      online: serverMapping,
      offline: offlineMessages
    };
  }

  async markMessagesAsSent(messages, failedMessages) {
    const flattenFailedMsgs = failedMessages.reduce((acc, item) => {
      if (!item || !(item && item.length)) return acc;
      const user = item[0].META.to;
      acc[user] = item.reduce((userMessages, msg) => {
        userMessages[msg.META.id] = msg;
        return userMessages;
      }, {});
      return acc;
    }, {});

    const deliveredMessages = messages.reduce((acc, msgs) => {
      // if(!msgs || !(msgs && msgs.length)) return acc;
      if (!msgs.length) return acc;
      const user = msgs[0].META.to;
      const failedMsgs = flattenFailedMsgs[user] || {};

      acc[user] = acc[user] || [];
      const msgIds = msgs.reduce((ids, msg) => {
        if (!failedMsgs[msg.META.id]) {
          ids.push(msg.META.id);
        }
        return ids;
      }, []);
      acc[user].push(...msgIds);
      return acc;
    }, {});

    Object.entries(deliveredMessages).forEach(async ([user, ids]) => {
      await this.db.markMessageDeliveredByUser(user, ids);
    });
  }

  async shutdown() {
    await this.eventStore.dispose();
    await this.db.close();
  }

  async getServer(users) {
    const servers = await this.memCache.getAll(users);
    const result = {}
    for (let idx = 0; idx < users.length; idx += 1) {
      result[users[idx]] = servers[idx];
    }
    return result;
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
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Message delivery MS', error);
      process.exit(1);
    });
}
