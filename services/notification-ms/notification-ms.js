const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { HttpServiceBase, addHttpOptions, initHttpResource } = require('../../libs/http-service-base');
const eventStore = require('../../libs/event-store');
const { addDatabaseOptions, initializeDatabase } = require('./database');
const { addPNSOptions, initializePNS } = require('./pns');
const { isAllowedTopicUrl } = require('./pns/ntfy-pn-service');
const { EnvelopeEvent } = require('../../libs/v3-envelope');
const { extractInfoFromRequest, schemas, errorEnvelope } = require('../../helper');

const asMain = require.main === module;

const EVENT_TYPE = {
  PUSH_NOTIFICATION: 'push-notification'
}

/** SYNC_PROTOCOL §12.1: no more than one wake per 5 seconds per recipient. */
const WAKE_DEBOUNCE_MS = 5000;

async function prepareEventList(context) {
  const { options } = context;
  const eventName = {
    [EVENT_TYPE.PUSH_NOTIFICATION]: options.offlineMessageTopic
  };
  context.events = eventName;
  context.listenerEvents = [options.offlineMessageTopic];
  return context;
}

async function initResources(options) {
  let context = await initDefaultResources(options)
    .then(prepareEventList)
    .then(initHttpResource)
    .then(initializeDatabase)
    .then(initializePNS);
  context = await eventStore.initializeEventStore({
    consumer: true,
    decodeMessageCb: () => EnvelopeEvent
  })(context);
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd = addDatabaseOptions(cmd);
  cmd = addPNSOptions(cmd);
  cmd.option(
    '--offline-message-topic <offline-message-topic>',
    'Used by producer to produce new message to send the push notification'
  );
  cmd.option(
    '--offline-msg-initial <offline-msg-initial>',
    'Initial for saved messages',
    'persistence-message'
  );
  return cmd.parse(argv).opts();
}

class NotificationMS extends HttpServiceBase {
  /**
   * ponytail: in process debounce, one entry per recently woken user_id.
   * Ceiling: each replica debounces on its own, so N replicas can send N wakes
   * per window. Kafka/nats key partitioning keeps a user on one replica in
   * practice. Upgrade path: libs/cache (redis) if that stops holding.
   * @type {Map<string, number>}
   */
  #lastWakeAt = new Map();

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

  async init() {
    await super.init();
    const { events } = this;
    this.eventStore.on = async (event, message, key) => {
      switch (event) {
        case events[EVENT_TYPE.PUSH_NOTIFICATION]:
          await this.pushNotification(message, key);
          break;
        default:
          throw new Error("Unknown event type");
      }
    };


    this.addRoute(
      '/topic',
      'POST',
      this.registerTopic.bind(this),
      {
        validate: {
          headers: schemas.authHeaders,
          payload: Joi.object({
            topicUrl: Joi.string().uri({ scheme: ['https'] }).allow(null, '').required()
          })
        }
      }
    );

    // AUTH_CONTRACT 4.6 step 3 / 8.2 step 4 — profile-ms calls this on
    // session revoke (scoped to one device) and account delete (every
    // device). No internal readback route exists; deviceId absent = all.
    this.addInternalRoute(
      '/push/topics/delete',
      'POST',
      this.deleteTopics.bind(this),
      {
        validate: {
          payload: Joi.object({
            user_id: Joi.string().required(),
            deviceId: Joi.string()
          })
        }
      }
    );
  }

  async deleteTopics(req) {
    const { user_id: userId, deviceId } = req.payload;
    await this.notifDB.removeTopic(userId, { deviceId });
    return { status: true };
  }

  /**
   * Register, replace or deregister the ntfy topic of the calling device.
   * AUTH_CONTRACT §5.1
   */
  async registerTopic(req, h) {
    const userId = extractInfoFromRequest(req, 'x-user');
    const deviceId = extractInfoFromRequest(req, 'x-device', 'default');
    if (!userId) {
      return h.response(errorEnvelope('UNAUTHORIZED', 'x-user header is required')).code(401);
    }
    const { topicUrl } = req.payload;
    if (!topicUrl) {
      await this.notifDB.removeTopic(userId, { deviceId });
      return { status: true };
    }
    if (!isAllowedTopicUrl(topicUrl, this.options.ntfyBaseUrl)) {
      // AUTH_CONTRACT 5.1
      return h.response(errorEnvelope('INVALID_TOPIC_URL', 'topicUrl must be https on the configured ntfy host')).code(400);
    }
    await this.notifDB.upsertTopic(userId, { deviceId, topicUrl });
    return { status: true };
  }

  /**
   * Wake every device of an offline recipient
   * @param {import('../../libs/v3-envelope').EnvelopeEvent} message
   * @param {string} user recipient user_id
   */
  async pushNotification(message, user) {
    if (!user || (message && message.ephemeral)) return;

    const now = Date.now();
    const lastWakeAt = this.#lastWakeAt.get(user);
    if (lastWakeAt && now - lastWakeAt < WAKE_DEBOUNCE_MS) {
      this.statsClient.increment({
        stat: 'notificaton.delivery.debounced_count',
        tags: { user }
      });
      return;
    }
    if (this.#lastWakeAt.size > 10000) {
      this.#lastWakeAt.forEach((at, key) => {
        if (now - at >= WAKE_DEBOUNCE_MS) this.#lastWakeAt.delete(key);
      });
    }
    this.#lastWakeAt.set(user, now);

    const topics = await this.notifDB.getTopics(user);
    if (!topics || !topics.length) return;

    await Promise.all(topics.map((topic) => this.pns.push(topic.topicUrl)
      .then(() => {
        this.statsClient.increment({
          stat: 'notificaton.delivery.count',
          tags: {
            user,
          }
        });
      }).catch((err) => {
        this.statsClient.increment({
          stat: 'notificaton.delivery.error_count',
          tags: {
            user,
          }
        });
        this.log.error(`Error while sending push notification ${err}`, err);
      })));
  }

  async shutdown() {
    await super.shutdown();
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

module.exports = {
  NotificationMS,
  parseOptions,
  initResources,
  prepareEventList,
}
