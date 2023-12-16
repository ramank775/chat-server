const WebSocket = require('ws');
const URL = require('url');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const EventStore = require('../../libs/event-store');
const { uuidv4, shortuuid, getUTCTime } = require('../../helper');
const { MessageEvent, MESSAGE_TYPE } = require('../../libs/event-args');
const DeliveryManager = require('../../libs/delivery-manager');

const asMain = require.main === module;

const EVENT_TYPE = {
  NEW_MESSAGE_EVENT: 'new-message',
  CLIENT_ACK: 'client-ack',
  OFFLINE_EVENT: 'offline-event',
}

async function prepareListEvent(context) {
  const { options } = context;
  const eventName = {
    [EVENT_TYPE.NEW_MESSAGE_EVENT]: options.newMessageTopic,
    [EVENT_TYPE.CLIENT_ACK]: options.clientAckTopic,
    [EVENT_TYPE.OFFLINE_EVENT]: options.offlineMessageTopic,
  };
  context.events = eventName;
  return context;
}

async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(prepareListEvent)
    .then(initHttpResource)
    .then(EventStore.initializeEventStore({ producer: true }))
    .then(DeliveryManager.init);

  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = EventStore.addEventStoreOptions(cmd);
  cmd = DeliveryManager.addOptions(cmd);
  cmd
    .option(
      '--gateway-name <gateway-name>',
      'Used as gateway server idenitifer for the user connected to this server.'
    )
    .option(
      '--new-message-topic <new-message-topic>',
      'Used by producer to produce new message for each new incoming message'
    )
    .option(
      '--client-ack-topic <client-ack-topic>',
      'Used by producer to produce for ack message received by client.'
    )
    .option(
      '--offline-message-topic <offline-message-topic>',
      'Used by producer to produce new message for offline'
    )
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

    this.publishEvent = async (event, eventArgs, key) => {
      await eventStore.emit(events[event], eventArgs, key);
    };
    this.userSocketMapping = new Map();

    /** @type { import('../../libs/delivery-manager').DeliveryManager } */
    this.deliveryManager = context.deliveryManager;
  }

  async init() {
    await super.init();
    this.initWebsocket();
    this.deliveryManager.offlineMessageHandler = () => { }
    this.deliveryManager.messageHandler = this.messageHandler.bind(this)
    await this.deliveryManager.startConsumer();
  }

  initWebsocket() {
    const wss = new WebSocket.Server({ server: this.httpServer });
    this.context.wss = wss;
    wss.on('connection', (ws, request) => {
      const user = getUserInfoFromRequest(request);
      const url = new URL.URL(request.url, this.uri);
      ws.isbinary = url.searchParams.get('format') === 'binary';
      ws.ackEnabled = url.searchParams.get('ack') === 'true';
      this.onConnect(user, ws);
      ws.on('message', (payload, isBinary) => this.onMessage(payload, isBinary, user));
      ws.on('close', () => this.onDisconnect(user));
    });
  }

  async onMessage(payload, isBinary, user) {
    this.statsClient.increment({
      stat: 'message.received.count',
      tags: {
        channel: 'websocket',
        gateway: this.options.gatewayName,
        user,
      }
    });
    const ws = this.userSocketMapping.get(user);
    if (!isBinary) {
      const msg = payload.toString();
      if (msg === "ping") {
        ws.send("pong");
        return
      }
    }
    const trackId = shortuuid();
    this.context.asyncStorage.run(trackId, async () => {
      const options = {
        source: user
      }
      const message = isBinary ?
        MessageEvent.fromBinary(payload, options)
        : MessageEvent.fromString(payload.toString(), options)
      message.set_server_id(trackId);
      message.set_server_timestamp();
      const event = message.type === MESSAGE_TYPE.CLIENT_ACK ? EVENT_TYPE.CLIENT_ACK : EVENT_TYPE.NEW_MESSAGE_EVENT;
      await this.publishEvent(event, message, message.destination);
      if (ws.ackEnabled && event === EVENT_TYPE.NEW_MESSAGE_EVENT) {
        const ack = message.buildServerAckMessage()
        this.sendWebsocketMessage(user, ack)
      }
    });

  }

  async onConnect(user, ws) {
    this.userSocketMapping.set(user, ws);
    this.statsClient.gauge({
      stat: 'user.connected.count',
      value: '+1',
      tags: {
        service: 'gateway',
        gateway: this.options.gatewayName,
        user,
      }
    });
    await this.deliveryManager.userJoin(user);
  }

  async onDisconnect(user) {
    this.userSocketMapping.delete(user);
    this.statsClient.gauge({
      stat: 'user.connected.count',
      value: -1,
      tags: {
        service: 'gateway',
        gateway: this.options.gatewayName,
        user,
      }
    });
    await this.deliveryManager.userLeft(user);
  }

  async messageHandler(msg) {
    const failure = msg.recipients.filter((rcpt) => {
      const success = this.sendWebsocketMessage(rcpt, msg);
      return !success
    });
    return failure;
  }

  /**
   * Send messages to user via websocket
   * @param {string} user
   * @param {import('../../libs/event-args').MessageEvent} message 
   */
  sendWebsocketMessage(user, message) {
    const ws = this.userSocketMapping.get(user)
    let errorCode = 404;
    if (ws) {
      try {
        const options = {
          ignore: ['recipients'],
        };
        if (ws.isbinary) {
          ws.send(message.toBinary(options), { isBinary: true })
        } else {
          ws.send(message.toString(options));
        }
        this.statsClient.timing({
          stat: 'message.delivery.latency',
          value: getUTCTime() - message.server_timestamp,
          tags: {
            gateway: this.options.gatewayName,
            channel: 'websocket',
            user,
            retry: message.meta.retry || 0,
            saved: message.meta.saved || false,
            sid: message.server_id,
          }
        })
        this.statsClient.increment({
          stat: 'message.delivery.count',
          tags: {
            serverAck: message.isServerAck,
            channel: 'websocket',
            gateway: this.options.gatewayName,
            user,
            format: ws.isbinary ? 'binary' : 'text',
          }
        });
        errorCode = null
      } catch (e) {
        this.log.error('Error while sending websocket message', {
          err: e
        });
        errorCode = 500
      }
    }
    if (errorCode) {
      this.statsClient.increment({
        stat: 'message.delivery.error_count',
        tags: {
          channel: 'websocket',
          gateway: this.options.gatewayName,
          user,
          code: errorCode,
        }
      });
    }
    return errorCode == null;
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
