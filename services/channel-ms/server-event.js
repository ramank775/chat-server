const path = require('path');
const protobufjs = require('protobufjs');
const {
  EVENT_FLAGS, EnvelopeEvent, SERVER_EVENT_MARKER, opIdFor, serverNow
} = require('../../libs/v3-envelope');

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
  CHANNEL_DELETED: 'channelDeleted',
  INVITE_SENT: 'inviteSent',
  INVITE_ANSWERED: 'inviteAnswered'
};

/**
 * Build the fanout event for one channel write.
 * @param {keyof VARIANT} type
 * @param {object} body the variant message (camelCase fields)
 * @param {{channelId: string, actor: string, recipients: string[], peer?: string,
 *   flags?: number}} ctx `peer` makes it a 1:1 event (decision 219): the
 *   envelope names the recipient as its peer and `channelId` is the pair's
 *   derived DM id; `flags` replaces EVENT_FLAGS (an invite's class INVITE).
 * @returns {EnvelopeEvent}
 */
function channelServerEvent(type, body, {
  channelId, actor, recipients, peer = '', flags = EVENT_FLAGS
}) {
  const definition = serverEventPayload();
  const bytes = definition
    .encode(definition.fromObject({ version: 1, type, [VARIANT[type]]: body }))
    .finish();
  const now = serverNow();
  return EnvelopeEvent.of(
    {
      // Server-authored, so there is no client op_id to echo. Minted with
      // the actor's user bits (decision 218): recipients dedup on it
      // (§10.5) and read from it who added, removed or left.
      opId: opIdFor(actor),
      channelId,
      peer,
      payload: Buffer.concat([Buffer.from([SERVER_EVENT_MARKER]), bytes]),
      // not on the wire (decision 218): message-delivery leaves the actor out
      senderUserId: actor,
      serverTimestampMs: now,
      // Decision 220: class EVENT and SILENT, unless an invite says otherwise.
      flags
    },
    recipients
  );
}

module.exports = {
  channelServerEvent,
  serverEventPayload
};
