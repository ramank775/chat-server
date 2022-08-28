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
const { MessageEvent, ConnectionStateEvent, CONNECTION_STATE } = require('../../libs/event-args');

const asMain = require.main === module;

const EVENT_TYPE = {
  CONNECTION_EVENT: 'connection-state',
  SEND_EVENT: 'send-event',
  OFFLINE_EVENT: 'offline-event',
  SYSTEM_EVENT: 'system-event',
  CLIENT_ACK_EVENT: 'client-ack-event'
};

async function prepareEventList(context) {
  const { options } = context;
  const {
    userConnectionStateTopic, sendMessageTopic,
    offlineMessageTopic, clientAckTopic, systemMessageTopic
  } = options;
  context.events = {
    [EVENT_TYPE.CONNECTION_EVENT]: userConnectionStateTopic,
    [EVENT_TYPE.SEND_EVENT]: sendMessageTopic,
    [EVENT_TYPE.OFFLINE_EVENT]: offlineMessageTopic,
    [EVENT_TYPE.SYSTEM_EVENT]: systemMessageTopic,
    [EVENT_TYPE.CLIENT_ACK_EVENT]: clientAckTopic,
  };
  context.listenerEvents = [userConnectionStateTopic, sendMessageTopic, systemMessageTopic, clientAckTopic];
  return context;
}

async function initResources(options) {
  let context = await initDefaultResources(options)
    .then(cache.initMemCache)
    .then(database.initializeDatabase)
    .then(prepareEventList)
    .then(disoveryService.initDiscoveryService);

  context = await eventStore.initializeEventStore({
    producer: true,
    consumer: true,
    decodeMessageCb: (topic) => {
      const { events } = context
      switch (topic) {
        case events[EVENT_TYPE.CONNECTION_EVENT]:
          return ConnectionStateEvent;
        default:
          return MessageEvent;
      }
    }
  })(context);
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
      '--client-ack-topic <client-ack-topic>',
      'Used by consumer to consume for ack message received by client.'
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
    this.eventStore.on = async (event, message, key) => {
      switch (event) {
        case events[EVENT_TYPE.CONNECTION_EVENT]:
          this.onConnectionStateChange(message);
          break;
        case events[EVENT_TYPE.SEND_EVENT]:
          this.onMessage(message, key);
          break;
        case events[EVENT_TYPE.SYSTEM_EVENT]:
          this.onSystemEvent(message, key);
          break;
        case events[EVENT_TYPE.CLIENT_ACK_EVENT]:
          this.onClientAckEvent(message, key);
          break;
        default:
          throw new Error(`Unknown event ${event}`);
      }
    };
  }

  /**
   * Handle user connection state change event
   * @param {import('../../libs/event-args').ConnectionStateEvent} message 
   */
  async onConnectionStateChange(message) {
    switch (message.state) {
      case CONNECTION_STATE.CONNECTED:
        this.onConnect(message.user, message.gateway);
        break;
      case CONNECTION_STATE.DISCONNECTED:
        this.onDisconnect(message.user, message.gateway);
        break;
      default:
        throw new Error('Unkown action');
    }
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

  /**
   * 
   * @param {import('../../libs/event-args').MessageEvent} value 
   * @param {string} receiver
   */
  async onMessage(value, receiver) {
    if (!value.ephemeral) {
      this.db.save(receiver, [value]);
    }
    await this.sendMessage(value, receiver);
  }

  /**
   * 
   * @param {import('../../libs/event-args').MessageEvent} value 
   * @param {string} receiver
   */
  async onSystemEvent(value, receiver) {
    if (value.destination === 'server') {
      this.ackMessage(value);
    } else {
      this.onMessage(value, receiver)
    }
  }

  /**
   * 
   * @param {import('../../libs/event-args').MessageEvent} value 
   */
  async onClientAckEvent(value) {
    await this.db.markMessageDelivered(value.source, [value.id]);
  }

  /**
   * 
   * @param {import('../../libs/event-args').MessageEvent} value 
   * @param {string} receiver
   */
  async sendMessage(value, receiver) {
    await this.sendMessageWithRetry(receiver, [value], { saved: false, retry: 0 })
  }

  async sendMessageWithRetry(receiver, messages, { trackid = null, saved = false, retry = 0 }) {
    if (retry > this.maxRetryCount) return
    const servers = await this.getServer([receiver])
    const server = servers[receiver]
    if (!server) {
      if (saved) return
      await this.sendOfflineMessage(messages, receiver);
      return
    }
    const url = await this.discoveryService.getServiceUrl(server);
    const trackId = trackid || this.context.asyncStorage.getStore() || shortuuid();
    const body = {
      items: [{
        receiver,
        meta: {
          saved,
          retry
        },
        messages: messages.map((m) => ({ sid: m.server_id, raw: m.toBinary() }))
      }]
    }
    fetch(`${url}/send`, {
      method: 'post',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': trackId
      }
    })
      .then((res) => res.json())
      .then(async ({ errors }) => {
        if (!(errors && errors.length)) {
          return;
        }
        const error = errors[0];
        if (error.code === 404) {
          await this.onDisconnect(receiver, server);
          await this.sendMessageWithRetry(receiver, messages, { trackid: trackId, saved, retry: retry + 1 })
          return;
        }
        const errorMessages = [];
        const deliveredMessages = [];
        let hasNotFoundError = false;
        messages.forEach((m) => {
          const errMsg = error.messages.find((err) => err.sid === m.server_id)
          if (!errMsg) {
            deliveredMessages.push(m.id)
          } else if (errMsg.code === 404) {
            hasNotFoundError = true
            errorMessages.push(m)
          }
        })
        if (hasNotFoundError) {
          await this.onDisconnect(receiver, server);
        }
        if (deliveredMessages.length) {
          await this.db.markMessagesAsSent(receiver, deliveredMessages)
        }
        if (errorMessages.length) {
          await this.sendMessageWithRetry(receiver, errorMessages, { trackid: trackId, saved, retry: retry + 1 })
        }
      })
      .catch((e) => {
        this.log.error('Error while sending messages', e);
      });
  }

  async sendOfflineMessage(messages, receiver) {
    const promises = messages
      .filter((m) => !m.ephemeral)
      .map(async (m) => {
        await this.eventStore.emit(this.events[EVENT_TYPE.OFFLINE_EVENT], m, receiver);
      })
    await Promise.all(promises);
  }

  async sendPendingMessage(user) {
    const messages = await this.db.getUndeliveredMessage(user);
    if (!(messages && messages.length)) return;
    this.log.info(`Processing pending message for ${user}, length : ${messages.length}`);
    await this.sendMessageWithRetry(user, messages, { saved: true, retry: 0 })
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
      await this.db.markMessageDelivered(user, ids);
    });
  }

  async getServer(users) {
    const servers = await this.memCache.getAll(users);
    const result = {}
    for (let idx = 0; idx < users.length; idx += 1) {
      result[users[idx]] = servers[idx];
    }
    return result;
  }

  async shutdown() {
    await this.eventStore.dispose();
    await this.db.close();
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
