const protobufjs = require('protobufjs');
const path = require('path');
const Long = require('long');
const { getUTCEpoch, shortuuid } = require('../helper');

function formatMessage(message) {
  const { META, payload } = message;
  const parsedPayload = JSON.parse(payload);
  const msg = {
    _v: parsedPayload._v || 1.0
  };

  if (msg._v >= 2.0) {
    const { id, head, meta, body } = parsedPayload;
    head.from = META.from;
    msg.head = head;
    msg.id = id;
    msg.body = body;
    msg.body.ts = getUTCEpoch();

    Object.assign(META, meta);
    META.to = head.to;
    META.id = id;
    META.type = head.type;
    META.action = head.action;
    // Added in version 2.1
    if (!head.category) {
      // As of v2.0 message with action state/ack as system message else 
      head.category = ['state', 'ack'].includes(head.action) ? 'system' : 'message';
    }
    META.category = head.category

    // Add legacy keys for backward compatibility
    // TODO: remove this in next stable build
    msg.from = META.from;
    msg.to = head.to;
    msg.msgId = id;
    msg.type = head.contentType;
    msg.chatId = head.chatId; // to be deperciated, added for backward comptibility only
    msg.text = body.text;
    msg.module = head.type;
    msg.action = head.action;
    msg.chatType = head.type;
  } else {
    const { to, type, chatType, ..._msg } = parsedPayload;
    Object.assign(msg, _msg);
    msg.from = META.from;
    msg.to = to;
    msg.type = type;
    msg.chatType = chatType;

    // Add new format keys
    msg.id = msg.msgId;
    msg.head = {
      type: chatType || msg.module,
      to,
      from: META.from,
      chatid: msg.chatId,
      contentType: msg.type,
      action: msg.action || 'message',
      category: ['state', 'ack'].includes(msg.action) ? 'system' : 'message'
    };
    msg.body = {
      text: _msg.text,
      ts: getUTCEpoch()
    };

    Object.assign(META, {
      to,
      id: msg.id,
      type: chatType,
      contentType: type,
      action: msg.head.action
    });
  }

  const formattedMessage = {
    META: { ...META, parsed: true },
    payload: msg
  };
  return formattedMessage;
}

let protoRoot = null
function loadProtoDefination(location) {
  if (!location) {
    location = path.join(__dirname, '../proto', 'message.proto');
  }
  protoRoot = protobufjs.loadSync(path)
  return protoRoot;
}

function getProtoDefination(type) {
  if (!protoRoot) {
    protoRoot = loadProtoDefination();
  }
  return protoRoot.lookupType(type)
}

class Message {
  static #binary_resource_name = 'Message';

  /** @type {string|Buffer} */
  _raw;

  /** @type {'string'|'binary'} */
  _raw_format;

  /** @type {number} */
  _version;

  /** @type {string} */
  _id;

  /** @type {number} */
  _type = null;

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

  /** @type {Map<string,string>} */
  _meta = new Map()

  /** @type {string} */
  _server_id;

  /** @type {Long} */
  _server_timestamp;

  static fromString(payload, options) {
    if (!options) options = {}
    const json = JSON.parse(payload);
    const message = new Message();
    message._raw = payload;
    message._raw_format = 'json';
    message._version = json._v || 1.0;
    message._timestamp = getUTCEpoch();
    if (message._version >= 2.0) {
      message._id = json.id;
      const { type, to, from, ephemeral, ...others } = json.head;
      message._source = from || options.source;
      message._destination = to;
      message._type = type;
      message._ephemeral = ephemeral;
      Object.entries(others)
        .forEach(([key, value]) => {
          message._meta.set(key, value)
        })
      Object.entries(json.meta)
        .forEach(([key, value]) => {
          message._meta.set(`_m${key}`, value)
        })
      message._content = json.body
    } else {
      message._id = json.msgId;
      message._type = json.chatType || json.module;
      message._source = json.from || options.source;
      message._destination = json.to;
      message._content = {
        text: json.text
      }
      message._meta.set('chatid', json.chatId);
      message._meta.set('action', json.action);
      message._meta.set('state', json.state);
    }
    return message;
  }

  static fromBinary(payload, options) {
    if (!options) options = {}
    const messageDefination = getProtoDefination(this.#binary_resource_name);
    const incomming = messageDefination.decode(payload)
    const json = messageDefination.toObject(incomming, {
      longs: Long,
      enums: String
    })
    const message = new Message();
    message._raw = payload;
    message._raw_format = 'binary';

    message._version = json.version;
    message._id = json.id;
    message._content = json.content;
    message._type = json.type;
    message._ephemeral = json.ephemeral;
    message._source = options.source || json.source;
    message._destination = json.destination;
    message._timestamp = json.timestamp;
    message._content = json.content;
    message._meta = json.meta || new Map();
    message._server_id = json.server_id;
    message._server_timestamp = json.server_timestamp;
    if (options.source) this._raw = null;
    return message;
  }

  toString(version = 2.1) {
    let body = this._content
    if (typeof this._content === 'string') {
      body = JSON.parse(this._content)
    }
    const message = {
      _v: version,
      id: this._id,
      head: {
        type: this._type,
        to: this._source,
        from: this._destination,
        ephemeral: this._ephemeral
      },
      body
    }
    this._meta.forEach((value, key) => {
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
    return JSON.stringify(message)
  }

  toBinary() {
    if (this._raw && this._raw_format === 'binary')
      return this._raw;

    const messageDefination = getProtoDefination(this.#binary_resource_name);
    let content = this._content;
    if (typeof this._content === 'object') {
      content = JSON.stringify(this._content)
    }
    const message = {
      version: this._version,
      id: this._id,
      type: this._type,
      ephemeral: this._ephemeral || false,
      source: this._source,
      destination: this._destination,
      timestamp: this._timestamp,
      content,
      meta: this._meta,
      server_id: this._server_id,
      server_timestamp: this._server_timestamp
    }
    const errorMessage = messageDefination.verify(message)
    if (errorMessage) {
      throw Error(errorMessage)
    }
    const temp = messageDefination.create(errorMessage)
    return messageDefination.encode(temp).finish()
  }

  buildServerAckMessage() {
    const ackMessage = new Message();
    ackMessage._version = this._version;
    ackMessage._id = this._id;
    ackMessage._ephemeral = true;
    ackMessage._destination = this._source;
    ackMessage._source = 'server';
    ackMessage._server_id = this._server_id;
    ackMessage._server_timestamp = this._server_timestamp;
    ackMessage._type = 'ServerAck';
    return ackMessage;
  }

  /**
   * @param {string?} id
   */
  set_server_id(id) {
    id ||= shortuuid()
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
    ts ||= getUTCEpoch();
    this._server_timestamp = Long.fromNumber(ts)
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

  get ephemeral() {
    return this._ephemeral;
  }

  get source() {
    return this._source;
  }

  get destination() {
    return this._destination;
  }
}


module.exports = {
  formatMessage,
  loadProtoDefination,
  Message
};
