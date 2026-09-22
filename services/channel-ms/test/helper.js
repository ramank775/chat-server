const { MongoClient } = require('mongodb');
const { SERVER_EVENT_MARKER } = require('../../../libs/v3-envelope');
const { serverEventPayload } = require('../server-event');
const { ChannelMs, parseOptions, initResource } = require('../channel-ms');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://root:password@localhost:27017/?authSource=admin';

function mongoUrlFor(dbName) {
  const url = new URL(MONGO_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Mint a UUIDv7 `op_id` with the client's layout
 * (packages/vartalap_sync/lib/src/uuid7.dart). Same helper as the gateway's
 * tests; duplicated rather than imported across service test dirs.
 * @param {string} userIdHex 9 lowercase hex chars
 */
/* eslint-disable no-bitwise -- writing a fixed UUIDv7 bit layout */
function mintOpId(userIdHex, { ms = Date.now(), counter = 0, deviceSlot = 0, rand = 1 } = {}) {
  const uid = parseInt(userIdHex, 16);
  const b = Buffer.alloc(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((counter >> 8) & 0x0f);
  b[7] = counter & 0xff;
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

/** Decode the `0x53` server-event payload the service published. */
function decodeServerEvent(envelopeEvent) {
  const { payload } = envelopeEvent.envelope;
  if (payload[0] !== SERVER_EVENT_MARKER) throw new Error('not a server event payload');
  const definition = serverEventPayload();
  return definition.toObject(definition.decode(payload.subarray(1)), {
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true
  });
}

/**
 * Boot channel-ms in process against the real mongo from
 * `deployment/docker-compose.infra.yml`, with a LocalCache and the in-memory
 * event store. No socket is opened: drive it with `inject`.
 * @param {string} dbName database name, unique per test file
 */
async function startChannelMs(dbName) {
  const options = parseOptions([
    'node',
    'channel-ms',
    '--app-name=channel-ms-test',
    '--log-level=error',
    `--mongo-url=${mongoUrlFor(dbName)}`,
    '--channel-db=mongo',
    // LocalCache, not redis: seq/dedup counters must not leak between test
    // files (or into a dev stack) the way a shared redis would.
    '--cache-type=local',
    '--event-store=memory',
    '--new-message-topic=new-message'
  ]);
  // drop first: `initResource` builds the indexes and dropDatabase would take
  // them with it.
  const client = new MongoClient(mongoUrlFor(dbName), { auth: null });
  await client.connect();
  const db = client.db();
  await db.dropDatabase();

  const context = await initResource(options);
  const service = new ChannelMs(context);
  await service.init();
  await service.server.ready();

  return {
    server: service,
    db,
    eventStore: context.eventStore,
    /** @param {import('light-my-request').InjectOptions} request */
    inject: (request) => service.server.inject(request),
    /** Every `EnvelopeEvent` published to the new-message topic. */
    published() {
      return context.eventStore.events
        .filter((e) => e.event === 'new-message')
        .map((e) => e.args);
    },
    /** The last published event, decoded. */
    lastEvent() {
      const events = this.published();
      const last = events[events.length - 1];
      return { recipients: last.recipients, envelope: last.envelope, body: decodeServerEvent(last) };
    },
    async stop() {
      await db.dropDatabase();
      await client.close();
      await service.shutdown();
    }
  };
}

/** A REST write body with the §11.2 op fields filled in. */
function op(userId, seq, extra = {}) {
  return {
    op_id: mintOpId(userId, { counter: seq, rand: seq + 1 }),
    resource_seq: seq,
    client_timestamp_ms: Date.now(),
    ...extra
  };
}

function headers(userId, deviceId = 'device-1') {
  return { 'x-user': userId, 'x-device': deviceId };
}

module.exports = {
  MONGO_URL,
  startChannelMs,
  mintOpId,
  decodeServerEvent,
  op,
  headers
};
