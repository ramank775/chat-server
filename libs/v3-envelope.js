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
 * from the spec). One stamped Envelope, the users (or, past fanout, the
 * `user_id:device_id` subjects) it goes to, and the device that sent it —
 * the one device fanout skips (TRIM_4_12_CONTRACT §8). What the gateway
 * publishes to the new-message topic and what delivery-manager carries over
 * its Redis pubsub between gateways. The `payload` bytes stay binary, which
 * is why this is protobuf and not JSON.
 */
const INTERNAL_PROTO = `
  syntax = "proto3";
  package vartalap.v3;
  message PushEvent {
    repeated string recipients = 1;
    Envelope envelope = 2;
    string sender_device = 3;
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
  OUT_OF_ORDER: 'out_of_order',
  FORBIDDEN: 'forbidden',
  VALIDATION_FAILED: 'validation_failed',
  RATE_LIMITED: 'rate_limited',
  STORAGE_UNAVAILABLE: 'storage_unavailable',
  DOWNSTREAM_TIMEOUT: 'downstream_timeout'
};

/** SYNC_PROTOCOL.md §10.2 / §19 decision 15 — server-authored payload marker. */
const SERVER_EVENT_MARKER = 0x53;

/** A 9-lowercase-hex user_id, the only shape `peer` may take (trim 4). */
const USER_ID = /^[0-9a-f]{9}$/;

/**
 * A derived DM channel id: `d` + 31 hex chars, no dashes. Group ids are
 * UUIDs, so the dash at index 8 keeps the two spaces disjoint even when a
 * UUID happens to start with `d`.
 */
const DM_CHANNEL_ID = /^d[0-9a-f]{31}$/;

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

/** Is this channel id a derived DM id (and so never a channel-ms row)? */
function isDmChannelId(channelId) {
  return DM_CHANNEL_ID.test(channelId || '');
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
/* eslint-enable no-bitwise */

/**
 * Internal bus event: one server-stamped Envelope plus its fanout targets.
 * Published by the gateway to the new-message topic and carried by
 * delivery-manager's pubsub.
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

  static fromBinary(payload) {
    const definition = type('PushEvent');
    const json = definition.toObject(definition.decode(payload), DECODE_OPTIONS);
    return EnvelopeEvent.of(json.envelope, json.recipients || [], json.senderDevice);
  }

  toBinary() {
    const definition = type('PushEvent');
    const message = {
      recipients: this._recipients,
      envelope: this._envelope,
      senderDevice: this._senderDevice
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

  /**
   * The one subject fanout skips: the socket this envelope came in on. Empty
   * for a server-authored event, where the actor's whole user is skipped.
   */
  get senderSubject() {
    return this._senderDevice ? `${this._envelope.senderUserId}:${this._senderDevice}` : '';
  }

  get deliverySequence() {
    return this._envelope.deliverySequence;
  }

  /** Ephemeral envelopes are never queued for offline users (proto §ephemeral). */
  get ephemeral() {
    return !!this._envelope.ephemeral;
  }

  /** The exact bytes a recipient's socket receives. */
  toPushFrame() {
    return pushFrame(this._envelope);
  }
}

module.exports = {
  WS_TYPE,
  ACK_OUTCOME,
  REASON,
  SERVER_EVENT_MARKER,
  EnvelopeEvent,
  encodeWsEnvelope,
  decodeWsEnvelope,
  ackFrame,
  pushFrame,
  reauthFrame,
  errorFrame,
  opIdUserBits,
  dmChannelId,
  isDmChannelId,
  isUserId
};
