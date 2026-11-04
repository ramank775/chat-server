const { UUID } = require('mongodb');
const { addMongodbOptions, initMongoClient } = require('../mongo-utils');
const { addPgOptions, initPgPool } = require('../pg-utils');
const { FRAME_CLASS, frameClass, isUuid } = require('../v3-envelope');

/**
 * SYNC_PROTOCOL.md §19 decision 1: the longest an envelope is kept, read or
 * not, and how long when its sender set no `ttl_sec`.
 */
const TTL_SEC = 30 * 24 * 60 * 60;

/** Decision 218: a receipt is kept a week at most, whatever its ttl_sec. */
const RECEIPT_TTL_SEC = 7 * 24 * 60 * 60;

/** SYNC_PROTOCOL.md §10.6: frames per pull. */
const PAGE = 500;

const COLLECTION = 'timeline';

/** A 9-hex user_id as the number the timeline keeps. */
function userNumber(userId) {
  return parseInt(userId, 16);
}

/**
 * The timeline of SYNC_PROTOCOL.md §10.6: every non-ephemeral fanout stored
 * once, as the wire Envelope bytes (decision 218; a push wraps them in a
 * WsEnvelope, a pull in a PendingPage) with the user_ids it is for, and kept
 * until it expires (`expiryOf`) whether anyone read it or not. A user's timeline is built when
 * a device asks (`GET /v3.0/sync/pending?since=`): the envelopes naming that
 * user, from the device's own pointer on, less what that very device sent.
 * Nothing is removed on a read, so a push into a socket that died is still
 * there for the next pull, and the server keeps no pointer of anyone's.
 *
 * Written by message-delivery, read by message-ms. It is the one piece of
 * server state a restart must not lose (DECISIONS rows 125 and 127), so it
 * lives in the database in every mode. This is the mongo one (the default):
 * one document per envelope, the recipients a multikey index, deleted by a
 * TTL index on `expiresAt` (which runs about once a minute, so reads filter
 * on it too). `--undelivered-queue pg` picks pg-undelivered-queue.js
 * instead. Ids are kept binary (decision 218): user ids as the 36-bit number,
 * the others as UUIDs.
 */
class UndeliveredQueue {
  /** @type {import('mongodb').MongoClient} */
  #client;

  /** @type {import('mongodb').Collection} */
  #envelopes;

  /**
   * @param {{client: import('mongodb').MongoClient}} options `client` points at
   *   the database the timeline lives in.
   */
  constructor({ client }) {
    this.#client = client;
    this.#envelopes = client.db().collection(COLLECTION);
  }

  /**
   * The read index, the op_id index and the TTL index. Idempotent; `init` runs
   * it at boot. Decision 218: a timeline of text ids, test data in the old
   * wire, is dropped first.
   */
  async createIndexes() {
    if (await this.#envelopes.findOne({ opId: { $type: 'string' } })) await this.#envelopes.drop();
    await this.#envelopes.createIndexes([
      { key: { recipients: 1, ts: 1, opId: 1 } },
      { key: { opId: 1 }, unique: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 }
    ]);
  }

  /**
   * Store one fanout. Once per op_id: a sender's retry that fans out again
   * keeps the first.
   * @param {{opId: string, ts: number, expiresAt: Date, recipients: string[],
   *   sender: string, senderDevice: string, envelope: Buffer}} entry `ts` is
   *   the envelope's server_timestamp_ms, `expiresAt` from `expiryOf()`;
   *   `sender`/`senderDevice` are '' when no user/device sent it.
   */
  async append({ opId, ts, expiresAt, recipients, sender, senderDevice, envelope }) {
    await this.#envelopes.updateOne(
      { opId: new UUID(opId) },
      {
        $setOnInsert: {
          ts,
          expiresAt,
          recipients: recipients.map(userNumber),
          sender: sender ? userNumber(sender) : null,
          senderDevice: senderDevice ? new UUID(senderDevice) : null,
          envelope
        }
      },
      { upsert: true }
    );
  }

  /**
   * A page of `userId`'s timeline from `since` on, oldest first (§10.6), less
   * what `deviceId` sent itself. Inclusive: several envelopes share a
   * millisecond, so the pointer's own one comes back and the client's op_id
   * dedup absorbs it.
   * ponytail: a page ends mid-millisecond only past 500 envelopes for one user
   * in one millisecond, which the §14 rate limits rule out.
   * @param {string} userId
   * @param {string} deviceId
   * @param {number} [since] the device's pointer, a server_timestamp_ms
   * @param {number} [limit]
   * @returns {Promise<{envelopes: Buffer[], more: boolean}>}
   */
  async pending(userId, deviceId, since = 0, limit = PAGE) {
    const user = userNumber(userId);
    const filter = { recipients: user, ts: { $gte: since }, expiresAt: { $gt: new Date() } };
    // a device id that is no UUID never sent anything: nothing to leave out
    if (isUuid(deviceId)) filter.$nor = [{ sender: user, senderDevice: new UUID(deviceId) }];
    const docs = await this.#envelopes
      .find(filter, { promoteBuffers: true, projection: { envelope: 1 } })
      .sort({ ts: 1, opId: 1 })
      .limit(limit + 1)
      .toArray();
    return {
      envelopes: docs.slice(0, limit).map((doc) => doc.envelope),
      more: docs.length > limit
    };
  }

  async dispose() {
    await this.#client.close();
  }
}

/**
 * When a stored envelope expires: its sender's `ttl_sec` from the server stamp,
 * capped at `TTL_SEC`, or at `RECEIPT_TTL_SEC` for a receipt (decision 218);
 * 0 (unset) means the cap.
 * @param {{serverTimestampMs: number, ttlSec?: number, flags?: number}} envelope
 */
function expiryOf({ serverTimestampMs, ttlSec, flags }) {
  const cap = frameClass(flags) === FRAME_CLASS.RECEIPT ? RECEIPT_TTL_SEC : TTL_SEC;
  return new Date(serverTimestampMs + Math.min(ttlSec || cap, cap) * 1000);
}

function addOptions(cmd) {
  return addPgOptions(addMongodbOptions(cmd)).option(
    '--undelivered-queue <undelivered-queue>',
    'Where the timeline lives (mongo, pg)',
    'mongo'
  );
}

/** On the context's mongo client or pg pool: one per process, monolith included. */
async function init(context) {
  const type = context.options.undeliveredQueue;
  let queue;
  if (type === 'pg') {
    // required here, not on top: it reads this module's limits
    // eslint-disable-next-line global-require
    const { PgUndeliveredQueue } = require('./pg-undelivered-queue');
    queue = new PgUndeliveredQueue({ pool: initPgPool(context), log: context.log });
    await queue.init();
  } else if (type === 'mongo') {
    queue = new UndeliveredQueue({ client: initMongoClient(context) });
    await queue.createIndexes();
  } else {
    throw new Error(`${type} is not a registered timeline implementation`);
  }
  context.undeliveredQueue = queue;
  return context;
}

module.exports = {
  UndeliveredQueue,
  TTL_SEC,
  RECEIPT_TTL_SEC,
  PAGE,
  COLLECTION,
  userNumber,
  expiryOf,
  addOptions,
  init
};
