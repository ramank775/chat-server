const WebSocket = require('ws');
const { initDefaultResources } = require('../../../libs/service-base');
const { initHttpResource } = require('../../../libs/http-service-base');
const { LocalCache } = require('../../../libs/cache/local-cache');
const { decodeWsEnvelope, encodeWsEnvelope, WS_TYPE } = require('../../../libs/v3-envelope');
const { Gateway } = require('../ws-gateway');

const ACCESSKEY = 'd4f5a1c9-1234-abcd-5678-ef01234abcde';

/**
 * Mint a UUIDv7 `op_id` with the layout the client uses
 * (packages/vartalap_sync/lib/src/uuid7.dart): 48b ms | 4b ver | 12b counter
 * | 2b variant | 36b user_id | 4b device slot | 18b random.
 * @param {string} userIdHex 9 lowercase hex chars
 */
/* eslint-disable no-bitwise -- writing a fixed UUIDv7 bit layout */
function mintOpId(userIdHex, { ms = Date.now(), counter = 0, deviceSlot = 0, rand = 1 } = {}) {
  const uid = parseInt(userIdHex, 16);
  const b = Buffer.alloc(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((counter >> 8) & 0x0f);
  b[7] = counter & 0xff;
  // Bitwise ops are 32-bit, so the 36-bit user_id is sliced with arithmetic.
  b[8] = 0x80 | (Math.floor(uid / 2 ** 30) % 64);
  b[9] = Math.floor(uid / 2 ** 22) % 256;
  b[10] = Math.floor(uid / 2 ** 14) % 256;
  b[11] = Math.floor(uid / 2 ** 6) % 256;
  b[12] = ((uid % 64) << 2) | ((deviceSlot >> 2) & 0x03);
  b[13] = ((deviceSlot & 0x03) << 6) | ((rand >> 12) & 0x3f);
  b[14] = (rand >> 4) & 0xff;
  b[15] = (rand & 0x0f) << 4;
  const hex = b.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)
  ].join('-');
}
/* eslint-enable no-bitwise */

function opFrame(envelopes) {
  return encodeWsEnvelope({ type: WS_TYPE.WS_OP, ops: { envelopes } });
}

/** Start the real Gateway on an ephemeral port with a local cache and stubs. */
async function startGateway(overrides = {}) {
  const options = {
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    statsClient: 'statsd',
    gatewayName: 'test-gateway',
    newMessageTopic: 'new-message',
    userConnectionStateTopic: 'connection-state',
    reauthGraceMs: 40,
    ...overrides
  };
  let context = await initDefaultResources(options);
  const noop = () => { };
  context.statsClient = { increment: noop, decrement: noop, gauge: noop, timing: noop };
  context.events = {
    'new-message': options.newMessageTopic,
    'connection-state': options.userConnectionStateTopic
  };
  context = await initHttpResource(context);
  context.memCache = new LocalCache();

  const published = [];
  context.eventStore = {
    emit: async (topic, args, key) => { published.push({ topic, args, key }); },
    dispose: async () => { }
  };
  const channels = new Map();
  context.channelServiceClient = {
    isMember: async (channelId, userId) => (channels.get(channelId) || new Set()).has(userId)
  };
  context.deliveryManager = {
    userJoin: async () => { },
    userLeft: async () => { },
    startConsumer: async () => { }
  };

  const gateway = new Gateway(context);
  await gateway.init();
  await gateway.server.listen({ port: options.port, host: options.host });
  return {
    gateway,
    published,
    uri: gateway.uri,
    addChannel(channelId, members) { channels.set(channelId, new Set(members)); },
    publishedEnvelopes() { return published.filter((p) => p.topic === options.newMessageTopic); },
    async stop() { await gateway.shutdown(); }
  };
}

/** Open a client socket the way nginx would proxy it after a successful auth. */
function connect(uri, userId, deviceId = 'device-1', accesskey = ACCESSKEY) {
  const socket = new WebSocket(`${uri.replace('http', 'ws')}/wss`, [`accesskey.${accesskey}`], {
    headers: { 'x-user': userId, 'x-device': deviceId }
  });
  const queue = [];
  const waiters = [];
  const push = (item) => {
    if (waiters.length) waiters.shift()(item);
    else queue.push(item);
  };
  socket.on('message', (data, isBinary) => {
    push(isBinary ? decodeWsEnvelope(data) : data.toString());
  });
  const closed = new Promise((resolve) => {
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const opened = new Promise((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  return {
    socket,
    opened,
    closed,
    get protocol() { return socket.protocol; },
    send(frame) { socket.send(frame, { binary: Buffer.isBuffer(frame) }); },
    next(timeoutMs = 3000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
        waiters.push((item) => { clearTimeout(timer); resolve(item); });
      });
    },
    close() { socket.close(); }
  };
}

module.exports = { ACCESSKEY, mintOpId, opFrame, startGateway, connect };
