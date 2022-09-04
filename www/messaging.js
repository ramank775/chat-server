/* eslint-disable node/no-unsupported-features/es-syntax */
/* eslint-disable max-classes-per-file */
/* eslint-disable no-console */
let id = 0
function getMsgId(to) {
  id += 1
  return to + Date.now() + id;
}

function base64ToArrayBuffer(base64) {
  return new Uint8Array(window.atob(base64).split("").map((c) => c.charCodeAt(0)));
}

/**
 * Convert buffer to base64 string
 * @param {Uint8Array} data 
 * @returns 
 */
function arrayBufferToBase64(data) {
  return window.btoa(String.fromCharCode.apply(null, data));
}

export class Message {
  version;

  _id;

  type;

  channel;

  source;

  destination;

  ephemeral;

  timestamp;

  content;

  meta = {};

  server_id;

  server_timestamp;

  get id() {
    return this._id || getMsgId(this.source)
  }

  set id(value) {
    this._id = value
  }
}

class MessageV3 extends Message {
  static _protodef = {
    "nested": {
      "Message": {
        "fields": {
          "version": { "type": "float", "id": 1 },
          "id": { "type": "string", "id": 2 },
          "type": { "type": "Type", "id": 3 },
          "channel": { "type": "Channel", "id": 4 },
          "ephemeral": { "type": "bool", "id": 5 },
          "source": { "type": "string", "id": 6 },
          "destination": { "type": "string", "id": 7 },
          "content": { "type": "bytes", "id": 8 },
          "timestamp": { "type": "uint64", "id": 9 },
          "meta": { "keyType": "string", "type": "string", "id": 10 },
          "serverId": { "type": "string", "id": 20 },
          "serverTimestamp": { "type": "uint64", "id": 21 }
        },
        "nested": {
          "Type": {
            "values": {
              "SERVER_ACK": 0,
              "CLIENT_ACK": 1,
              "MESSAGE": 2,
              "NOTIFICATION": 3,
              "CUSTOM": 10
            }
          },
          "Channel": {
            "values": {
              "UNKNOWN": 0,
              "INDIVIDUAL": 1,
              "GROUP": 2,
              "OTHER": 10
            }
          }
        }
      }
    }
  };

  static _protoRoot;


  static getProtoMessageType() {
    if (MessageV3._protoRoot == null) {
      // eslint-disable-next-line no-undef
      MessageV3._protoRoot = protobuf.Root.fromJSON(MessageV3._protodef)
    }
    return MessageV3._protoRoot.lookup('Message')
  }

  static fromMessage(message) {
    const messageV3 = new MessageV3();
    Object.assign(messageV3, message)
    return messageV3;
  }

  static decode(data, base64) {
    let buffer;
    if (base64) {
      buffer = base64ToArrayBuffer(data);
    } else {
      buffer = new Uint8Array(data);
    }
    const MessageDef = MessageV3.getProtoMessageType()
    const incomming = MessageDef.decode(buffer)
    const json = MessageDef.toObject(incomming, {
      enums: String
    });
    const messageV3 = new MessageV3()
    if (json.content)
      json.content = (new TextDecoder('utf-8')).decode(json.content)
    Object.assign(messageV3, json)
    return messageV3;
  }

  encode(base64 = false) {
    const MessageDef = MessageV3.getProtoMessageType()
    let { content } = this;
    if (typeof this.content === 'object') {
      content = JSON.stringify(this.content)
      content = (new TextEncoder('utf-8')).encode(content)
    }
    const message = {
      version: 3.0,
      id: this.id,
      type: MessageDef.Type[this.type],
      channel: MessageDef.Channel[this.channel],
      ephemeral: this.ephemeral || false,
      source: this.source,
      destination: this.destination,
      timestamp: this.timestamp,
      content,
      meta: this.meta,
    }
    const errorMessage = MessageDef.verify(message);
    if (errorMessage) {
      throw new Error(errorMessage)
    }
    const temp = MessageDef.create(message)
    const buffer = MessageDef.encode(temp).finish()
    if (base64) {
      return arrayBufferToBase64(buffer);
    }
    return buffer
  }
}

