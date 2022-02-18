const eventStore = require('../../libs/event-store');
const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { formatMessage } = require('../../libs/message-utils');

const asMain = require.main === module;

async function prepareEventList(context) {
  const { options } = context;
  const eventName = {
    'new-message': options.newMessageTopic,
    'send-message': options.sendMessageTopic,
    'group-message': options.groupMessageTopic,
    ack: options.ackTopic
  };
  context.events = eventName;
  context.listenerEvents = [options.newMessageTopic];
  return context;
}

async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(prepareEventList)
    .then(eventStore.initializeEventStore({ producer: true, consumer: true }));
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
      'Used by producer to produce new message for acknowledgment'
    );
  return cmd.parse(argv).opts();
}

class MessageRouterMS extends ServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
    this.maxRetryCount = this.options.messageMaxRetries;
    this.redirectMessageMeter = this.statsClient.meter({
      name: 'redirectMessage/sec',
      type: 'meter'
    });
  }

  init() {
    this.eventStore.on = (_, message) => {
      this.redirectMessageMeter.mark();
      this.redirectMessage(message);
    };
  }

  redirectMessage(message) {
    const start = Date.now();
    if (!message.META.parsed) {
      message = formatMessage(message);
    }
    const user = message.META.to;

    if (message.META.type === 'group') {
      this.eventStore.emit(this.events['group-message'], message, user);
    } else if (['ack', 'state'].includes(message.META.action)) {
      this.eventStore.emit(this.events.ack, { items: [message] }, message.META.from);
    } else {
      this.eventStore.emit(this.events['send-message'], { items: [message] }, user);
    }
    this.log.info('Message redirected', { sid: message.META.sid, latency: Date.now() - start });
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
