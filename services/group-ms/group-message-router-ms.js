const eventStore = require('../../libs/event-store');
const { MessageEvent } = require('../../libs/event-args');
const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addDatabaseOptions, initializeDatabase } = require('./database');

const asMain = require.main === module;

const EVENT_TYPE = {
  SEND_EVENT: 'send-event',
  SYSTEM_EVENT: 'system-event',
}

async function prepareEventList(context) {
  const { options } = context;
  const eventName = {
    [EVENT_TYPE.SEND_EVENT]: options.sendMessageTopic,
    [EVENT_TYPE.SYSTEM_EVENT]: options.systemMessageTopic || options.ackTopic
  };
  context.events = eventName;
  context.listenerEvents = [options.newGroupMessageTopic];
  return context;
}

async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(initializeDatabase)
    .then(prepareEventList)
    .then(eventStore.initializeEventStore({
      producer: true,
      consumer: true,
      decodeMessageCb: () => MessageEvent
    }));

  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd = addDatabaseOptions(cmd);
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
      'Used by producer to produce new message for acknowledgment (depericated use --system-message-topic instead)'
    )
    .option(
      '--system-message-topic <system-message-topic>',
      'Used by producer to produce new message for system message'
    );

  return cmd.parse(argv).opts();
}

class GroupMessageRouterMS extends ServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('./database/group-db').IGroupDB} */
    this.db = context.groupDb;
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = context.eventStore;
    this.events = context.events;
  }

  init() {
    this.eventStore.on = async (_, message, key) => {
      await this.redirectMessage(message, key);
    };
  }

  /**
   * Redirect Group message.
   * @param {import('../../libs/event-args').MessageEvent} message 
   * @param {string} key 
   */
  async redirectMessage(message) {
    const start = Date.now();
    const users = await this.getGroupUsers(message.destination, message.source);
    const promises = users.filter((x) => x !== message.source).map(async (user) => {
      await this.publish(EVENT_TYPE.SEND_EVENT, message, user);
    })
    await Promise.all(promises)
    this.log.info('Message redirected', { sid: message.server_id, latency: Date.now() - start });
  }

  async publish(event, message, key) {
    this.eventStore.emit(this.events[event], message, key)
  }

  async shutdown() {
    await this.eventStore.dispose();
    await this.db.dispose();
  }

  async getGroupUsers(groupId, user) {
    const group = await this.db.getGroupInfo(groupId, user);
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