class MessageV2 extends Message {
  static fromMessage(message) {
    const messageV2 = new MessageV2();
    Object.assign(messageV2, message)
    return messageV2;
  }

  static decode(data) {
    const json = JSON.parse(data)
    const { type, to, from, ephemeral, ...others } = json.head;
    const meta = {}
    Object.entries(others)
      .forEach(([key, value]) => {
        meta[key] = `${value}`;
      })
    const messageV2 = new MessageV2()
    Object.assign(messageV2, {
      version: json._v || 2.1,
      id: json.id,
      type: meta.contentType,
      channel: type,
      source: from,
      destination: to,
      ephemeral,
      meta,
      content: json.body
    })
    return messageV2
  }

  encode() {
    const message = {
      _v: 2.1,
      id: this.id,
      head: {
        type: this.channel,
        from: this.source,
        to: this.destination,
        ephemeral: this.ephemeral
      },
      meta: {},
      body: this.content
    }
    Object.entries(this.meta).forEach(([key, value]) => {
      if (key.startsWith('_m')) {
        message.meta[key.replace('_m', '')] = value
      }
      message.head[key] = value;
    })
    return JSON.stringify(message);
  }
}

class MessageV1 extends Message {

  static fromMessage(message) {
    const messageV1 = new MessageV1();
    Object.assign(messageV1, message)
    return messageV1;
  }

  static decode(data) {
    const json = JSON.stringify(data)
    const messageV1 = new MessageV1()
    Object.assign(messageV1, {
      version: json._v || 1.0,
      id: json.msgId,
      type: json.chatType,
      source: json.from,
      destination: json.to,
      ephemeral: false,
      meta: {
        chatId: json.chatId,
        module: json.module,
        action: json.action
      },
      content: json.text
    })
    return messageV1
  }

  encode() {
    const message = {
      _v: 1.0,
      msgId: this.id,
      from: this.source,
      to: this.destination,
      chatId: this.destination,
      text: typeof this.content === 'object' ? JSON.stringify(this.content) : this.content,
      module: this.type,
      action: this.meta.action,
      state: this.meta.state,
      type: this.type,
      chatType: this.type,
    }
    return JSON.stringify(message)
  }
}

class MessageEncoder {
  static encode(message, version, base64) {
    switch (version) {
      case 1.0:
        return MessageV1.fromMessage(message).encode();
      case 2.0:
        return MessageV2.fromMessage(message).encode();
      case 3.0:
        return MessageV3.fromMessage(message).encode(base64);
      default:
        throw Error(`Invalid message version ${version}`)
    }
  }

  static decode(message, base64) {
    if (base64 || message instanceof ArrayBuffer) {
      return MessageV3.decode(message, base64);
    }

    const json = JSON.parse(message)
    if (json._v >= 2.0) {
      return MessageV2.decode(message)
    }
    return MessageV1.decode(message);

  }
}

// eslint-disable-next-line no-unused-vars, node/no-unsupported-features/es-syntax
export class Messaging extends EventTarget {
  _tokenManager;

  /** @type {WebSocket} */
  _ws;

  _timer;

  message_version = 3.0;

  server_ack = true;

  client_ack = true;

  channel = 'ws';

  constructor(tokenManager) {
    super();
    this._tokenManager = tokenManager;
  }

