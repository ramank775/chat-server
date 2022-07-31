const webSocker = require('ws');
const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const EventStore = require('../../libs/event-store');
const { uuidv4, shortuuid, extractInfoFromRequest, schemas } = require('../../helper');

const asMain = require.main === module;

async function prepareListEvent(context) {
  const { options } = context;
  const eventName = {
    'user-connection-state': options.userConnectionStateTopic,
    'new-message': options.newMessageTopic
  };
  context.events = eventName;
  return context;
}
async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(prepareListEvent)
    .then(initHttpResource)
    .then(EventStore.initializeEventStore({ producer: true }));

  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = EventStore.addEventStoreOptions(cmd);
  cmd
    .option(
      '--gateway-name <app-name>',
      'Used as gateway server idenitifer for the user connected to this server, as well as the kafka topic for send message'
    )
    .option(
      '--user-connection-state-topic <user-connection-state-topic>',
      'Used by producer to produce message when a user connected/disconnected to server'
    )
    .option(
      '--new-message-topic <new-message-topic>',
      'Used by producer to produce new message for each new incoming message'
    );
  return cmd.parse(argv).opts();
}

/**
 * Helper function to parser cookie from Raw request
 */
function getUserInfoFromRequest(request) {
  const { user } = request.headers;
  if (user) return user;
  const rc = request.headers.cookie;
  const cookies = {};
  if (rc) {
    rc.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      cookies[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return cookies.user || uuidv4();
}

class Gateway extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {{eventStore: import('../../libs/event-store/iEventStore').IEventStore}} */
    const {
      eventStore,
      events
    } = this.context;
    const serverName = this.options.gatewayName;
    const publishEvent = (event, user, eventArgs) => {
      eventStore.emit(event, eventArgs, user);
    };
    const userConnectedCounter = this.statsClient.counter({
      name: 'userConnected'
    });
    this.userEvents = {
      onConnect(user) {
        userConnectedCounter.inc(1);
        publishEvent(events['user-connection-state'], user, {
          action: 'connect',
          user,
          server: serverName
        });
      },
      onDisconnect(user) {
        userConnectedCounter.dec(1);
        publishEvent(events['user-connection-state'], user, {
          action: 'disconnect',
          user,
          server: serverName
        });
      }
    };
    const newMessageMeter = this.statsClient.meter({
      name: 'newMessage/sec',
      type: 'meter'
    });
    this.messageEvents = {
      onNewMessage(message, from) {
        newMessageMeter.mark();
        const event = {
          payload: message,
          META: {
            from,
            sid: shortuuid(),
            rts: Date.now()
          }
        };
        publishEvent(events['new-message'], from, event);
      }
    };

    this.userSocketMapping = {};
  }

  async init() {
    await super.init();
    const wss = new webSocker.Server({ server: this.httpServer });
    this.context.wss = wss;
    const { asyncStorage } = this.context;
    const { userEvents, messageEvents, userSocketMapping } = this;
    wss.on('connection', (ws, request) => {
      const user = getUserInfoFromRequest(request);
      userSocketMapping[user] = ws;
      ws.user = user;
      userEvents.onConnect(user);
      ws.on('message', function onMessage(rawmsg) {
        const msg = rawmsg.toString();
        if (msg === "ping") {
          ws.send("pong");
          return
        }
        const trackId = shortuuid();
        asyncStorage.run(trackId, () => {
          messageEvents.onNewMessage(msg, this.user);
        });
      });
      ws.on('close', function onClose(_code, _reason) {
        userEvents.onDisconnect(this.user);
        delete userSocketMapping[this.user];
      });
    });

    this.addRoute('/send', 'post', async (req, _res) => {
      const items = req.payload.items || [];
      const errors = [];
      items.forEach((messages) => {
        if (!messages.length) return;
        const { to } = messages[0].META;
        const ws = userSocketMapping[to];
        if (ws) {
          const { payloads, meta } = messages.reduce(
            (acc, msg) => {
              acc.payloads.push(msg.payload);
              if (msg.META.sid) {
                acc.meta.push(msg.META);
              }
              return acc;
            },
            {
              payloads: [],
              meta: []
            }
          );
          const payload = JSON.stringify(payloads);
          ws.send(payload);
          const sentAt = Date.now();
          const latencies = meta.map((m) => ({
            sid: m.sid,
            latency: sentAt - m.rts,
            saved: m.saved,
            retry: m.retry
          }));
          this.log.info(`Message delivery to user`, { latencies });
        } else {
          errors.push({
            messages,
            code: 404
          });
        }
      });
      return {
        errors
      };
    });

    this.addRoute(
      '/messages',
      'post',
      this.newMessage.bind(this),
      {
        validate: {
          headers: schemas.authHeaders,
          payload: Joi.array().items(Joi.string()).min(1).required()
        }
      }
    );
  }

  async newMessage(req, res) {
    const user = extractInfoFromRequest(req, 'user');
    const messages = req.payload;
    messages.forEach((message) => {
      this.messageEvents.onNewMessage(message, user);
    });
    return res.response().code(201);
  }

  async shutdown() {
    await super.shutdown()
    const { eventStore } = this.context;
    await eventStore.dispose()

  }

}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResources(options)
    .then(async (context) => {
      await new Gateway(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Gateway server', error);
      process.exit(1);
    });
}
