const crypto = require('crypto');
const path = require('path');
const protobufjs = require('protobufjs');
const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const {
  WS_TYPE,
  SERVER_EVENT_MARKER,
  encodeWsEnvelope,
  decodeWsEnvelope
} = require('../../libs/v3-envelope');
const { mintOpId } = require('../../services/connection-gateway/test/helper');

/**
 * Conformance suite: drives the compose stack through nginx rather than
 * `server.inject`. Every assertion is on the wire the client will see.
 * Skipped entirely unless CONFORMANCE_BASE_URL points at a running nginx.
 */
const BASE = process.env.CONFORMANCE_BASE_URL || null;

/** deployment/docker-compose.infra.yml maps mongo's 27017 straight to the host. */
const MONGO_URL = process.env.CONFORMANCE_MONGO_URL
  || 'mongodb://root:password@localhost:27017/chat?authSource=admin';

/** @type {protobufjs.Type} */
let serverEventType = null;

/** Decode the `ServerEventPayload` behind the 0x53 marker (SYNC_PROTOCOL 10.2). */
function decodeServerEvent(payload) {
  if (!payload || !payload.length || payload[0] !== SERVER_EVENT_MARKER) return null;
  if (!serverEventType) {
    serverEventType = protobufjs
      .loadSync(path.join(__dirname, '..', '..', 'proto', 'v3-server-event-payload.proto'))
      .lookupType('vartalap.v3.payload.ServerEventPayload');
  }
  const message = serverEventType.decode(Buffer.from(payload).subarray(1));
  return serverEventType.toObject(message, { enums: String, longs: Number, defaults: true });
}

/**
 * One REST call against nginx.
 * @param {string} method
 * @param {string} url path below the base url
 * @param {{token?: string, body?: object}} opts
 * @returns {Promise<{status: number, body: *}>}
 */
async function api(method, url, { token, body } = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    // a proxy error page or an empty 204: hand the raw text to the assertion
  }
  return { status: response.status, body: parsed };
}

/** The code the mock sms sender produced, via profile-ms `--expose-dev-otp`. */
async function devOtp(phone) {
  const { status, body } = await api('GET', `/v3.0/auth/dev/otp?phone=${encodeURIComponent(phone)}`);
  if (status !== 200) throw new Error(`dev otp unavailable (${status}): ${JSON.stringify(body)}`);
  return body.code;
}

/**
 * Direct read of notification-ms's `push_topics` collection — there is no
 * internal readback route, so this is the only way to prove a deregister
 * actually happened.
 * @param {string} userId
 * @param {string} deviceId
 */
async function pushTopic(userId, deviceId) {
  const client = new MongoClient(MONGO_URL, { auth: null });
  try {
    await client.connect();
    // must be awaited here: `finally` closes the connection before an
    // un-awaited return value would get the chance to use it
    return await client.db().collection('push_topics').findOne({ user_id: userId, deviceId });
  } finally {
    await client.close();
  }
}

/** A phone nobody else in this run owns. */
function uniquePhone() {
  return `+9199${crypto.randomInt(0, 1e9).toString().padStart(9, '0')}`;
}

/** Full signup: OTP send, dev read, verify. Leaves `username` unset. */
async function signup(deviceId = 'device-1') {
  const phone = uniquePhone();
  const send = await api('POST', '/v3.0/auth/otp/send', { body: { phone, deviceId } });
  if (send.status !== 200) throw new Error(`otp/send ${send.status}`);
  const code = await devOtp(phone);
  const verify = await api('POST', '/v3.0/auth/otp/verify', {
    body: { sessionId: send.body.sessionId, code, deviceId }
  });
  if (verify.status !== 200) throw new Error(`otp/verify ${verify.status}`);
  return { phone, deviceId, code, sessionId: send.body.sessionId, ...verify.body };
}

/** Signup plus the mandatory username pick (AUTH_CONTRACT 2.4). */
async function signupWithUsername(deviceId = 'device-1') {
  const user = await signup(deviceId);
  const username = `c${crypto.randomInt(0, 1e9).toString().padStart(9, '0')}`;
  const patch = await api('PATCH', '/v3.0/users/me', {
    token: user.accesskey,
    body: { username }
  });
  if (patch.status !== 200) throw new Error(`username pick ${patch.status}`);
  return { ...user, username };
}

/** Wrap one Envelope batch in a WS_OP frame. */
function opFrame(envelopes) {
  return encodeWsEnvelope({ type: WS_TYPE.WS_OP, ops: { envelopes } });
}

/**
 * A client socket, opened the way the app does: `wss://<host>/wss` with the
 * accesskey subprotocol (AUTH_CONTRACT 6.1). nginx authenticates the upgrade.
 */
function connect(accesskey) {
  const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/wss`, [`accesskey.${accesskey}`]);
  const frames = [];
  const waiters = [];
  const drain = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const index = frames.findIndex(waiters[i].match);
      if (index >= 0) {
        const [frame] = frames.splice(index, 1);
        waiters.splice(i, 1)[0].resolve(frame);
      }
    }
  };
  socket.on('message', (data, isBinary) => {
    frames.push(isBinary ? decodeWsEnvelope(data) : data.toString());
    drain();
  });
  const closed = new Promise((resolve) => {
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const opened = new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  return {
    socket,
    opened,
    closed,
    get protocol() {
      return socket.protocol;
    },
    send(envelopes) {
      socket.send(opFrame(envelopes), { binary: true });
    },
    /** First buffered or future frame matching `match`. */
    waitFor(match, timeoutMs = 8000) {
      const index = frames.findIndex(match);
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: null };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('timed out waiting for a ws frame'));
        }, timeoutMs);
        waiter.resolve = (frame) => {
          clearTimeout(timer);
          resolve(frame);
        };
        waiters.push(waiter);
      });
    },
    ack(timeoutMs) {
      return this.waitFor((frame) => frame.type === WS_TYPE.WS_ACK, timeoutMs);
    },
    push(timeoutMs) {
      return this.waitFor((frame) => frame.type === WS_TYPE.WS_PUSH, timeoutMs);
    },
    async close() {
      socket.close();
      await closed;
    }
  };
}

/** Poll until `fn` resolves truthy, or throw. Used where a state change is async. */
async function eventually(fn, timeoutMs = 8000, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition never became true');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, everyMs);
    });
  }
}

module.exports = {
  BASE,
  api,
  connect,
  decodeServerEvent,
  devOtp,
  eventually,
  mintOpId,
  opFrame,
  pushTopic,
  signup,
  signupWithUsername,
  uniquePhone
};
