const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables,
} = require('../../libs/service-base');
const eventStore = require('../../libs/event-store');
const { addDatabaseOptions, initializeDatabase } = require('./database');
const { addPNSOptions, initializePNS } = require('./pns');
const { LoginEvent, MessageEvent, MESSAGE_TYPE } = require('../../libs/event-args');

const asMain = require.main === module;

const EVENT_TYPE = {
  PUSH_NOTIFICATION: 'push-notification',
  LOGIN: 'login',
};

async function prepareEventList(context) {
  const { options } = context;
  const eventName = {
    [EVENT_TYPE.PUSH_NOTIFICATION]: options.offlineMessageTopic,
    [EVENT_TYPE.LOGIN]: options.newLoginTopic,
  };
  context.events = eventName;
  context.listenerEvents = [options.offlineMessageTopic, options.newLoginTopic];
  return context;
}

async function initResources(options) {
  let context = await initDefaultResources(options)
    .then(prepareEventList)
    .then(initializeDatabase)
    .then(initializePNS);
  context = await eventStore.initializeEventStore({
    consumer: true,
    decodeMessageCb: (topic) => {
      const { events } = context;
      switch (topic) {
        case events[EVENT_TYPE.LOGIN]:
          return LoginEvent;
        default:
          return MessageEvent;
      }
    },
  })(context);
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd = addDatabaseOptions(cmd);
  cmd = addPNSOptions(cmd);
  cmd.option(
    '--offline-message-topic <offline-message-topic>',
    'Used by producer to produce new message to send the push notification'
  );
  cmd.option('--new-login-topic <new-login-topic>', 'New login topic');
  cmd.option(
    '--offline-msg-initial <offline-msg-initial>',
    'Initial for saved messages',
    'persistence-message'
  );
  return cmd.parse(argv).opts();
}

class NotificationMS extends ServiceBase {
  constructor(context) {
    super(context);

    /** @type {import('./database/notification-db').INotificationDB} */
    this.notifDB = context.notificationDB;

    /** @type {import('./pns/pn-service').IPushNotificationService} */
    this.pns = context.pns;

    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
    this.events = this.context.events;
  }

  init() {
    const { events } = this;
    this.eventStore.on = async (event, message, key) => {
      switch (event) {
        case events[EVENT_TYPE.LOGIN]:
          await this.onLogin(message);
          break;
        case events[EVENT_TYPE.PUSH_NOTIFICATION]:
          await this.pushNotification(message, key);
          break;
        default:
          throw new Error('Unknown event type');
      }
    };
  }

  /**
   * handle login event
   * @param {LoginEvent} event
   */
  async onLogin(event) {
    await this.notifDB.upsertToken(event.user, {
      deviceId: event.deviceId || 'default',
      messageVersion: event.messageVersion || 2.1,
      token: event.notificationToken,
    });
  }

  /**
   * push message to user
   * @param {import('../../libs/event-args').MessageEvent} message
   */
  async pushNotification(message, user) {
    if (message.type === MESSAGE_TYPE.NOTIFICATION) return;
    const record = await this.notifDB.getToken(user, { deviceId: 'default' });
    if (!record) return;
    const payload = (record.messageVersion || 2.1) < 3 ? message.toString() : message.toBinary();
    await this.pns
      .push(record.notificationToken, payload)
      .then(() => {
        this.statsClient.increment({
          stat: 'notificaton.delivery.count',
          tags: {
            user,
          },
        });
      })
      .catch((err) => {
        this.statsClient.increment({
          stat: 'notificaton.delivery.error_count',
          tags: {
            user,
          },
        });
        this.log.error(`Error while sending push notification ${err}`, err);
      });
  }

  async shutdown() {
    await this.eventStore.dispose();
    await this.notifDB.dispose();
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResources(options)
    .then(async (context) => {
      await new NotificationMS(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Notification MS', error);
      process.exit(1);
    });
}
