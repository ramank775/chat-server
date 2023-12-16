const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const EventStore = require('../../libs/event-store');
const { extractInfoFromRequest, schemas, base64ToProtoBuffer } = require('../../helper');
const { MessageEvent, MESSAGE_TYPE } = require('../../libs/event-args');

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
      '--new-message-topic <new-message-topic>',
      'Used by producer to produce new message for each new incoming message'
    )
    .option(
      '--client-ack-topic <client-ack-topic>',
      'Used by producer to produce for ack message received by client.'
    );
  return cmd.parse(argv).opts();
}

class RestGateway extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
    this.events = this.context.events;
    /** @type {import('./database/message-db').IMessageDB} */
    this.db = this.context.db;
  }

  async init() {
    await super.init();
    this.addRoute(
      '/',
      'get',
      this.getMessage.bind(this),
      {
        validate: {
          headers: schemas.authHeaders,
        }
      }
    );
    this.addRoute(
      '/',
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

  async publishEvent(event, eventArgs, key) {
    await this.eventStore.emit(this.events[event], eventArgs, key);
  };

  async newMessage(req, res) {
    const user = extractInfoFromRequest(req, 'user');
    const { format, ack } = req.query;
    const messages = req.payload;
    if (!messages.length) return res.response({}).code(200);

    this.statsClient.increment({
      stat: 'message.received.count',
      value: messages.length,
      tags: {
        channel: 'rest',
        gateway: this.options.gatewayName,
        user,
      }
    });

    const msgFormat = format || typeof messages[0];
    const promises = messages.map(async (msg) => {
      let event;
      const options = {
        source: user
      }
      switch (msgFormat) {
        case 'binary':
          {
            const bmsg = base64ToProtoBuffer(msg);
            event = MessageEvent.fromBinary(bmsg, options);
          }
          break;
        case 'string':
          event = MessageEvent.fromString(msg, options);
          break;
        default:
          event = MessageEvent.fromObject(msg, options)
          break;
      }
      event.set_server_id();
      event.set_server_timestamp();
      const type = event.type === MESSAGE_TYPE.CLIENT_ACK ? EVENT_TYPE.CLIENT_ACK : EVENT_TYPE.NEW_MESSAGE_EVENT;
      await this.publishEvent(type, event, event.destination);
      if (ack) {
        return event.buildServerAckMessage()
      }
    })
    const acks = await Promise.all(promises);
    const options = {
      ignore: ['recipients'],
    };
    const response = ack ? {
      acks: acks.map((m) => {
        switch(msgFormat) {
          case 'binary':
            return m.toBinary(options).toString('base64');
          case 'string':
            return m.toString(options);
          default:
            return m.toObject(options)
        }
      })
    } : {}
    return res.response(response).code(201);
  }

  async getMessage(req, res) {
    const user = extractInfoFromRequest(req, 'user');
    if (!user) {
      return res.response().code(403);
    }
    const { format } = req.query;
    const isbinary = format === 'binary';
    const chats = [];
    const messages = await this.db.getUndeliveredMessage(chats, user);
    const options = {
      ignore: ['recipients'],
    };
    const finalMessages = messages.map((message) => {
      if (isbinary) return message.toBinary(options);
      return message.toObject(options)
    })
    const response = {
      messages: finalMessages,
    };
    return res.response(response).code(200)
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResources(options)
    .then(async (context) => {
      await new RestGateway(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Rest Gatway', error);
      process.exit(1);
    });
}
