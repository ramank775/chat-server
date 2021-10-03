const webSocker = require('ws'),
  { addStandardHttpOptions, initDefaultOptions, initDefaultResources, resolveEnvVariables } = require('../../libs/service-base'),
  { HttpServiceBase } = require('../../libs/http-service-base'),
  kafka = require('../../libs/kafka-utils'),
  { uuidv4 } = require('../../helper'),
  asMain = require.main === module;

async function prepareListEventFromKafkaTopic(context) {
  const { options } = context;
  const eventName = {
    'user-connection-state': options.kafkaUserConnectionStateTopic,
    'new-message': options.kafkaNewMessageTopic
  };
  context.events = eventName;
  return context;
}
async function initResources(options) {
  const context = await initDefaultResources(options).then(prepareListEventFromKafkaTopic).then(kafka.initEventProducer);

  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addStandardHttpOptions(cmd);
  cmd = kafka.addStandardKafkaOptions(cmd);
  cmd = kafka.addKafkaSSLOptions(cmd);
  cmd
    .option('--gateway-name <app-name>', 'Used as gateway server idenitifer for the user connected to this server, as well as the kafka topic for send message')
    .option('--kafka-user-connection-state-topic <user-connection-state-topic>', 'Used by producer to produce message when a user connected/disconnected to server')
    .option('--kafka-new-message-topic <new-message-topic>', 'Used by producer to produce new message for each new incoming message');
  return cmd.parse(argv).opts();
}

class Gateway extends HttpServiceBase {
  constructor(context) {
    super(context);
    const publisher = this.context.publisher;
    const { events } = this.context;
    const serverName = this.options.gatewayName;
    const publishEvent = (event, user, eventArgs) => {
      publisher.send(event, eventArgs, user);
    };
    const userConnectedCounter = this.statsClient.counter({
      name: 'userConnected'
    });
    this.userEvents = {
      onConnect: function (user) {
        userConnectedCounter.inc(1);
        publishEvent(events['user-connection-state'], user, {
          action: 'connect',
          user: user,
          server: serverName
        });
      },
      onDisconnect: function (user) {
        userConnectedCounter.dec(1);
        publishEvent(events['user-connection-state'], user, {
          action: 'disconnect',
          user: user,
          server: serverName
        });
      }
    };
    const newMessageMeter = this.statsClient.meter({
      name: 'newMessage/sec',
      type: 'meter'
    });
    this.messageEvents = {
      onNewMessage: function (message) {
        newMessageMeter.mark();
        publishEvent(events['new-message'], message.META.from, message);
      }
    };

    this.userSocketMapping = {};
    this.pingTimer;
  }
  async init() {
    await super.init();
    const wss = new webSocker.Server({ server: this.hapiServer.listener });
    this.context.wss = wss;
    const { userEvents, messageEvents, userSocketMapping } = this;
    wss.on('connection', (ws, request) => {
      const user = this.getUserInfoFromRequest(request);
      userSocketMapping[user] = ws;
      ws.user = user;
      userEvents.onConnect(user);
      ws.on('message', function (msg) {
        const message = {
          payload: msg,
          META: {
            from: this.user
          }
        };
        messageEvents.onNewMessage(message);
      });
      ws.on('close', function (code, reason) {
        userEvents.onDisconnect(this.user);
        delete userSocketMapping[this.user];
      });
    });

    this.addRoute('/send', 'post', async (req, res) => {
      const items = req.payload.items || [];
      const errors = [];
      items.forEach((messages) => {
        if (!messages.length) return;
        const to = messages[0].META.to;
        const ws = userSocketMapping[to];
        if (ws) {
          const payloads = messages.map((msg) => msg.payload);
          const payload = JSON.stringify(payloads);
          ws.send(payload);
        } else {
          errors.push({
            messages,
            code: 404
          });
        }
      });
      return {
        errors: errors
      };
    });
    this.enablePing();
  }

  // TODO: Let client handles the pings, it offload server load
  enablePing() {
    const { userSocketMapping } = this;
    this.pingTimer = setInterval(() => {
      Object.keys(userSocketMapping).forEach((user) => {
        userSocketMapping[user].ping();
      });
    }, 50 * 1000);
  }

  disablePing() {
    clearInterval(this.pingTimer);
  }

  async shutdown() {
    const { publisher, listener } = this.context;
    publisher.disconnect();
    listener.disconnect();
    this.disablePing();
  }

  getUserInfoFromRequest(request) {
    let user = request.headers.user;
    if (user) return user;
    const rc = request.headers.cookie;
    const cookies = {};
    rc &
      rc.split(';').forEach((cookie) => {
        var parts = cookie.split('=');
        cookies[parts.shift().trim()] = decodeURI(parts.join('='));
      });
    return cookies['user'] || uuidv4();
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
      console.error('Failed to initialized Gateway server', error);
      process.exit(1);
    });
}
