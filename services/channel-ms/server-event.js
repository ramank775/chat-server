const path = require('path');
const protobufjs = require('protobufjs');
const { uuidv4 } = require('../../helper');
const { EnvelopeEvent, SERVER_EVENT_MARKER } = require('../../libs/v3-envelope');

/**
 * SYNC_PROTOCOL.md §10.2 — the REST→WS bridge. Every channel write fans out
 * one server-authored `Envelope` whose `payload` is `0x53` followed by a
 * `ServerEventPayload` from proto/v3-server-event-payload.proto.
 *
 * Nothing here is new wire: it is the same `Envelope` the gateway publishes,
 * wrapped in the same `EnvelopeEvent` bus framing.
 */

/** @type {protobufjs.Type} */
let payloadType = null;

function serverEventPayload() {
  if (!payloadType) {
    const root = protobufjs.loadSync(
      path.join(__dirname, '..', '..', 'proto', 'v3-server-event-payload.proto')
    );
    payloadType = root.lookupType('vartalap.v3.payload.ServerEventPayload');
  }
  return payloadType;
}

/** `ServerEventType` name -> the `body` oneof field it populates. */
const VARIANT = {
  CHANNEL_CREATED: 'channelCreated',
  CHANNEL_MEMBER_ADDED: 'memberAdded',
  CHANNEL_MEMBER_REMOVED: 'memberRemoved',
  CHANNEL_EDITED: 'channelEdited',
  CHANNEL_DELETED: 'channelDeleted'
};

/**
 * Build the fanout event for one channel write.
 * @param {keyof VARIANT} type
 * @param {object} body the variant message (camelCase fields)
 * @param {{channelId: string, actor: string, recipients: string[], deliverySequence: number}} ctx
 * @returns {EnvelopeEvent}
 */
function channelServerEvent(type, body, { channelId, actor, recipients, deliverySequence }) {
  const definition = serverEventPayload();
  const bytes = definition
    .encode(definition.fromObject({ version: 1, type, [VARIANT[type]]: body }))
    .finish();
  const now = Date.now();
  return EnvelopeEvent.of(
    {
      // Server-authored, so there is no client op_id to echo and no
      // resource_seq: recipients dedup on this id (§10.5) and nothing else
      // reads it.
      opId: uuidv4(),
      channelId,
      resourceSeq: 0,
      clientTimestampMs: now,
      payload: Buffer.concat([Buffer.from([SERVER_EVENT_MARKER]), bytes]),
      senderUserId: actor,
      serverTimestampMs: now,
      deliverySequence
    },
    recipients
  );
}

module.exports = {
  channelServerEvent,
  serverEventPayload
};
