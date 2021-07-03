const kafka = require('../../libs/kafka-utils'),
  { ServiceBase, initDefaultOptions, initDefaultResources, resolveEnvVariables } = require('../../libs/service-base'),
  { addMongodbOptions, initMongoClient } = require('../../libs/mongo-utils'),
  { formatMessage } = require('../../libs/message-utils'),
  asMain = require.main === module;

async function prepareEventListFromKafkaTopics(context) {
  const { options } = context;
  const eventName = {
    'send-message': options.kafkaSendMessageTopic
  };
  context.events = eventName;
  context.listenerEvents = [options.kafkaNewGroupMessageTopic];
  return context;
}

async function initResources(options) {
  const context = await initDefaultResources(options).then(initMongoClient).then(prepareEventListFromKafkaTopics).then(kafka.initEventProducer).then(kafka.initEventListener);
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = kafka.addStandardKafkaOptions(cmd);
  cmd = kafka.addKafkaSSLOptions(cmd);
  cmd = addMongodbOptions(cmd);
  cmd
    .option('--kafka-new-group-message-topic <new-group-message-topic>', 'Used by consumer to consume new group message for each new incoming message')
    .option('--kafka-send-message-topic <send-message-topic>', 'Used by producer to produce new message to send message to user');

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
      await this.redirectMessage(message);
    };
  }
  async redirectMessage(message) {
    const { publisher, events } = this.context;
    if (!message.META.parsed) {
      message = formatMessage(message);
    }
    let users = message.META.users;
    if (!users) {
      users = await this.getGroupUsers(message.META.to, message.META.from);
    }
    users = users.filter((x) => x !== message.META.from);
    const messages = [];
    for (let user of users) {
      if (typeof user === 'object') {
        user = user.username;
      }
      // Set message META property type as single so failed message to be handled by mesasge router
      message.META = { ...message.META, to: user, users: undefined };
      messages.push(message);
    }
    const receiver = events['send-message'];
    publisher.send(receiver, { items: messages });
  }

  async formatMessage(message) {
    const { META, payload } = message;
    const parsedPayload = JSON.parse(payload);
    const msg = {
      _v: parsedPayload._v || 1.0
    };

    if (msg._v >= 2.0) {
      const { id, head, meta, body } = parsedPayload;
      head.from = META.from;
      msg.head = head;
      msg.id = id;
      msg.body = body;
      msg.body.ts = getUTCEpoch();

      Object.assign(META, meta);
      META.to = head.to;
      META.id = id;
      META.type = head.type;
      META.contentType = head.contentType;

      // Add legacy keys for backward compatibility
      // TODO: remove this in next stable build
      msg.from = META.from;
      msg.to = head.to;
      msg.msgId = id;
      msg.type = head.contentType;
      msg.chatId = head.chatId; // to be deperciated, added for backward comptibility only
      msg.text = body.text;
      msg.module = head.type;
      msg.action = head.action;
      msg.chatType = head.type;
    } else {
      const { to, type, chatType, ..._msg } = parsedPayload;
      Object.assign(msg, _msg);
      msg.from = META.from;
      msg.to = to;
      msg.type = type;
      msg.chatType = chatType;

      // Add new format keys
      msg.id = msg.msgId;
      msg.head = {
        type: chatType || msg.module,
        to: to,
        from: META.from,
        chatid: msg.chatId,
        contentType: msg.type,
        action: msg.action || 'message'
      };
      msg.body = {
        text: _msg.text,
        ts: getUTCEpoch()
      };

      Object.assign(META, {
        to: to,
        id: msg.id,
        type: chatType,
        contentType: type
      });
    }

    const formattedMessage = {
      META: { ...META, parsed: true },
      payload: msg
    };
    return formattedMessage;
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
      console.error('Failed to initialized Group Message Router MS', error);
      process.exit(1);
    });
}
