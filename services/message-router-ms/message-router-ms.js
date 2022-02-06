const kafka = require('../../libs/kafka-utils');
const { ServiceBase, initDefaultOptions, initDefaultResources, resolveEnvVariables } = require('../../libs/service-base');
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
    .then(kafka.initEventProducer)
    .then(kafka.initEventListener);
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = kafka.addStandardKafkaOptions(cmd);
  cmd = kafka.addKafkaSSLOptions(cmd);
  cmd
    .option('--new-message-topic <new-message-topic>', 'Used by consumer to consume new message for each new incoming message')
    .option('--group-message-topic <group-message-topic>', 'Used by producer to produce new message to handle by message router')
    .option('--send-message-topic <send-message-topic>', 'Used by producer to produce new message to send message to user')
    .option('--ack-topic <ack-topic>', 'Used by producer to produce new message for acknowledgment');
  return cmd.parse(argv).opts();
}

class MessageRouterMS extends ServiceBase {
  constructor(context) {
    super(context);
    this.maxRetryCount = this.options.messageMaxRetries;
    this.redirectMessageMeter = this.statsClient.meter({
      name: 'redirectMessage/sec',
      type: 'meter'
    });
  }
  init() {
    const { listener } = this.context;
    listener.onMessage = (_, message) => {
      this.redirectMessageMeter.mark();
      this.redirectMessage(message);
    };
  }
  redirectMessage(message) {
    const start = Date.now();
    const { publisher, events } = this.context;
    if (!message.META.parsed) {
      message = formatMessage(message);
    }
    const user = message.META.to;

    if (message.META.type === 'group') {
      const receiver = events['group-message'];
      publisher.send(receiver, message, user);
    } else {
      if (['ack', 'state'].includes(message.META.action)) {
        const receiver = events['ack'];
        publisher.send(receiver, { items: [message] }, message.META.from);
      } else {
        const receiver = events['send-message'];
        publisher.send(receiver, { items: [message] }, user);
      }
    }
    this.log.info('Message redirected', { sid: message.META.sid, latency: Date.now() - start });
  }

  async shutdown() {
    const { publisher, listener } = this.context;
    await publisher.disconnect();
    await listener.disconnect();
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
      console.error('Failed to initialized Message Router MS', error);
      process.exit(1);
    });
}
