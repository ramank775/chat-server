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
   * Members come from channel-ms unless the publisher spelled them out: a
   * server-authored event (REST-write bridge, §10.2) or a DM, whose members
   * are derived from the channel id and have no row (trim 4).
   * @param {EnvelopeEvent} event
   */
  async onMessage(event) {
    const members = event.hasRecipients()
      ? event.recipients
      : [...(await this.channelClient.members(event.channelId))];

    // TRIM_4_12_CONTRACT §7-§8 — delivery is per `(user_id, device_id)`, and
    // every device except the sending one gets the envelope, the sender's own
    // other devices included.
    // ponytail: a server-authored event carries no sending device, so the
    // actor's whole user is skipped, as it was before the trim. Ceiling: at
    // max_devices > 1 the actor's other devices would miss channel events
    // until channel-ms threads its `x-device` into the fanout.
    const sending = event.senderSubject;
    const recipients = (await this.deliveryManager.subjects(members)).filter((subject) =>
      (sending ? subject !== sending : !subject.startsWith(`${event.senderUserId}:`)));
    if (!recipients.length) {
      this.log.info(`No fanout recipients for channel ${event.channelId}`);
      return;
    }
    event.setRecipients(recipients);
    await this.deliveryManager.dispatch(event);
  }

  /**
   * SYNC_PROTOCOL.md §10.3 step 3 — every subject delivery-manager could not
   * reach gets the push frame queued, then an offline-message event so
   * notification-ms fires the ntfy wake (§12.1; it owns the debounce). Both
   * are keyed per `(user_id, device_id)`.
   * @param {EnvelopeEvent} event
   */
  async handleOfflineMessage(event) {
    // Ephemeral envelopes (typing, presence) are worthless once missed.
    if (event.ephemeral) return;
    const frame = event.toPushFrame();
    await Promise.all(event.recipients.map(async (subject) => {
      await this.undeliveredQueue.enqueue(subject, frame);
      await this.eventStore.emit(this.events[EVENT_TYPE.OFFLINE_EVENT], event, subject);
      this.statsClient.increment({
        stat: 'message.undelivered.count',
        tags: { user: subject.split(':')[0] }
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
  initResources,
  prepareEventList
}
