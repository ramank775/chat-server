const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../libs/http-service-base');
const { initMongoClient } = require('../libs/mongo-utils');
const MemCache = require('../libs/cache');
const EventStore = require('../libs/event-store');
const ChannelServiceClient = require('../libs/channel-service-client');
const DeliveryManager = require('../libs/delivery-manager');
const UndeliveredQueue = require('../libs/delivery-manager/undelivered-queue');
const { EnvelopeEvent } = require('../libs/v3-envelope');
const { errorEnvelope } = require('../helper');

const profileMs = require('./profile-ms/profile-ms');
const { profileDB } = require('./profile-ms/database');
const { initializeAuthProvider, AuthError } = require('./profile-ms/auth-provider');
const channelMs = require('./channel-ms/channel-ms');
const channelDb = require('./channel-ms/database');
const messageMs = require('./message-ms/message-ms');
const notificationMs = require('./notification-ms/notification-ms');
const notificationDb = require('./notification-ms/database');
const pns = require('./notification-ms/pns');
const mediaMs = require('./media-ms/media-metadata-ms');
const mediaDb = require('./media-ms/database');
const mediaStorage = require('./media-ms/media-storage');
const wsGateway = require('./connection-gateway/ws-gateway');
const messageDelivery = require('./message-delivery/message-delivery-worker');

const asMain = require.main === module;

/** The `/v3.0` prefix nginx strips, kept here because there is no nginx. */
const API = '/v3.0';

/**
 * deployment/config/nginx/nginx.docker.conf `location ~* ^/auth/`: the only
 * prefix below `/v3.0` nginx proxies without the `/auth` subrequest. Everything
 * else under `/v3.0` is authenticated, `/wss` included (see `wsVerify`).
 */
const PUBLIC_ROUTES = /^\/v3\.0\/auth\//;

/**
 * Every service's own option groups over one argv. The groups that overlap —
 * mongo, cache, event store, topics, service endpoints — are the same flags
 * with the same defaults in every service, so they collapse to one value.
 * The monolith's own parse runs last so its defaults (in process event store,
 * in process cache) win over the ones meant for a distributed deployment.
 */
function parseOptions(argv) {
  const parsers = [
    profileMs.parseOptions,
    channelMs.parseOptions,
    messageMs.parseOptions,
    notificationMs.parseOptions,
    mediaMs.parseOptions,
    wsGateway.parseOptions,
    messageDelivery.parseOptions
  ];
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd
    .option('--event-store <event-source>', 'Which event store to use (kafka, nats, memory)', 'memory')
    .option('--cache-type <cache-type>', 'Type of cache service (local, redis)', 'local')
    .option(
      '--self-url <self-url>',
      'Base url the services use to reach each other over http (decision 71)'
    );
  const options = parsers.reduce(
    (merged, parse) => Object.assign(merged, parse(argv)),
    {}
  );
  Object.assign(options, cmd.parse(argv).opts());

  options.selfUrl = options.selfUrl || `http://127.0.0.1:${options.port}`;
  // decision 71: the internal calls stay http, they just all land back here
  options.channelMsEndpoint = options.selfUrl;
  options.gatewayEndpoint = options.selfUrl;
  options.notificationMsEndpoint = options.selfUrl;
  options.gatewayName = options.gatewayName || 'monolith-gateway';
  // one process, one gateway: no cross-gateway pubsub to run
  options.singleGateway = true;
  return options;
}

/** The resources every service shares: http server, mongo, cache, delivery. */
async function initSharedResources(options) {
  const context = await initDefaultResources(options).then(initHttpResource);
  context.mongoClient = initMongoClient(context);
  await MemCache.initMemCache(context);
  await ChannelServiceClient.init(context);
  DeliveryManager.init(context);
  // one queue: message-delivery writes it, message-ms drains it
  await UndeliveredQueue.init(context);
  return context;
}

/**
 * A service's own context: the shared resources, whatever `extra` its
 * `initResource` would have added, and its own event store (one bus, that
 * service's topics).
 */
async function serviceContext(shared, steps, eventStoreOptions) {
  let context = { ...shared };
  // eslint-disable-next-line no-restricted-syntax
  for (const step of steps) {
    // deliberately serial: each step reads what the previous one added
    // eslint-disable-next-line no-await-in-loop
    context = (await step(context)) || context;
  }
  return eventStoreOptions ? EventStore.initializeEventStore(eventStoreOptions)(context) : context;
}

/**
 * The `/auth` subrequest nginx ran ahead of every proxied request, in process.
 * @param {profileMs.ProfileMs} profile
 */
function authHook(profile) {
  return async (req, reply) => {
    const path = req.url.split('?')[0];
    // `/alive`, `/_internal/...` and `/wss` were never behind the subrequest
    if (!path.startsWith(`${API}/`)) return undefined;
    // nginx: `proxy_set_header x-user ""` — a client never supplies its identity
    delete req.headers['x-user'];
    delete req.headers['x-device'];
    if (PUBLIC_ROUTES.test(path)) return undefined;
    try {
      const { session } = await profile.resolveSession(req, profileMs.isUsernameGated(path));
      req.headers['x-user'] = session.user_id;
      req.headers['x-device'] = session.deviceId;
      return undefined;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      // nginx `@auth_error`: the client sees profile-ms' §11 envelope and status
      return reply
        .code(error.status)
        .send(errorEnvelope(error.code, error.message, error.extra));
    }
  };
}

