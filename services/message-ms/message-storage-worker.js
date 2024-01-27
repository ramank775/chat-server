const EventStore = require('../../libs/event-store');
const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables,
} = require('../../libs/service-base');
const { MessageEvent } = require('../../libs/event-args');
const Database = require('./database');

const asMain = require.main === module;

const EVENT_TYPE = {
  NEW_MESSAGE_EVENT: 'new-message',
  CLIENT_ACK_EVENT: 'client-ack-event'
}

async function prepareEventList(context) {
  const { options } = context;
  const eventName = {
    [EVENT_TYPE.NEW_MESSAGE_EVENT]: options.newMessageTopic,
    [EVENT_TYPE.CLIENT_ACK_EVENT]: options.clientAckTopic,
  };
  context.events = eventName;
  context.listenerEvents = [options.newMessageTopic, options.clientAckTopic];
  return context;
}

async function initResources(options) {
  let context = await initDefaultResources(options)
    .then(Database.initializeDatabase)
    .then(prepareEventList);
  context = await EventStore.initializeEventStore({
    producer: false,
    consumer: true,
    decodeMessageCb: () => MessageEvent
  })(context)
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = EventStore.addEventStoreOptions(cmd);
  cmd = Database.addDatabaseOptions(cmd);
  cmd
    .option(
      '--new-message-topic <new-message-topic>',
      'Used by consumer to consume new message for each new incoming message'
    )
    .option(
      '--client-ack-topic <client-ack-topic>',
      'Used by consumer to consume for ack message received by client.'
    );
  return cmd.parse(argv).opts();
}


class MessageStorageWorker extends ServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
    /** @type {import('./database/message-db').IMessageDB} */
    this.db = context.messageDb;
    this.events = this.context.events;

  }

  init() {
    const { events, eventStore } = this;
    eventStore.on = async (event, message) => {
      switch (event) {
        case events[EVENT_TYPE.NEW_MESSAGE_EVENT]:
          await this.saveMessage(message);
          break;
        case events[EVENT_TYPE.CLIENT_ACK_EVENT]:
          await this.ackMessage(message);
          break;
        default:
          // Ignore do nothing
          break;
      }
    }
  }

  /**
   * Save message into database
   * @param {import('../../libs/event-args').MessageEvent} message
   */
  async saveMessage(message) {
    if (message.ephemeral) return;
    await this.db.save([message])
  }

  /**
   * Save message into database
   * @param {import('../../libs/event-args').MessageEvent} message
   */
  async ackMessage(message) {
    await this.db.markMessageDelivered([message.id], message.source)
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
      await new MessageStorageWorker(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Message Storage Worker', error);
      process.exit(1);
    });
}

module.exports = {
  MessageStorageWorker,
  parseOptions,
  initResources
}
