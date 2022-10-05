const webSocker = require('ws');
const Joi = require('joi');
const URL = require('url');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const EventStore = require('../../libs/event-store');
const { uuidv4, shortuuid, extractInfoFromRequest, schemas, base64ToProtoBuffer, getUTCTime } = require('../../helper');
const { MessageEvent, ConnectionStateEvent, MESSAGE_TYPE } = require('../../libs/event-args');

const asMain = require.main === module;

const EVENT_TYPE = {
  CONNECTION_EVENT: 'connection-state',
  NEW_MESSAGE_EVENT: 'new-message',
  CLIENT_ACK: 'client-ack',
}

async function prepareListEvent(context) {
  const { options } = context;
  const eventName = {
    [EVENT_TYPE.CONNECTION_EVENT]: options.userConnectionStateTopic,
    [EVENT_TYPE.NEW_MESSAGE_EVENT]: options.newMessageTopic,
    [EVENT_TYPE.CLIENT_ACK]: options.clientAckTopic,
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
      'Used as gateway server idenitifer for the user connected to this server.'
    )
    .option(
      '--user-connection-state-topic <user-connection-state-topic>',
      'Used by producer to produce message when a user connected/disconnected to server'
    )
    .option(
      '--new-message-topic <new-message-topic>',
      'Used by producer to produce new message for each new incoming message'
    )
    .option(
      '--client-ack-topic <client-ack-topic>',
      'Used by producer to produce for ack message received by client.'
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

    this.publishEvent = async (event, eventArgs, key) => {
      await eventStore.emit(events[event], eventArgs, key);
    };
    this.userSocketMapping = new Map();
  }

  async init() {
    await super.init();
    this.initWebsocket();

    this.addRoute('/send', 'post', this.sendRestMessage.bind(this));

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

  initWebsocket() {
    const wss = new webSocker.Server({ server: this.httpServer });
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

  async newMessage(req, res) {
    const user = extractInfoFromRequest(req, 'user');
    const { format, ack } = req.query;
    const isbinary = format === 'binary';
    const messages = req.payload;

    this.statsClient.increment({
      stat: 'in-message',
      value: messages.length,
      tags: {
        channel: 'rest',
        gateway: this.options.gatewayName,
        user,
      }
    });

    const promises = messages.map(async (msg) => {
      let event;
      const options = {
        source: user
      }
      if (isbinary) {
        const bmsg = base64ToProtoBuffer(msg);
        event = MessageEvent.fromBinary(bmsg, options);
      } else {
        event = MessageEvent.fromString(msg, options);
      }
      event.set_server_id();
      event.set_server_timestamp();
      await this.publishEvent(EVENT_TYPE.NEW_MESSAGE_EVENT, event, event.destination);
      if (ack) {
        return event.buildServerAckMessage()
      }
    })
    const acks = await Promise.all(promises);
    const response = ack ? {
      acks: acks.map((m) => (isbinary ?
        m.toBinary().toString('base64')
        : m.toString()
      ))
    } : {}
    return res.response(response).code(201);
  }

  async onMessage(payload, isBinary, user) {
    this.statsClient.increment({
      stat: 'in-message',
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
    this.statsClient.increment({
      stat: 'user-connected',
      tags: {
        service: 'gateway',
        gateway: this.options.gatewayName,
        user,
      }
    });
    const message = ConnectionStateEvent.connect(user, this.options.gatewayName);
    await this.publishEvent(EVENT_TYPE.CONNECTION_EVENT, message, user);
  }

  async onDisconnect(user) {
    this.userSocketMapping.delete(user);
    this.statsClient.decrement({
      stat: 'user-connected',
      tags: {
        service: 'gateway',
        gateway: this.options.gatewayName,
        user,
      }
    });
    const message = ConnectionStateEvent.disconnect(user, this.options.gatewayName);
    await this.publishEvent(EVENT_TYPE.CONNECTION_EVENT, message, user);
  }

  async sendRestMessage(req, _res) {
    const items = req.payload.items || [];
    const errors = [];
    items.forEach((item) => {
      const { receiver, messages, meta } = item
      if (!messages.length) return;
      const ws = this.userSocketMapping.get(receiver);
      if (ws) {
        const uError = []
        messages.forEach((m) => {
          try {
            const message = MessageEvent.fromBinary(Buffer.from(m.raw));
            this.sendWebsocketMessage(receiver, message);
            this.statsClient.timing({
              stat: 'message-latency',
              value: getUTCTime() - message.server_timestamp,
              tags: {
                gateway: this.options.gatewayName,
                channel: 'websocket',
                user: receiver,
                retry: meta.retry || 0,
                saved: meta.saved || false,
                sid: message.server_id,
              }
            })
          } catch (e) {
            uError.push({
              code: 500,
              error: e,
              sid: m.sid
            });
          }
        })
        errors.push({
          receiver,
          messages: uError
        })
        if (uError.length) {
          this.statsClient.increment({
            stat: 'out-message-error',
            value: uError.length,
            tags: {
              channel: 'websocket',
              gateway: this.options.gatewayName,
              user: receiver,
              code: 500,
            }
          })
        }
      } else {
        errors.push({
          code: 404,
          receiver,
          messages: messages.map((m) => ({ sid: m.sid }))
        });
        this.statsClient.increment({
          stat: 'out-message-error',
          tags: {
            channel: 'websocket',
            gateway: this.options.gatewayName,
            user: receiver,
            code: 404,
          }
        })
      }
    });
    return {
      errors
    };
  }

  /**
   * Send messages to user via websocket
   * @param {string} user
   * @param {import('../../libs/event-args').MessageEvent} message 
   */
  sendWebsocketMessage(user, message) {
    const ws = this.userSocketMapping.get(user)
    if (ws.isbinary) {
      ws.send(message.toBinary(), { isBinary: true })
    } else {
      ws.send(message.toString());
    }
    this.statsClient.increment({
      stat: 'out-message',
      tags: {
        serverAck: message.isServerAck,
        channel: 'websocket',
        gateway: this.options.gatewayName,
        user,
        format: ws.isbinary ? 'binary' : 'text',
      }
    });
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
