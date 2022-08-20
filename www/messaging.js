/* eslint-disable node/no-unsupported-features/es-syntax */
/* eslint-disable max-classes-per-file */
/* eslint-disable no-console */
let id = 0
function getMsgId(to) {
  id += 1
  return to + Date.now() + id;
}

function base64ToArrayBuffer(base64) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export class Message {
  version;

  _id;

  type;

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
          "ephemeral": { "type": "bool", "id": 4 },
          "source": { "type": "string", "id": 5 },
          "destination": { "type": "string", "id": 6 },
          "timestamp": { "type": "uint64", "id": 7 },
          "content": { "type": "bytes", "id": 8 },
          "meta": { "keyType": "string", "type": "string", "id": 9 },
          "serverId": { "type": "string", "id": 10 },
          "serverTimestamp": { "type": "uint64", "id": 11 }
        },
        "nested": {
          "Type": {
            "values": {
              "SERVER_ACK": 0,
              "CLIENT_ACK": 1,
              "INDIVIDUAL": 2,
              "NOTIFICATION": 3,
              "GROUP": 4,
              "CUSTOM": 10
            }
          }
        }
      },
    }
  };

  static _protoRoot;


  static getProtoMessageType() {
    if (MessageV3._protoRoot == null) {
      // eslint-disable-next-line no-undef
      MessageV3._protoRoot = protobuf.Type.fromJSON(MessageV3._protodef)
    }
    return MessageV3._protoRoot.lookup('Message')
  }

  static decode(data, base64) {
    if (base64) {
      data = base64ToArrayBuffer(data)
    }
    const MessageDef = MessageV3.getProtoMessageType()
    const incomming = MessageDef.decode(data)
    const json = MessageDef.toObject(incomming, {
      enums: String
    });
    const messageV3 = new MessageV3()
    Object.assign(messageV3, json)
    return messageV3;
  }

  encode(base64 = false) {
    const MessageDef = MessageV3.getProtoMessageType()
    let content = this._content;
    if (typeof this._content === 'object') {
      content = JSON.stringify(this._content)
      content = (new TextEncoder()).encode(content)
    }
    const message = {
      version: 3.0,
      id: this.id,
      type: MessageDef.Type[this._type],
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
      return window.btoa(String.fromCharCode.apply(...buffer))
    }
    return buffer
  }
}

class MessageV2 extends Message {
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
      version: json._v,
      id: json.id,
      type,
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
        type: this.type,
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
    if (message instanceof ArrayBuffer) {
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
  _tokenManger;

  /** @type {WebSocket} */
  _ws;

  _timer;

  message_version = 3.0;

  server_ack = false;

  client_ack = false;

  channel = 'ws';

  constructor(tokenManager) {
    super();
    this._tokenManger = tokenManager;
  }

  static async login(option) {
    fetch('/v1.0/login', {
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
    return this.message_version === 'v3' ? 'binary' : 'text'
  }

  getHeaders() {
    const [username, accesskey] = this._tokenManger.get();
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
      const { protocol, hostname } = window.location;

      const socketUrl = `${protocol === 'https:' ? 'wss' : 'ws'}://${hostname}/v1.0/wss/?ack=true`
      const startTime = Date.now();
      this._ws = new WebSocket(socketUrl);
      this._ws.binaryType = "arraybuffer";
      this._ws.onopen = () => {
        console.log('connection time', Date.now() - startTime);
        const event = new CustomEvent('connection', { detail: { status: 'connected' } })
        this.dispatchEvent(event);
        console.log('onopen');
      };

      this._ws.onmessage = (e) => {
        if (e.data === "pong") return;
        const binary = e.data instanceof ArrayBuffer
        const message = MessageEncoder.decode(e.data, binary)
        const event = new CustomEvent('message', { detail: message });
        this.dispatchEvent(event)
        if (this.client_ack) {
          const cack = new MessageV3()
          cack.version = message.verison;
          cack.id = message.id;
          cack.timestamp = Math.floor(Date.now() / 1000);
          const [username] = this._tokenManager.get()
          cack.source = username;
          cack.destination = 'server';
          cack.ephemeral = true
          cack.content = null;
          cack.meta = {};

          this._ws.send()
        }

        console.log(`echo from server : ${e.data}`);
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
    fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify([JSON.stringify(message)])
    })
      .then((resp) => resp.json(payload))
      .then(({ acks }) => {
        if (!acks) return {}
        acks.forEach(ack => {
          const mack = MessageEncoder.decode(ack, true);
          const event = new CustomEvent('message', { detail: mack });
          this.dispatchEvent(event);
        })
      })
  }

  async send(message) {
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