  static async login(option) {
    return fetch('/v1.0/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(option)
    })
      .then((res) => {
        if (res.ok) {
          return res.json();
        }
        throw new Error('Login failed');
      })
  }

  getMessageFormat() {
    return this.message_version === 3.0 ? 'binary' : 'text'
  }

  /**
   * 
   * @param {Message} message 
   * @returns 
   */
  isClientAckRequired(message) {
    if (!this.client_ack) return false
    return !["SERVER_ACK", "CLIENT_ACK"].includes(message.type)
  }

  getHeaders() {
    const [username, accesskey] = this._tokenManager.get();
    return new Headers({
      'Content-Type': 'application/json',
      'user': username,
      'accesskey': accesskey
    })
  }

  async connectSocket() {
    if (this._ws) {
      this._ws.close()
      this._ws = null
    }
    if (window.WebSocket) {
      console.log('WebSocket object is supported in your browser');
      const url = new URL('v1.0/wss/', window.location);
      url.protocol = url.protocol === 'https:' ? 'wss' : 'ws';
      url.searchParams.append('ack', this.server_ack);
      url.searchParams.append('format', this.getMessageFormat())
      const startTime = Date.now();
      this._ws = new WebSocket(url);
      this._ws.binaryType = "arraybuffer";
      this._ws.onopen = () => {
        console.log('connection time', Date.now() - startTime);
        const event = new CustomEvent('connection', { detail: { status: 'connected' } })
        this.dispatchEvent(event);
        console.log('onopen');
      };

      this._ws.onmessage = (e) => {
        if (e.data === "pong") return;
        const message = MessageEncoder.decode(e.data)
        const event = new CustomEvent('message', { detail: message });
        this.dispatchEvent(event)
        if (this.isClientAckRequired(message)) {
          const cack = new MessageV3()
          cack.version = message.version;
          cack.id = message.id;
          cack.timestamp = Math.floor(Date.now() / 1000);
          const [username] = this._tokenManager.get()
          cack.source = username;
          cack.destination = 'server';
          cack.ephemeral = true
          cack.content = null;
          cack.meta = {};
          cack.channel = 'INDIVIDUAL';
          cack.type = 'CLIENT_ACK';
          this.sendViaWebSocket(cack);
        }

        console.log(`echo from server : ${message}`);
      };

      this._ws.onclose = () => {
        console.log('onclose');
        const event = new CustomEvent('connection', { detail: { status: 'disconnected' } });
        this.dispatchEvent(event);
        clearInterval(this._timer);
        this._timer = null;
      };

      this._ws.onerror = function onerror() {
        console.log('onerror');
        const event = new CustomEvent('connection', { detail: { status: 'disconnected' } });
        this.dispatchEvent(event);
        clearInterval(this._timer);
        this._timer = null;
      };
      this._timer = setInterval(() => {
        this._ws.send("ping");
      }, 30000)
    } else {
      console.log('WebSocket object is not supported in your browser');
    }
  }

  async sendViaWebSocket(message) {
    const raw = MessageEncoder.encode(message, this.message_version)
    this._ws.send(raw);
  }

  async sendViaRest(message) {
    const url = new URL('/v1.0/messages', window.location)
    url.searchParams.append('format', this.getMessageFormat())
    url.searchParams.append('ack', this.server_ack)
    const payload = [MessageEncoder.encode(message, this.message_version, true)]
    return fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload)
    })
      .then((resp) => resp.json())
      .then(({ acks }) => {
        if (!acks) return {}
        acks.forEach(ack => {
          const mack = MessageEncoder.decode(ack, true);
          const event = new CustomEvent('message', { detail: mack });
          this.dispatchEvent(event);
        })
      })
  }

  /**
   * Send message based
   * @param {Message} message 
   */
  async send(message) {
    const [username] = this._tokenManager.get();
    message.source = username;
    if (this.channel === 'ws') {
      this.sendViaWebSocket(message)
    } else {
      this.sendViaRest(message)
    }
  }

  async getGroups() {
    return fetch('/v1.0/groups/', {
      headers: this.getHeaders()
    })
      .then((res) => res.json());
  }

  async createGroup(name, members) {
    const payload = {
      name,
      members,
      profilePic: null
    };
    return fetch('/v1.0/groups/', {
      method: 'post',
      body: JSON.stringify(payload),
      headers: this.getHeaders()
    })
      .then((res) => res.json());
  }

  async enableServerAck() {
    if (this.server_ack) return;
    this.server_ack = true;
    this.connectSocket();
  }

  async disableServerAck() {
    if (!this.server_ack) return;
    this.server_ack = false;
    this.connectSocket();
  }

  enableClientAck() {
    this.client_ack = true;
  }

  disableClientAck() {
    this.client_ack = false;
  }

  updateMessageVersion(version) {
    if (![1.0, 2.0, 3.0].includes(version)) {
      throw Error('Message version is not valid');
    }
    this.message_version = version;
  }

  updateMessageChannel(channel) {
    if (!['ws', 'rest'].includes(channel)) {
      throw Error('Messsage channel is not valid')
    }
    this.channel = channel
  }
}
