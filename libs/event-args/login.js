const Long = require('long');
const { IEventArg } = require('../event-store');
const { getProtoDefination } = require('./util');

class LoginEvent extends IEventArg {
  static #binary_resource_name = 'Login';

  /** @type {string} */
  _user;

  /** @type {string} */
  _deviceId;

  /** @type {string} */
  _notificationToken;

  /** @type {number} */
  _messageVersion = 2.1;

  constructor(args) {
    super()
    this._user = args.user;
    this._deviceId = args.deviceId;
    this._notificationToken = args.notificationToken;
    this._messageVersion = args._messageVersion || 2.1;
  }

  static fromBinary(payload) {
    const messageDefination = getProtoDefination(this.#binary_resource_name);
    const incomming = messageDefination.decode(payload)
    const json = messageDefination.toObject(incomming, {
      longs: Long,
      enums: String
    })
    const message = new LoginEvent();
    message._user = json.user;
    message._deviceId = json.deviceId;
    message._notificationToken = json.notificationToken;
    message._messageVersion = json.messageVersion;
    return message;
  }

  toBinary() {
    const messageDefination = getProtoDefination(LoginEvent.#binary_resource_name);
    const message = {
      user: this._user,
      deviceId: this._deviceId,
      notificationToken: this._notificationToken,
      messageVersion: this._messageVersion,
    };
    const temp = messageDefination.create(message);
    return messageDefination.encode(temp).finish();
  }

  get user() {
    return this._user;
  }

  get deviceId() {
    return this._deviceId;
  }

  get notificationToken() {
    return this._notificationToken;
  }

  get messageVersion() {
    return this._messageVersion;
  }
}

module.exports = {
  LoginEvent
}
