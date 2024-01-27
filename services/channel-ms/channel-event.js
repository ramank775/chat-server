const { shortuuid, getUTCTime } = require("../../helper");
const { MessageEvent, MESSAGE_TYPE, CHANNEL_TYPE } = require("../../libs/event-args");

class ChannelEvent extends MessageEvent {
  constructor(groupId, action, actor) {
    super();
    this._version = 3.0;
    this._channel = CHANNEL_TYPE.INDIVIDUAL;
    this._type = MESSAGE_TYPE.NOTIFICATION;
    this._id = shortuuid();
    this._timestamp = getUTCTime();
    this._ephemeral = false;
    this._destination = groupId;
    this._source = actor;
    this._meta.chatId = groupId;
    this._meta.chatid = groupId;
    this._meta.contentType = 'notification';
    this._meta.action = action;
    this._server_id = this._id;
    this._server_timestamp = this._timestamp;
    this._content = {}
  }

  newMembers(members) {
    this._content.added = members;
  }

  removedMembers(members) {
    this._content.removed = members;
  }
}

module.exports = {
  ChannelEvent
}
