/* eslint-disable max-classes-per-file -- the registry is the redis-shaped half of the manager */
const { Redis } = require('ioredis');
const { MessageEvent } = require('../event-args');

/**
 * Stands in for redis when the whole stack is one process (`--single-gateway`):
 * the user -> gateway routing table and nothing else. Every recipient resolves
 * to this process' own gateway, so `_send` hands them to `messageHandler`
 * directly and nothing is ever published.
 * ponytail: one gateway by definition. Drop the flag and give it a redis
 * endpoint the moment a second gateway exists.
 */
class LocalRegistry {
  #kv = new Map();

  async set(key, value) { this.#kv.set(key, String(value)); }

  async get(key) { return this.#kv.get(key) ?? null; }

  async del(key) { this.#kv.delete(key); }

  async mget(keys) { return keys.map((key) => this.#kv.get(key) ?? null); }

  /* eslint-disable-next-line class-methods-use-this, no-empty-function */
  async publish() { }
}

class DeliveryManager {

  serverId;

  /** @type {Redis} */
  _redis;

  /** @type {Redis} */
  _subscriber;

  /** @type {number} */
  maxRetry;

  /** @type {(msg: MessageEvent) => Promise<void> } */
  offlineMessageHandler;

  /** @type {(msg: MessageEvent) => Promise<string[]> } */
  messageHandler;

  /**
   * Codec for the pubsub payload. v2 carries `MessageEvent`; the v3 sync
   * wire sets this to `EnvelopeEvent` (libs/v3-envelope.js) so a fanout
   * envelope travels between gateways without a v2 `Message` round trip.
   * @type {{ fromBinary: (payload: Buffer) => MessageEvent }}
   */
  eventArg = MessageEvent;


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
    this.singleGateway = !!options.singleGateway;
    this._redis = options.redis
      || (this.singleGateway ? new LocalRegistry() : new Redis(options.redisEndpoint));
    this.serverId = options.serverId;
    this.maxRetry = options.maxRetry || 3;
    if (options.eventArg) this.eventArg = options.eventArg;
  }

  /** The connected client, so the undelivered queue can share it. */
  get redis() {
    return this._redis;
  }

  async startConsumer(redis = null) {
    // one process, one gateway: `_send` never leaves this manager, so there is
    // no pubsub to subscribe to and no health key for anyone to read.
    if (this.singleGateway) return;
    this._subscriber = redis  || new Redis(this._redis.options);
    this._subscriber.on('pmessageBuffer', async (pattern, key, value) => {
      const msg = this.eventArg.fromBinary(value);
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
    const servers = await this._redis.mget(recipients)
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
    .option(
      '--single-gateway',
      'One gateway in this process: deliver in process instead of over redis pubsub',
      false
    )
  return cmd;
}

/**
 * Initialize Delivery manager 
 * @param {{consumer: boolean}} option 
 * @returns 
 */
function init(context) {
  const { redisEndpoint, gatewayName, maxDeliveryAttempt, singleGateway } = context.options
  const options = {
    redisEndpoint,
    serverId: gatewayName,
    maxRetry: maxDeliveryAttempt,
    singleGateway,
  };
  context.deliveryManager = new DeliveryManager(options);
  return context;
}

module.exports = {
  DeliveryManager,
  LocalRegistry,
  addOptions,
  init
}
