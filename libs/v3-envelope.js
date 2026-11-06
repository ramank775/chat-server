const path = require('path');
const crypto = require('crypto');
const protobufjs = require('protobufjs');
const { IEventArg } = require('./event-store');

/**
 * v3 sync-wire codec (SYNC_PROTOCOL.md §5, proto/v3-envelope.proto).
 *
 * Shared by connection-gateway (client wire) and message-delivery
 * (fanout bus) so there is exactly one place that knows the framing.
 */

/**
 * Framing for the internal bus only — never on the client wire, so it lives
 * here rather than in proto/ (which holds the two schemas copied verbatim
 * from the spec). One stamped Envelope exactly as its recipients get it, the
 * users (or, past fanout, the `user_id:device_id` subjects) it goes to, and
 * what the server needs that the wire leaves out (decision 218): the sending
 * device (the one device fanout skips, TRIM_4_12_CONTRACT §8), the sending
 * user, and the channel id as text, a DM's derived one included. What the
 * gateway publishes to the new-message topic and what delivery-manager
 * carries over its Redis pubsub between gateways. The `payload` bytes stay
 * binary, which is why this is protobuf and not JSON.
 */
const INTERNAL_PROTO = `
  syntax = "proto3";
  package vartalap.v3;
  message PushEvent {
    repeated string recipients = 1;
    Envelope envelope = 2;
    string sender_device = 3;
    string sender = 4;
    string channel_id = 5;
  }`;

/** @type {protobufjs.Root} */
let root = null;

function protoRoot() {
  if (!root) {
    root = protobufjs.loadSync(path.join(__dirname, '..', 'proto', 'v3-envelope.proto'));
    protobufjs.parse(INTERNAL_PROTO, root);
    root.resolveAll();
  }
  return root;
}

function type(name) {
  return protoRoot().lookupType(`vartalap.v3.${name}`);
}

const WS_TYPE = {
  UNSPECIFIED: 0,
  WS_OP: 1,
  WS_ACK: 2,
  WS_PUSH: 3,
  WS_REAUTH_REQUIRED: 4,
  WS_ERROR: 5
};

const ACK_OUTCOME = {
  UNSPECIFIED: 0,
  SUCCESS: 1,
  TRANSIENT: 2,
  PERMANENT: 3,
  AUTH_FAILURE: 4
};

/** SYNC_PROTOCOL.md §8.2 — the reasons this server can actually evaluate. */
const REASON = {
  PREFIX_MISMATCH: 'prefix_mismatch',
  FORBIDDEN: 'forbidden',
  VALIDATION_FAILED: 'validation_failed',
  RATE_LIMITED: 'rate_limited',
  STORAGE_UNAVAILABLE: 'storage_unavailable',
  DOWNSTREAM_TIMEOUT: 'downstream_timeout'
};

let lastStampMs = 0;

/**
 * `server_timestamp_ms` for a new envelope (§6): never below the last one this
 * process stamped. Every stamper (gateway, channel-ms, profile-ms) stamps and
 * publishes in one synchronous step, and the bus delivers a topic in order, so
 * envelopes reach the timeline in stamp order: a device whose pointer is at
 * `t` has seen everything stamped before `t` that is meant for it (§10.6).
 * ponytail: one process. Ceiling: a clock set back across a restart, or a
 * second process stamping, breaks that; seed this from the timeline's newest
 * stamp at boot, and stamp in one place, if either ever happens.
 */
function serverNow() {
  lastStampMs = Math.max(Date.now(), lastStampMs);
  return lastStampMs;
}

/** SYNC_PROTOCOL.md §10.2 / §19 decision 15 — server-authored payload marker. */
const SERVER_EVENT_MARKER = 0x53;

/** `Envelope.flags` bits (proto §flags). */
const ENVELOPE_FLAG = Object.freeze({ SILENT: 1 });

/**
 * The frame class, `Envelope.flags` bits 1-4 (decisions 218, 220; proto §flags).
 * LOCATION: live location (SYNC_PROTOCOL §21, decision 223), positions and
 * stops SILENT with a short ttl_sec, a remote on/off waking; nothing here
 * treats it apart.
 */
const FRAME_CLASS = Object.freeze({
  MESSAGE: 0, MUTATION: 1, RECEIPT: 2, KEY: 3, RESEND: 4, EVENT: 5, LOCATION: 7
});

/* eslint-disable no-bitwise -- flags is a bit set */
/** The class a frame's flags carry; no flags is a MESSAGE. */
const frameClass = (flags) => ((flags || 0) >> 1) & 15;

