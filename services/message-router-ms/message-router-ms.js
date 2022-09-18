const eventStore = require('../../libs/event-store');
const { MessageEvent, MESSAGE_TYPE, CHANNEL_TYPE } = require('../../libs/event-args');
const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');

const asMain = require.main === module;

/** @typedef {import('../../libs/event-args').MessageEvent} Message */

const EVENT_TYPE = {
  NEW_MESSAGE_EVENT: 'new-message',
  SEND_EVENT: 'send-event',
  GROUP_MESSAGE_EVENT: 'group-message',
  SYSTEM_EVENT: 'system-event',
}

async function prepareEventList(context) {
  const { options } = context;
  const eventName = {
    [EVENT_TYPE.NEW_MESSAGE_EVENT]: options.newMessageTopic,
    [EVENT_TYPE.SEND_EVENT]: options.sendMessageTopic,
    [EVENT_TYPE.GROUP_MESSAGE_EVENT]: options.groupMessageTopic,
    [EVENT_TYPE.SYSTEM_EVENT]: options.systemMessageTopic || options.ackTopic,
  };
  context.events = eventName;
  context.listenerEvents = [options.newMessageTopic];
  return context;
}

async function initResources(options) {
  let context = await initDefaultResources(options)
    .then(prepareEventList);
  context = await eventStore.initializeEventStore({
    producer: true,
    consumer: true,
    decodeMessageCb: () => MessageEvent
  })(context)
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd
    .option(
      '--new-message-topic <new-message-topic>',
      'Used by consumer to consume new message for each new incoming message'
    )
    .option(
      '--group-message-topic <group-message-topic>',
      'Used by producer to produce new message to handle by message router'
    )
    .option(
      '--send-message-topic <send-message-topic>',
      'Used by producer to produce new message to send message to user'
    )
    .option(
      '--ack-topic <ack-topic>',
      'Used by producer to produce new message for acknowledgment (depericated use --system-message-topic instead)'
    )
    .option(
      '--system-message-topic <system-message-topic>',
      'Used by producer to produce new message for system message'
    );
  return cmd.parse(argv).opts();
}

class MessageRouterMS extends ServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
    this.events = this.context.events;
    this.maxRetryCount = this.options.messageMaxRetries;
  }

  init() {
    this.eventStore.on = (_, message, key) => {
      this.redirectMessage(message, key);
    };
  }

  /**
   * Redirect message based on the type
   * @param {Message} message 
   * @param {string} key
   */
  async redirectMessage(message, key) {
    const start = Date.now();
    let event;
    switch (message.channel) {
      case CHANNEL_TYPE.GROUP:
        event = EVENT_TYPE.GROUP_MESSAGE_EVENT
        break;
      default:
        switch (message.type) {
          case MESSAGE_TYPE.NOTIFICATION:
            event = EVENT_TYPE.SYSTEM_EVENT
            break;
          default:
            event = EVENT_TYPE.SEND_EVENT
        }
        break;
    }
    await this.publish(event, message, key);

    this.log.info('Message redirected', { sid: message.server_id, latency: Date.now() - start });
  }

  async publish(event, message, key) {
    this.eventStore.emit(this.events[event], message, key)
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
      await new MessageRouterMS(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Message Router MS', error);
      process.exit(1);
    });
}
