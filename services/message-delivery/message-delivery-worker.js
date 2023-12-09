const eventStore = require('../../libs/event-store');
const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const ChannelServiceClient = require('../../libs/channel-service-client');
const { shortuuid } = require('../../helper');
const { MessageEvent } = require('../../libs/event-args');
const DeliveryManager = require('./delivery-manager')

const asMain = require.main === module;

const EVENT_TYPE = {
  NEW_MESSAGE_EVENT: 'new-message',
  OFFLINE_EVENT: 'offline-event',
};

async function prepareEventList(context) {
  const { options } = context;
  const {
    newMessageTopic, offlineMessageTopic,
  } = options;
  context.events = {
    [EVENT_TYPE.NEW_MESSAGE_EVENT]: newMessageTopic,
    [EVENT_TYPE.OFFLINE_EVENT]: offlineMessageTopic,
  };
  context.listenerEvents = [newMessageTopic];
  return context;
}

async function initResources(options) {
  let context = await initDefaultResources(options)
    .then(ChannelServiceClient.init)
    .then(DeliveryManager.init)
    .then(prepareEventList);

  context = await eventStore.initializeEventStore({
    producer: true,
    consumer: true,
    decodeMessageCb: () => MessageEvent
  })(context);
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd = ChannelServiceClient.addOptions(cmd);
  cmd = DeliveryManager.addOptions(cmd);
  cmd = cmd
    .option(
      '--offline-message-topic <offline-message-topic>',
      'Used by producer to produce new message for offline'
    )
    .option(
      '--new-message-topic <new-message-topic>',
      'Used by consumer to consume for new message.'
    )
    .option(
      '--message-max-retries <message-max-retries>',
      'Max no of retries to deliver message (default value is 3)',
      (value) => Number(value),
      3
    );
  return cmd.parse(argv).opts();
}

class MessageDeliveryWorker extends ServiceBase {
  constructor(context) {
    super(context);
    this.maxRetryCount = this.options.messageMaxRetries;

    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
    this.events = this.context.events;
    
    /** @type { import('../../libs/channel-service-client').ChannelServiceClient } */
    this.channelClient = this.context.channelServiceClient;
    
    /** @type { import('./delivery-manager').DeliveryManager } */
    this.deliveryManager = this.context.deliveryManager;
  }

  init() {
    this.eventStore.on = async (event, message, key) => {
      this.onMessage(message, key);
    };

    this.deliveredMessages.handleOfflineMessage = this.handleOfflineMessage
  }

  /**
   * @param {import('../../libs/event-args').MessageEvent} message 
   */
  async onMessage(message) {
    if (!message.hasRecipients()) {
      const channel = await this.channelClient.getChannelInfo(message.destination)
      if (!channel) {
        this.log.info(`No channel found against ${message.distination}`)
        return;
      }
      const recipients = channel.members.map((member) => member.username)
      message.setRecipients(recipients);
    }
    await this.deliveryManager.dispatch(message);
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
      await this.handleOfflineMessage(messages, receiver);
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
          await this.db.markMessageSent(receiver, deliveredMessages)
        }
        if (errorMessages.length) {
          await this.sendMessageWithRetry(receiver, errorMessages, { trackid: trackId, saved, retry: retry + 1 })
        }
      })
      .catch((e) => {
        this.log.error('Error while sending messages', e);
      });
  }

  /**
   * Handle offline message delivery
   * @param {import('../../libs/event-args').MessageEvent[]}  messages 
   */
  async handleOfflineMessage(messages) {
    const promises = messages
      .filter((m) => !m.ephemeral)
      .map(async (m) => {
        await this.eventStore.emit(this.events[EVENT_TYPE.OFFLINE_EVENT], m, m.destination);
      })
    await Promise.all(promises);
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
      await new MessageDeliveryWorker(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Message delivery Worker', error);
      process.exit(1);
    });
}
