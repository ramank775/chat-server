const kafka = require('../../libs/kafka-utils');
const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addMongodbOptions, initMongoClient } = require('../../libs/mongo-utils');
const { formatMessage } = require('../../libs/message-utils');

const asMain = require.main === module;

async function prepareEventList(context) {
  const { options } = context;
  const eventName = {
    'send-message': options.sendMessageTopic,
    ack: options.ackTopic
  };
  context.events = eventName;
  context.listenerEvents = [options.newGroupMessageTopic];
  return context;
}

async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(initMongoClient)
    .then(prepareEventList)
    .then(kafka.initEventProducer)
    .then(kafka.initEventListener);
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = kafka.addStandardKafkaOptions(cmd);
  cmd = kafka.addKafkaSSLOptions(cmd);
  cmd = addMongodbOptions(cmd);
  cmd
    .option(
      '--new-group-message-topic <new-group-message-topic>',
      'Used by consumer to consume new group message for each new incoming message'
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

class GroupMessageRouterMS extends ServiceBase {
  constructor(context) {
    super(context);
    this.mongoClient = context.mongoClient;
    this.groupCollection = context.mongodbClient.collection('groups');
  }

  init() {
    const { listener } = this.context;
    listener.onMessage = async (_, message) => {
      this.redirectMessage(message);
    };
  }

  async redirectMessage(message) {
    const start = Date.now();
    const { publisher, events } = this.context;
    if (!message.META.parsed) {
      message = formatMessage(message);
    }
    let { users } = message.META;
    if (!users) {
      users = await this.getGroupUsers(message.META.to, message.META.from);
    }
    users = users.filter((x) => x !== message.META.from);
    if (message.META.action === 'ack') {
      message.META.users = users;
      const receiver = events.ack;
      publisher.send(receiver, { items: [message] }, message.META.from);
    } else {
      const messages = users.map((user) => {
        if (typeof user === 'object') {
          user = user.username;
        }
        const msg = { ...message };
        // Set message META property type as single so failed message to be handled by mesasge router
        msg.META = { ...msg.META, to: user, users: undefined };
        return msg;
      })

      const receiver = events['send-message'];
      publisher.send(receiver, { items: messages });
    }
    this.log.info('Message redirected', { sid: message.META.sid, latency: Date.now() - start });
  }

  async shutdown() {
    const { publisher, listener } = this.context;
    await publisher.disconnect();
    await listener.disconnect();
    await this.context.mongoClient.close();
  }

  async getGroupUsers(groupId, user) {
    const group = await this.groupCollection.findOne({ groupId, 'members.username': user });
    const users = group.members.map((x) => x.username);
    return users;
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResources(options)
    .then(async (context) => {
      await new GroupMessageRouterMS(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Group Message Router MS', error);
      process.exit(1);
    });
}