/** The flags for a frame of class `cls`, no other bit set. */
const classFlags = (cls) => cls << 1;

/**
 * Decision 220: wake an offline device for every stored frame its sender
 * did not mark SILENT. The sender knows what shows a notification, so a new
 * kind of frame needs no server change; the class is for storage and,
 * later, the invite gate.
 */
const wakes = (flags) => ((flags || 0) & ENVELOPE_FLAG.SILENT) === 0;

/** The flags of a server-authored event: class EVENT, and it shows no notification. */
const EVENT_FLAGS = classFlags(FRAME_CLASS.EVENT) + ENVELOPE_FLAG.SILENT;
/* eslint-enable no-bitwise */

/** A 9-lowercase-hex user_id, the only shape `peer` may take (trim 4). */
const USER_ID = /^[0-9a-f]{9}$/;

/**
 * TRIM_4_12_CONTRACT §1 — the DM channel id both clients and the server
 * derive from the pair, identically and offline:
 *   dm_chan(a, b) = "d" + sha256_hex(min(a,b) + "\x00" + max(a,b))[0:31]
 * `a`/`b` are 9-lowercase-hex user_ids compared bytewise; the result is
 * exactly 32 chars. A DM has no server-side row: this function is the whole
 * membership rule.
 * @param {string} a
 * @param {string} b
 */
function dmChannelId(a, b) {
  const [low, high] = a < b ? [a, b] : [b, a];
  const digest = crypto.createHash('sha256').update(`${low}\x00${high}`).digest('hex');
  return `d${digest.slice(0, 31)}`;
}

function isUserId(userId) {
  return USER_ID.test(userId || '');
}

const DECODE_OPTIONS = {
  longs: Number,
  enums: Number,
  bytes: Buffer,
  defaults: true
};

