const eventStore = require('../../libs/event-store');
const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const ChannelServiceClient = require('../../libs/channel-service-client');
const { MessageEvent, CHANNEL_TYPE } = require('../../libs/event-args');
const DeliveryManager = require('../../libs/delivery-manager')

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

    /** @type { import('../../libs/delivery-manager').DeliveryManager } */
    this.deliveryManager = this.context.deliveryManager;
  }

  init() {
    this.eventStore.on = async (event, message, key) => {
      this.onMessage(message, key);
    };
    this.deliveryManager.offlineMessageHandler = this.handleOfflineMessage.bind(this);
  }

  /**
   * @param {import('../../libs/event-args').MessageEvent} message 
   */
  async onMessage(message) {
    if (!message.hasRecipients()) {
      let channel = await this.channelClient.getChannelInfo(message.destination)
      if (!channel) {
        this.log.info(`No channel found against ${message.destination}`)
        if (message.channel === CHANNEL_TYPE.INDIVIDUAL) {
          this.log.info(`Channel is of type individual, using destination as recipient`);
          channel = {
            members: [{
              username: message.destination
            }]
          };
        } else {
          return;
        }
      }
      const recipients = channel.members.map((member) => member.username)
      message.setRecipients(recipients);
    }
    await this.deliveryManager.dispatch(message);
  }

  /**
   * Handle offline message delivery
   * @param {import('../../libs/event-args').MessageEvent}  message 
   */
  async handleOfflineMessage(message) {
    if (message.ephemeral) {
      return
    }
    await this.eventStore.emit(
      this.events[EVENT_TYPE.OFFLINE_EVENT],
      message,
      message.destination
    );
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

module.exports = {
  MessageDeliveryWorker,
  parseOptions,
  initResources
}
