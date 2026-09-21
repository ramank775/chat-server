const eventStore = require('../../libs/event-store');
const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const ChannelServiceClient = require('../../libs/channel-service-client');
const DeliveryManager = require('../../libs/delivery-manager');
const { UndeliveredQueue } = require('../../libs/delivery-manager/undelivered-queue');
const { EnvelopeEvent } = require('../../libs/v3-envelope');

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

/** Shares the delivery manager's redis client — no second connection. */
async function initUndeliveredQueue(context) {
  context.undeliveredQueue = new UndeliveredQueue({ redis: context.deliveryManager.redis });
  return context;
}

async function initResources(options) {
  let context = await initDefaultResources(options)
    .then(ChannelServiceClient.init)
    .then(DeliveryManager.init)
    .then(initUndeliveredQueue)
    .then(prepareEventList);

  context = await eventStore.initializeEventStore({
    producer: true,
    consumer: true,
    decodeMessageCb: () => EnvelopeEvent
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

    /** @type { import('../../libs/delivery-manager/undelivered-queue').UndeliveredQueue } */
    this.undeliveredQueue = this.context.undeliveredQueue;
  }

  init() {
    this.eventStore.on = async (event, message, key) => {
      await this.onMessage(message, key);
    };
    // The v3 fanout bus carries stamped envelopes, not v2 `Message`s.
    this.deliveryManager.eventArg = EnvelopeEvent;
    this.deliveryManager.offlineMessageHandler = this.handleOfflineMessage.bind(this);
  }

  /**
   * SYNC_PROTOCOL.md §10.3 step 1 — resolve the recipient set and fan out.
   * Server-authored events (REST-write bridge, §10.2) arrive with their
   * recipients already spelled out; those are taken as given.
   * @param {EnvelopeEvent} event
   */
  async onMessage(event) {
    if (!event.hasRecipients()) {
      event.setRecipients([...(await this.channelClient.members(event.channelId))]);
    }
    // §10.3 step 4 — the sender gets no fanout for its own op, whether the
    // recipient set came from channel-ms or was spelled out by the publisher
    // (§10.2 lists the actor). Cross-device fanout is v3.1, so the whole
    // sending user is excluded.
    const recipients = event.recipients.filter((userId) => userId !== event.senderUserId);
    if (!recipients.length) {
      this.log.info(`No fanout recipients for channel ${event.channelId}`);
      return;
    }
    event.setRecipients(recipients);
    await this.deliveryManager.dispatch(event);
  }

  /**
   * SYNC_PROTOCOL.md §10.3 step 3 — every recipient delivery-manager could
   * not reach gets the push frame queued, then an offline-message event so
   * notification-ms fires the ntfy wake (§12.1; it owns the debounce).
   * @param {EnvelopeEvent} event
   */
  async handleOfflineMessage(event) {
    // Ephemeral envelopes (typing, presence) are worthless once missed.
    if (event.ephemeral) return;
    const frame = event.toPushFrame();
    await Promise.all(event.recipients.map(async (userId) => {
      await this.undeliveredQueue.enqueue(userId, frame);
      await this.eventStore.emit(this.events[EVENT_TYPE.OFFLINE_EVENT], event, userId);
      this.statsClient.increment({
        stat: 'message.undelivered.count',
        tags: { user: userId }
      });
    }));
  }

  async shutdown() {
    await this.eventStore.dispose();
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
