const {
  ServiceBase,
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const eventStore = require('../../libs/event-store');
const { addDatabaseOptions, initializeDatabase } = require('./database');
const { addPNSOptions, initializePNS } = require('./pns');

const asMain = require.main === module;

async function prepareEventList(context) {
  const { options } = context;
  const eventName = {
    'push-notification': options.offlineMessageTopic,
    'new-login': options.newLoginTopic
  };
  context.events = eventName;
  context.listenerEvents = [options.offlineMessageTopic, options.newLoginTopic];
  return context;
}


async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(prepareEventList)
    .then(eventStore.initializeEventStore({ consumer: true }))
    .then(initializeDatabase)
    .then(initializePNS);
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
  cmd.option('--new-login-topic <new-login-topic>', 'New login kafka topic');
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

    this.notificationMeter = this.statsClient.meter({
      name: 'notificationMeter/sec',
      type: 'meter'
    });

    this.failedNotificationMeter = this.statsClient.meter({
      name: 'failedNotification/sec',
      type: 'meter'
    });
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
    this.events = this.context.events;
  }

  init() {
    const { events } = this;
    this.eventStore.on = async (event, message) => {
      switch (event) {
        case events['new-login']:
          {
            const { username, notificationToken, deviceId = 'default' } = message;
            await this.notifDB.upsertToken(username, {
              deviceId,
              token: notificationToken
            });
          }
          break;
        case events['push-notification']:
          {
            let messages = [];
            if (Array.isArray(message)) {
              messages = message;
            } else {
              messages = [message];
            }
            const userMessages = messages.reduce((mapping, msg) => {
              const user = msg.META.to;
              if (!mapping[user]) {
                mapping[user] = [];
              }
              mapping[user].push(msg);
              return mapping;
            }, {});
            Object.entries(userMessages).forEach(async ([to, msgs]) => {
              msgs = msgs.filter((msg) => msg.META.type !== 'notification');
              const payloads = msgs.map((msg) => msg.payload);
              const record = await this.notifDB.getToken(to, { deviceId: 'default' });
              if (record) {
                this.notificationMeter.mark();
                const { notificationToken } = record;
                this.pns.push(notificationToken, payloads).catch((err) => {
                  this.failedNotificationMeter.mark();
                  this.log.error(`Error while sending push notification ${err}`, err);
                });
              }
            });
          }
          break;
        default:
          throw new Error("Unknown event type");
      }
    };
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
