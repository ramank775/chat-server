const Long = require('long');
const { getUTCTime, shortuuid } = require('../../helper');
const { IEventArg } = require('../event-store');
const { getProtoDefination } = require('./util');

const MESSAGE_TYPE = {
  SERVER_ACK: 'SERVER_ACK',
  CLIENT_ACK: 'CLIENT_ACK',
  MESSAGE: 'MESSAGE',
  NOTIFICATION: 'NOTIFICATION',
  CUSTOM: 'CUSTOM'
}
const CHANNEL_TYPE = {
  UNKNOWN: 'UNKNOWN',
  INDIVIDUAL: 'INDIVIDUAL',
  GROUP: 'GROUP',
}

/**
 * @typedef {Object} SerializationOption
 * @property {number | null} version
 * @property {string[] | null} ignore
 */

class MessageEvent extends IEventArg {
  static #binary_resource_name = 'Message';

  /** @type {string|Buffer} */
  _raw;

  /** @type {'string'|'binary'} */
  _raw_format;

  /** @type {number} */
  _version;

  /** @type {string} */
  _id;

  /** @type {string} */
  _type = null;

  /** @type {string} */
  _channel = null;

  /** @type {bool} */
  _ephemeral = false;

  /** @type {string} */
  _source;

  /** @type {string} */
  _destination;

  /** @type {Long} */
  _timestamp;

  /** @type {string|Buffer|Object} */
  _content;

  /** @type {Record<string, string>} */
  _meta = {}

  /** @type {string[]|null} */
  _recipients = null;

  /** @type {string} */
  _server_id;

  /** @type {Long} */
  _server_timestamp;

  static fromObject(payload, options) {
    const message = new MessageEvent();
    message._version = payload._v || 1.0;
    message._timestamp = getUTCTime();
    if (message._version >= 2.0) {
      message._id = payload.id;
      const { type, to, from, ephemeral, contentType, ...others } = payload.head;
      message._source = from || options.source;
      message._destination = to;
      message._channel = type.toUpperCase();
      message._type = contentType.toUpperCase();
      if (!Object.values(MESSAGE_TYPE).includes(message._type)) {
        message._type = MESSAGE_TYPE.MESSAGE
      }
      message._ephemeral = ephemeral;
      Object.entries(others)
        .forEach(([key, value]) => {
          message._meta[key] = `${value}`;
        })
      message._meta.contentType = contentType;
      message._content = payload.body
    } else {
      message._id = payload.msgId;
      message._channel = (payload.chatType || payload.module).toUpperCase();
      message._type = payload.type.toUpperCase()
      message._source = payload.from || options.source;
      message._destination = payload.to;
      message._content = {
        text: payload.text
      }
      message._meta.chatid = payload.chatId || payload.chatid;
      message._meta.action = payload.action;
      message._meta.state = payload.state;
    }
    message._recipients = payload.recipients
    return message;
  }

  static fromString(payload, options) {
    if (!options) options = {}
    const json = JSON.parse(payload);
    return MessageEvent.fromObject(json);
  }