/**
 * The same check for the ws upgrade, which never reaches fastify: node emits
 * `upgrade`, not `request`, so `ws` runs it instead of the hook above.
 * @param {profileMs.ProfileMs} profile
 */
function wsVerify(profile) {
  return (info, cb) => {
    const { req } = info;
    delete req.headers['x-user'];
    delete req.headers['x-device'];
    // AUTH_CONTRACT 13.3 — the handshake is never username gated
    profile
      .resolveSession(req, false)
      .then(({ session }) => {
        req.headers['x-user'] = session.user_id;
        req.headers['x-device'] = session.deviceId;
        cb(true);
      })
      .catch((error) => {
        const envelope = error instanceof AuthError
          ? { status: error.status, body: errorEnvelope(error.code, error.message, error.extra) }
          : { status: 500, body: errorEnvelope('INTERNAL_ERROR', 'Internal server error') };
        cb(false, envelope.status, JSON.stringify(envelope.body), {
          'Content-Type': 'application/json'
        });
      });
  };
}

/**
 * Decisions 70 and 71: every service of the microservice stack in one process,
 * one fastify server, mounted where nginx used to proxy them. The services are
 * the same classes the standalone entry points run.
 */
class Monolith extends HttpServiceBase {
  #initialized = false;

  constructor(context) {
    super(context);
    /** @type {{service: HttpServiceBase, prefix: string}[]} */
    this.mounts = context.mounts;
    /** @type {import('../libs/service-base').ServiceBase[]} */
    this.workers = context.workers;
    /** Every `/_internal/...` route, collected while the services mount. */
    this.internalRoutes = context.internalRoutes;
    this.profile = context.profileService;
  }

  async init() {
    if (this.#initialized) return;
    this.#initialized = true;
    await super.init();

    this.server.addHook('onRequest', authHook(this.profile));

    this.mounts.forEach(({ service, prefix }) => {
      this.server.register(async (app) => {
        // routes registered by `init()` land on this encapsulated scope, so
        // each service keeps its own hooks, error handler and 404 code
        service.server = app;
        await service.init();
      }, { prefix });
    });
    // registered last, so every service has contributed its internal routes by
    // the time this plugin boots: they stay at the root, off the api prefix
    this.server.register(async (app) => {
      this.internalRoutes.forEach((route) => app.route(route));
    });

    this.workers.forEach((worker) => worker.init());
  }

  async run() {
    await this.init();
    return super.run();
  }

  async shutdown() {
    await super.shutdown();
    // every service shares one mongo client and one cache: a second close is a
    // no-op, but a failure must not stop the rest from shutting down
    const services = [...this.mounts.map((mount) => mount.service), ...this.workers];
    await Promise.all(
      services.map((service) =>
        service.shutdown().catch((error) => this.log.error(`Shutdown failed: ${error.message}`))
      )
    );
  }
}

/**
 * Build every service against the shared resources and mount it where nginx
 * proxied it.
 * @param {object} options
 */
async function initResources(options) {
  const shared = await initSharedResources(options);
  /** @type {object[]} */
  const internalRoutes = [];
  const mount = (prefix) => ({ mount: { prefix, internal: internalRoutes } });

  const profileContext = await serviceContext(
    shared,
    [profileDB.initializeDatabase, initializeAuthProvider],
    { producer: true }
  );
  const profile = new profileMs.ProfileMs({ ...profileContext, ...mount(API) });

  const channelContext = await serviceContext(shared, [channelDb.initializeDatabase], {
    producer: true
  });
  const channel = new channelMs.ChannelMs({ ...channelContext, ...mount(`${API}/channels`) });

  const message = new messageMs.MessageMs({ ...shared, ...mount(`${API}/sync`) });

  const notificationContext = await serviceContext(
    shared,
    [notificationMs.prepareEventList, notificationDb.initializeDatabase, pns.initializePNS],
    { consumer: true, decodeMessageCb: () => EnvelopeEvent }
  );
  const notification = new notificationMs.NotificationMS({
    ...notificationContext,
    ...mount(`${API}/push`)
  });

  const mediaContext = await serviceContext(shared, [mediaDb.initialize, mediaStorage.initialize]);
  const media = new mediaMs.MediaMetadataMS({ ...mediaContext, ...mount(`${API}/assets`) });

  const gatewayContext = await serviceContext(shared, [wsGateway.prepareListEvent], {
    producer: true
  });
  const gateway = new wsGateway.Gateway({
    ...gatewayContext,
    ...mount('/wss'),
    wsVerify: wsVerify(profile)
  });

  const deliveryContext = await serviceContext(shared, [messageDelivery.prepareEventList], {
    producer: true,
    consumer: true,
    decodeMessageCb: () => EnvelopeEvent
  });
  const worker = new messageDelivery.MessageDeliveryWorker(deliveryContext);

  return {
    ...shared,
    profileService: profile,
    internalRoutes,
    workers: [worker],
    mounts: [
      { service: profile, prefix: API },
      { service: channel, prefix: `${API}/channels` },
      { service: message, prefix: `${API}/sync` },
      { service: notification, prefix: `${API}/push` },
      { service: media, prefix: `${API}/assets` },
      { service: gateway, prefix: '/wss' }
    ]
  };
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResources(options)
    .then(async (context) => {
      await new Monolith(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized the monolith', error);
      process.exit(1);
    });
}

module.exports = {
  Monolith,
  parseOptions,
  initResources,
  authHook,
  wsVerify
};
