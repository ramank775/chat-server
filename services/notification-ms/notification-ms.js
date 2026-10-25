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
const { isAcceptableEndpoint, isValidPushKeys } = require('./pns/webpush-pn-service');
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
  return cmd.parse(argv).opts();
}

class NotificationMS extends HttpServiceBase {
  /**
   * ponytail: in process debounce, one entry per recently woken subject.
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
          // ponytail: not awaited, so a push service backing off (retries,
          // Retry-After) never stalls the offline-message consumer. Ceiling:
          // in flight pushes are unbounded under a burst, the debounce caps
          // them at one per recipient per 5 s.
          this.pushNotification(message, key).catch((err) => {
            this.log.error(`Error while sending push notification ${err}`, err);
          });
          break;
        default:
          throw new Error("Unknown event type");
      }
    };


    // AUTH_CONTRACT 5.0
    this.addRoute(
      '/vapid',
      'GET',
      async () => ({ vapidPublicKey: this.options.vapidPublicKey }),
      { validate: { headers: schemas.authHeaders } }
    );

    this.addRoute(
      '/topic',
      'POST',
      this.registerTopic.bind(this),
      {
        validate: {
          headers: schemas.authHeaders,
          payload: Joi.object({
            endpoint: Joi.string().allow(null, '').required(),
            // shape checked in the handler: a bad key is INVALID_PUSH_KEYS
            p256dh: Joi.any(),
            auth: Joi.any()
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
   * Register, replace or deregister the Web Push endpoint of the calling
   * device. AUTH_CONTRACT §5.1
   */
  async registerTopic(req, h) {
    const userId = extractInfoFromRequest(req, 'x-user');
    const deviceId = extractInfoFromRequest(req, 'x-device', 'default');
    if (!userId) {
      return h.response(errorEnvelope('UNAUTHORIZED', 'x-user header is required')).code(401);
    }
    const { endpoint, p256dh, auth } = req.payload;
    if (!endpoint) {
      await this.notifDB.removeTopic(userId, { deviceId });
      return { status: true };
    }
    if (!(await isAcceptableEndpoint(endpoint, this.options.pushAllowPrivateEndpoints))) {
      return h
        .response(errorEnvelope('INVALID_PUSH_ENDPOINT', 'endpoint must be an https url on a public host'))
        .code(400);
    }
    if (!isValidPushKeys(p256dh, auth)) {
      return h
        .response(errorEnvelope('INVALID_PUSH_KEYS', 'p256dh must be a 65 byte P-256 point and auth 16 bytes, base64url'))
        .code(400);
    }
    await this.notifDB.upsertTopic(userId, { deviceId, endpoint, p256dh, auth });
    return { status: true };
  }

  /**
   * Wake the one offline device a queued frame is waiting for. The key is the
   * `user_id:device_id` subject message-delivery queued under, so the wake,
   * the queue and the endpoint share one key (TRIM_4_12_CONTRACT §7).
   * @param {import('../../libs/v3-envelope').EnvelopeEvent} message
   * @param {string} subject recipient `user_id:device_id`
   */
  async pushNotification(message, subject) {
    if (!subject || (message && message.ephemeral)) return;
    const [user, device] = subject.split(':');

    const now = Date.now();
    const lastWakeAt = this.#lastWakeAt.get(subject);
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
    this.#lastWakeAt.set(subject, now);

    // ponytail: rows from the ntfy era carry only `topicUrl`, they stay
    // dormant until the device registers a Web Push endpoint
    const topics = (await this.notifDB.getTopics(user))
      .filter((topic) => topic.deviceId === device && topic.endpoint);
    if (!topics.length) return;

    await Promise.all(topics.map((topic) => this.pns.push(topic)
      .then(async (status) => {
        // AUTH_CONTRACT 5.2 case 4: the push service says the endpoint is gone
        if (status === 404 || status === 410) {
          await this.notifDB.removeTopic(user, { deviceId: device, endpoint: topic.endpoint });
        }
        const delivered = status >= 200 && status < 300;
        this.statsClient.increment({
          stat: delivered ? 'notificaton.delivery.count' : 'notificaton.delivery.error_count',
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