  static fromBinary(payload, options) {
    if (!options) options = {}
    const messageDefination = getProtoDefination(MessageEvent.#binary_resource_name);
    const incomming = messageDefination.decode(payload)
    const json = messageDefination.toObject(incomming, {
      longs: Long,
      enums: String
    })
    const message = new MessageEvent();
    message._raw = payload;
    message._raw_format = 'binary';

    message._version = json.version;
    message._id = json.id;
    message._content = json.content;
    message._type = json.type;
    message._channel = json.channel;
    message._ephemeral = json.ephemeral;
    message._source = options.source || json.source;
    message._destination = json.destination;
    message._recipients = json.recipients;
    message._timestamp = json.timestamp;
    message._meta = json.meta || {};
    message._server_id = json.serverId;
    message._server_timestamp = json.serverTimestamp;
    if (options.source) this._raw = null;
    return message;
  }

  clone() {
    const cloneMessage = new MessageEvent();
    cloneMessage._version = this._version;
    cloneMessage._id = this._id;
    cloneMessage._type = this._type;
    cloneMessage._channel = this._channel;
    cloneMessage._ephemeral = this._ephemeral;
    cloneMessage._source = this._source;
    cloneMessage._destination = this._destination;
    cloneMessage._timestamp = this._timestamp;
    cloneMessage._content = this._content;
    cloneMessage._meta = this._meta;
    cloneMessage._recipients = this._recipients;
    cloneMessage._server_id = this._server_id;
    cloneMessage._server_timestamp = this._server_timestamp;
    return cloneMessage;
  }

  /**
   * Convert to JSON Object
   * @param {SerializationOption} options 
   * @returns 
   */
  toObject(options = {}) {
    let body = this._content
    if (typeof this._content === 'string') {
      body = JSON.parse(this._content)
    } else if (Buffer.isBuffer(this._content)) {
      body = JSON.parse(this._content.toString('utf-8'))
    }
    const version = options?.version || 2.1;
    const message = {
      _v: version,
      id: this._id,
      head: {
        type: this._channel,
        from: this._source,
        to: this._destination,
        contentType: this._type,
        ephemeral: this._ephemeral
      },
      body: body || {}
    }
    Object.entries(this._meta).forEach(([key, value]) => {
      if (key.startsWith('_m')) {
        return;
      }
      message.head[key] = value;
    })
    if (!message.head.category) {
      message.head.category = ['state', 'ack'].includes(message.head.action) ? 'system' : 'message';
    }
    message.from = this._source;
    message.to = this._destination;
    message.msgId = this._id;
    message.type = message.head.contentType;
    message.chatId = message.head.chatId;
    message.text = typeof message.body === 'object' ? message.body.text : '[unknown]';
    message.module = message.head.type;
    message.action = message.head.action;
    message.chatType = message.head.type;

    message.recipients = message._recipients;

    (options?.ignore || []).forEach((prop) => {
      delete message[prop]
    })

    return message;
  }

  /**
   * Serialize as string
   * @param {SerializationOption} options 
   * @returns 
   */
  toString(options = {}) {
    const message = this.toObject(options);
    return JSON.stringify(message)
  }

  /**
   * Serialize as binary
   * @param {SerializationOption} options 
   * @returns 
   */
  toBinary(options = {}) {
    if (this._raw && this._raw_format === 'binary')
      return this._raw;

    const messageDefination = getProtoDefination(MessageEvent.#binary_resource_name);
    let content = this._content;
    if (Buffer.isBuffer(this._content)) {
      content = this._content
    } else if (this._content instanceof Uint8Array) {
      content = Buffer.from(this._content)
    } else if (typeof this._content === 'object') {
      content = JSON.stringify(this._content)
      content = Buffer.from(content, 'utf-8')
    } else if (content) {
      content = Buffer.from(content.toString(), 'utf-8')
    }
    const message = {
      version: this._version,
      id: this._id,
      type: messageDefination.Type[this._type],
      channel: messageDefination.Channel[this._channel],
      ephemeral: this._ephemeral || false,
      source: this._source,
      destination: this._destination,
      recipients: this._recipients,
      timestamp: this._timestamp,
      content,
      meta: this._meta,
      serverId: this._server_id,
      serverTimestamp: this._server_timestamp
    }
    (options?.ignore || []).forEach((prop) => {
      delete message[prop]
    })
    const errorMessage = messageDefination.verify(message);
    if (errorMessage) {
      throw new Error(errorMessage)
    }
    const temp = messageDefination.create(message)
    return messageDefination.encode(temp).finish()
  }

  buildServerAckMessage() {
    const ackMessage = new MessageEvent();
    ackMessage._version = this._version;
    ackMessage._id = this._id;
    ackMessage._ephemeral = true;
    ackMessage._destination = this._source;
    ackMessage._source = 'server';
    ackMessage._server_id = this._server_id;
    ackMessage._server_timestamp = this._server_timestamp;
    ackMessage._type = MESSAGE_TYPE.SERVER_ACK;
    ackMessage._channel = CHANNEL_TYPE.INDIVIDUAL;
    return ackMessage;
  }

  setRecipients(recipients) {
    if (!Array.isArray(recipients)) {
      throw new Error('Recipients should be an array');
    }
    this._recipients = recipients;
    this._raw = null;
  }

  hasRecipients() {
    return Boolean(this._recipients && this._recipients.length);
  }

  /**
   * @param {string?} id
   */
  set_server_id(id) {
    id = id || shortuuid()
    this._server_id = id;
    this._raw = null;
  }

  get server_id() {
    return this._server_id
  }

  /**
   * @param {number} ts 
   */
  set_server_timestamp(ts) {
    ts = ts || getUTCTime();
    this._server_timestamp = Long.fromNumber(ts);
    this._raw = null;
  }

  get server_timestamp() {
    return this._server_timestamp;
  }

  get id() {
    return this._id;
  }

  get type() {
    return this._type;
  }

  get channel() {
    return this._channel;
  }

  get ephemeral() {
    return this._ephemeral;
  }

  get source() {
    return this._source;
  }

  get destination() {
    return this._destination;
  }

  get recipients() {
    return this._recipients;
  }

  get isServerAck() {
    return this.type === MESSAGE_TYPE.SERVER_ACK;
  }
}

module.exports = {
  MESSAGE_TYPE,
  CHANNEL_TYPE,
  MessageEvent
}
