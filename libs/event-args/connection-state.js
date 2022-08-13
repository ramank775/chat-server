const Long = require('long');
const { IEventArg } = require('../event-store');
const { getProtoDefination } = require('./util');

const CONNECTION_STATE = {
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
}

class ConnectionStateEvent extends IEventArg {
  static #binary_resource_name = 'UserConnectionState';

  /** @type {string} */
  _user;

  /** @type {'CONNECTED'|'DISCONNECTED'} */
  _state;

  /** @type {string} */
  _gateway;

  static connect(user, gateway) {
    const message = new ConnectionStateEvent();
    message._user = user;
    message._gateway = gateway;
    message._state = CONNECTION_STATE.CONNECTED;
    return message;
  }

  static disconnect(user, gateway) {
    const message = new ConnectionStateEvent();
    message._user = user;
    message._gateway = gateway;
    message._state = CONNECTION_STATE.DISCONNECTED
    return message;
  }

  static fromBinary(payload) {
    const messageDefination = getProtoDefination(this.#binary_resource_name);
    const incomming = messageDefination.decode(payload)
    const json = messageDefination.toObject(incomming, {
      longs: Long,
      enums: String
    })
    const message = new ConnectionStateEvent();
    message._user = json.user;
    message._state = json.state;
    message._gateway = json.gateway;
    return message;
  }

  toBinary() {
    const messageDefination = getProtoDefination(ConnectionStateEvent.#binary_resource_name);
    const message = {
      user: this._user,
      gateway: this._gateway,
      state: this._state
    };
    const temp = messageDefination.create(message);
    return messageDefination.encode(temp).finish();
  }

  get user() {
    return this._user;
  }

  get state() {
    return this._state;
  }

  get gateway() {
    return this._gateway;
  }
}

module.exports = {
  CONNECTION_STATE,
  ConnectionStateEvent
}
