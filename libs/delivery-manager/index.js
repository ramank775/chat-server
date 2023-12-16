const { Redis } = require('ioredis');
const { MessageEvent } = require('../event-args');

class DeliveryManager {

  serverId;

  /** @type {Redis} */
  _redis;

  /** @type {Redis} */
  _subscriber;

  /** @type {(msg: MessageEvent) => Promise<void> } */
  offlineMessageHandler;

  /** @type {(msg: MessageEvent) => Promise<string[]> } */
  messageHandler;


  async _onMessage(msg, retry = 0) {
    if (!this.messageHandler) {
      return
    }
    const recipients = this.messageHandler(msg);
    if (recipients?.length) {
      this._send(msg, recipients, retry + 1, true)
    }
  }

  async _handleOfflineMessage(msg) {
    if (!this.offlineMessageHandler) {
      return;
    }
    await this.offlineMessageHandler(msg);
  }

  async _handleAlivePing() {
    await this._redis.set(`gateway:${this.serverId}:health`, 1, 'EX', 2)
  }

  constructor(options) {
    this._redis = new Redis(options.redisEndpoint);
    this.serverId = options.server_id;
    this.maxRetry = options.maxRetry || 3;
  }

  async startConsumer() {
    this._subscriber = new Redis(this._redis.options);
    this._subscriber.on('pmessageBuffer', async (pattern, key, value) => {
      const msg = MessageEvent.fromBinary(value);
      const [, retryStr] = key.toString().split('|');
      const retry = Number(retryStr);
      await this._onMessage(msg, retry);
    });
    await this._subscriber.psubscribe(`msg:${this.serverId}:*`)

    setInterval(this._handleAlivePing.bind(this), 700);
  }

  async userJoin(user) {
    await this._redis.set(`${user}`, this.serverId);
  }

  async userLeft(user) {
    await this._redis.del(`${user}`);
  }

  async _send(message, recipients, retry = 0, ignoreSelf = false) {
    if (retry > this.maxRetry) {
      const msg = message.clone();
      msg.setRecipients(recipients);
      this._handleOfflineMessage(msg)
      return;
    }
    const servers = await this._redis.getAll(recipients)
    const recipientGroups = servers.reduce((acc, value, idx) => {
      value = value || 'offline';
      if (!acc.has(value)) {
        acc.set(value, [])
      }
      acc.get(value).push(recipients[idx])
      return acc;
    }, new Map())
    await this._handleOfflineRecipientGroup(recipientGroups, message);
    await this._handleSelfRecipientGroup(recipientGroups, message, ignoreSelf);
    await this._sendToRecipientGroup(recipientGroups, message, retry);
  }

  async _handleOfflineRecipientGroup(recipientGroups, message) {
    if (recipientGroups.has('offline')) {
      const offlineRecipients = recipientGroups.get('offline');
      const msg = message.clone();
      msg.setRecipients(offlineRecipients);
      await this._handleOfflineMessage(msg);
      recipientGroups.delete('offline');
    }
  }

  async _handleSelfRecipientGroup(recipientGroups, message, ignoreSelf) {
    if (recipientGroups.has(this.serverId)) {
      const rcpts = recipientGroups.get(this.serverId);
      if (rcpts.length) {
        const msg = message.clone();
        msg.setRecipients(rcpts);
        if (ignoreSelf) {
          await this._handleOfflineMessage(msg);
        } else {
          await this._onMessage(msg);
        }
      }
      recipientGroups.delete(this.serverId);
    }
  }

  async _sendToRecipientGroup(recipientGroups, message, retry) {
    recipientGroups.forEach(async (rcpts, server) => {
      const msg = message.clone();
      msg.setRecipients(rcpts);
      const isAlive = await this._redis.get(`gateway:${server}:health`)
      if (!isAlive) {
        await this._handleOfflineMessage(msg);
        return
      }
      await this._redis.publish(`msg:${server}:${retry}`, msg.toBinary())
        .catch(async () => {
          await this._handleOfflineMessage(msg);
        });
    })
  }

  /**
   * 
   * @param {import('../event-args').MessageEvent} message 
   */
  async dispatch(message) {
    await this._send(message, message.recipients)
  }
}

function addOptions(cmd) {
  cmd = cmd
    .option(
      '--max-delivery-attempt <max-delivery-attempt>',
      'Max retry attempt to deliver a message',
      (value) => Number(value),
      3
    )
    .option(
      '--redis-endpoint <redis-endpoint>',
      'Redis endpoint to connet with in case of redis cache', 
      '127.0.0.1:6379'
    )
  return cmd;
}

/**
 * Initialize Delivery manager 
 * @param {{consumer: boolean}} option 
 * @returns 
 */
function init(context) {
  const { redisEndpoint, gatewayName, maxDeliveryAttempt } = context.options
  const options = {
    redisEndpoint,
    serverId: gatewayName,
    maxRetry: maxDeliveryAttempt,
  };
  context.deliveryManager = new DeliveryManager(options);
  return context;
}

module.exports = {
  DeliveryManager,
  addOptions,
  init
}