/** The text form of every UUID the server keeps: lowercase and dashed. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isUuid(id) {
  return UUID.test(id || '');
}

// Decision 218: ids are bytes on the wire only, text everywhere else. These
// four are the edge; a wrong length from a client is null, never a guess.

/** 16 bytes as UUID text; null for any other length. */
function uuidText(bytes) {
  if (!bytes || bytes.length !== 16) return null;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UUID text as its 16 bytes. Throws on anything else: the server made it. */
function uuidBytes(text) {
  if (!isUuid(text)) throw new TypeError(`not a uuid: ${text}`);
  return Buffer.from(text.replace(/-/g, ''), 'hex');
}

/**
 * 5 big-endian bytes as the 9-hex user_id; null for any other length, or a
 * value past 36 bits (the top nibble is always 0).
 */
function userIdText(bytes) {
  if (!bytes || bytes.length !== 5) return null;
  const hex = Buffer.from(bytes).toString('hex');
  return hex[0] === '0' ? hex.slice(1) : null;
}

/** A 9-hex user_id as 5 bytes, big-endian. Throws on anything else. */
function userIdBytes(userId) {
  if (!isUserId(userId)) throw new TypeError(`not a user_id: ${userId}`);
  return Buffer.from(`0${userId}`, 'hex');
}

/**
 * A server-side envelope (text ids) as the wire Envelope its recipients get
 * (decision 218): a group names its channel, a DM its peer and never its
 * derived channel; the sender is in the op_id; nothing at its default is
 * encoded. `senderDevice` is '' on a server-authored event.
 * @param {object} envelope
 * @param {string} [senderDevice]
 */
function toWire(envelope, senderDevice = '') {
  const wire = {};
  if (envelope.opId) wire.opId = uuidBytes(envelope.opId);
  if (envelope.peer) wire.peer = userIdBytes(envelope.peer);
  else if (envelope.channelId) wire.channelId = uuidBytes(envelope.channelId);
  if (envelope.payload && envelope.payload.length) wire.payload = envelope.payload;
  if (envelope.ephemeral) wire.ephemeral = true;
  if (envelope.ttlSec) wire.ttlSec = envelope.ttlSec;
  if (envelope.flags) wire.flags = envelope.flags;
  if (envelope.serverTimestampMs) wire.serverTimestampMs = envelope.serverTimestampMs;
  if (senderDevice) wire.senderDeviceId = uuidBytes(senderDevice);
  return wire;
}

/** One wire Envelope, serialized: what the timeline stores. */
function encodeEnvelope(wire) {
  const definition = type('Envelope');
  return Buffer.from(definition.encode(definition.create(wire)).finish());
}

function decodeEnvelope(buffer) {
  const definition = type('Envelope');
  return definition.toObject(definition.decode(buffer), DECODE_OPTIONS);
}

/**
 * The `GET /v3.0/sync/pending` body: a PendingPage around stored Envelope
 * bytes. Each one is written as it was stored (field 1, length-delimited),
 * so nothing is decoded only to be encoded again.
 * @param {Buffer[]} envelopes
 * @param {boolean} more
 */
function pendingPage(envelopes, more) {
  const writer = protobufjs.Writer.create();
  envelopes.forEach((bytes) => writer.uint32(10).bytes(bytes));
  if (more) writer.uint32(16).bool(true);
  return Buffer.from(writer.finish());
}

function decodePendingPage(buffer) {
  const definition = type('PendingPage');
  return definition.toObject(definition.decode(buffer), DECODE_OPTIONS);
}

function encodeWsEnvelope(payload) {
  const definition = type('WsEnvelope');
  return Buffer.from(definition.encode(definition.create(payload)).finish());
}

/**
 * Decode one binary WS frame. Throws on a malformed frame.
 * @param {Buffer} buffer
 */
function decodeWsEnvelope(buffer) {
  const definition = type('WsEnvelope');
  return definition.toObject(definition.decode(buffer), DECODE_OPTIONS);
}

function ackFrame(acks) {
  return encodeWsEnvelope({ type: WS_TYPE.WS_ACK, acks: { acks } });
}

function pushFrame(envelope) {
  return encodeWsEnvelope({ type: WS_TYPE.WS_PUSH, push: envelope });
}

function reauthFrame() {
  return encodeWsEnvelope({ type: WS_TYPE.WS_REAUTH_REQUIRED, reauthRequired: true });
}

function errorFrame(code, message) {
  return encodeWsEnvelope({ type: WS_TYPE.WS_ERROR, error: { code, message } });
}

/**
 * SYNC_PROTOCOL.md §3 — the 36-bit user_id the client embedded in the
 * UUIDv7 `op_id`, read as bits[62..26] (bit 62 is the low variant bit and
 * is always 0, so the 37-bit read equals the 36-bit user_id).
 * Layout: packages/vartalap_sync/lib/src/uuid7.dart.
 * @param {string} opId
 * @returns {number|null} null when `op_id` is not a UUID at all.
 */
/* eslint-disable no-bitwise -- reading a fixed UUIDv7 bit layout */
function opIdUserBits(opId) {
  if (typeof opId !== 'string') return null;
  const hex = opId.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const byte = (i) => parseInt(hex.substr(i * 2, 2), 16);
  // 6 bits of byte 8, bytes 9..11, then the top 6 bits of byte 12.
  return (
    (byte(8) & 0x3f) * 2 ** 30 +
    byte(9) * 2 ** 22 +
    byte(10) * 2 ** 14 +
    byte(11) * 2 ** 6 +
    (byte(12) >> 2)
  );
}

/**
 * A new op_id for an event the server authors on a user's behalf (decision
 * 218): a UUIDv7 carrying the actor's user bits, so a receiver reads who
 * added or removed whom from it exactly as it reads the sender of any op.
 * The app's layout (uuid7.dart): 48b ms | 4b ver | 12b counter | 2b variant
 * | 36b user_id | 4b device slot | 18b random; here the counter and the
 * random bits are random and the device slot is 0.
 * @param {string} actorUserId 9 lowercase hex chars
 */
function opIdFor(actorUserId, ms = Date.now()) {
  if (!isUserId(actorUserId)) throw new TypeError(`not a user_id: ${actorUserId}`);
  const uid = parseInt(actorUserId, 16);
  const rnd = crypto.randomBytes(4);
  const b = Buffer.alloc(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | (rnd[0] & 0x0f);
  b[7] = rnd[1];
  // Bitwise ops are 32-bit, so the 36-bit user_id is sliced with arithmetic.
  b[8] = 0x80 | (Math.floor(uid / 2 ** 30) % 64);
  b[9] = Math.floor(uid / 2 ** 22) % 256;
  b[10] = Math.floor(uid / 2 ** 14) % 256;
  b[11] = Math.floor(uid / 2 ** 6) % 256;
  b[12] = (uid % 64) << 2;
  b[13] = rnd[2] & 0x3f;
  b[14] = rnd[3];
  b[15] = (rnd[0] & 0xf0);
  return uuidText(b);
}
/* eslint-enable no-bitwise */

/**
 * Internal bus event: one server-stamped Envelope plus its fanout targets.
 * Published by the gateway to the new-message topic and carried by
 * delivery-manager's pubsub. The envelope is held with text ids (decision
 * 218: bytes on the wire only): `opId`, `channelId` (a DM's derived one
 * too), `peer` (DMs only), `senderUserId` ('' or the actor on a server
 * event); `toWire` is where they turn into bytes.
 */
class EnvelopeEvent extends IEventArg {
  /** @type {object} */
  _envelope;

  /** @type {string[]} */
  _recipients = [];

  /** @type {string} the sending device, '' for a server-authored event */
  _senderDevice = '';

  static of(envelope, recipients = [], senderDevice = '') {
    const event = new EnvelopeEvent();
    event._envelope = envelope;
    event._recipients = recipients;
    event._senderDevice = senderDevice || '';
    return event;
  }

  /** The bus framing back: the wire Envelope's ids in text again. */
  static fromBinary(payload) {
    const definition = type('PushEvent');
    const json = definition.toObject(definition.decode(payload), DECODE_OPTIONS);
    const wire = json.envelope || {};
    const envelope = {
      opId: uuidText(wire.opId) || '',
      channelId: json.channelId,
      peer: userIdText(wire.peer) || '',
      payload: wire.payload,
      ephemeral: wire.ephemeral,
      ttlSec: wire.ttlSec,
      flags: wire.flags,
      serverTimestampMs: wire.serverTimestampMs,
      senderUserId: json.sender
    };
    return EnvelopeEvent.of(envelope, json.recipients || [], json.senderDevice);
  }

  toBinary() {
    const definition = type('PushEvent');
    const message = {
      recipients: this._recipients,
      envelope: this.toWire(),
      senderDevice: this._senderDevice,
      sender: this._envelope.senderUserId || '',
      channelId: this._envelope.channelId || ''
    };
    return Buffer.from(definition.encode(definition.create(message)).finish());
  }

  toString() {
    return JSON.stringify({ recipients: this._recipients, envelope: this._envelope });
  }

  clone() {
    return EnvelopeEvent.of(this._envelope, this._recipients, this._senderDevice);
  }

  setRecipients(recipients) {
    this._recipients = recipients;
  }

  hasRecipients() {
    return this._recipients.length > 0;
  }

  get recipients() {
    return this._recipients;
  }

  get envelope() {
    return this._envelope;
  }

  get channelId() {
    return this._envelope.channelId;
  }

  get senderUserId() {
    return this._envelope.senderUserId;
  }

  /** The sending device; '' for a server-authored event. */
  get senderDevice() {
    return this._senderDevice;
  }

  /**
   * The one subject fanout skips: the socket this envelope came in on. Empty
   * for a server-authored event, where the actor's whole user is skipped.
   */
  get senderSubject() {
    return this._senderDevice ? `${this._envelope.senderUserId}:${this._senderDevice}` : '';
  }

  /** Ephemeral envelopes are never queued for offline users (proto §ephemeral). */
  get ephemeral() {
    return !!this._envelope.ephemeral;
  }

  /** Whether an offline recipient is woken for it (decision 218, `wakes`). */
  get wakes() {
    return !this.ephemeral && wakes(this._envelope.flags);
  }

  /** The wire Envelope recipients get (decision 218). */
  toWire() {
    return toWire(this._envelope, this._senderDevice);
  }

  /** The wire Envelope, serialized: what the timeline keeps. */
  toEnvelopeBytes() {
    return encodeEnvelope(this.toWire());
  }

  /** The exact bytes a recipient's socket receives. */
  toPushFrame() {
    return pushFrame(this.toWire());
  }
}

module.exports = {
  WS_TYPE,
  ACK_OUTCOME,
  REASON,
  ENVELOPE_FLAG,
  EVENT_FLAGS,
  FRAME_CLASS,
  SERVER_EVENT_MARKER,
  EnvelopeEvent,
  encodeWsEnvelope,
  decodeWsEnvelope,
  encodeEnvelope,
  decodeEnvelope,
  pendingPage,
  decodePendingPage,
  frameClass,
  classFlags,
  wakes,
  toWire,
  uuidText,
  uuidBytes,
  userIdText,
  userIdBytes,
  isUuid,
  ackFrame,
  pushFrame,
  reauthFrame,
  errorFrame,
  opIdUserBits,
  opIdFor,
  serverNow,
  dmChannelId,
  isUserId
};
