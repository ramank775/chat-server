const { addMongodbOptions, initMongoClient } = require('../mongo-utils');
const { addPgOptions, initPgPool } = require('../pg-utils');

/** SYNC_PROTOCOL.md §19 decision 1: an envelope is kept 30 days, read or not. */
const TTL_SEC = 30 * 24 * 60 * 60;

/** SYNC_PROTOCOL.md §10.6: frames per pull. */
const PAGE = 500;

const COLLECTION = 'timeline';

/**
 * The timeline of SYNC_PROTOCOL.md §10.6: every non-ephemeral fanout stored
 * once, as the `toPushFrame()` bytes with the user_ids it is for, and kept for
 * the retention whether anyone read it or not. A user's timeline is built when
 * a device asks (`GET /v3.0/sync/pending?since=`): the envelopes naming that
 * user, from the device's own pointer on, less what that very device sent.
 * Nothing is removed on a read, so a push into a socket that died is still
 * there for the next pull, and the server keeps no pointer of anyone's.
 *
 * Written by message-delivery, read by message-ms. It is the one piece of
 * server state a restart must not lose (DECISIONS rows 125 and 127), so it
 * lives in the database in every mode. This is the mongo one (the default):
 * one document per envelope, the recipients a multikey index, expired by a
 * TTL index on `at`. `--undelivered-queue pg` picks pg-undelivered-queue.js
 * instead.
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

  /** The read index, the op_id index and the TTL index. Idempotent; `init` runs it at boot. */
  async createIndexes() {
    await this.#envelopes.createIndexes([
      { key: { recipients: 1, ts: 1, opId: 1 } },
      { key: { opId: 1 }, unique: true },
      { key: { at: 1 }, expireAfterSeconds: TTL_SEC }
    ]);
  }

  /**
   * Store one fanout. Once per op_id: a sender's retry that fans out again
   * keeps the first.
   * @param {{opId: string, ts: number, recipients: string[], sender: string,
   *   senderDevice: string, frame: Buffer}} entry `ts` is the envelope's
   *   server_timestamp_ms; `sender`/`senderDevice` are '' when server-authored.
   */
  async append({ opId, ts, recipients, sender, senderDevice, frame }) {
    await this.#envelopes.updateOne(
      { opId },
      { $setOnInsert: { ts, recipients, sender, senderDevice, frame, at: new Date() } },
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
   * @returns {Promise<{frames: Buffer[], more: boolean}>}
   */
  async pending(userId, deviceId, since = 0, limit = PAGE) {
    const docs = await this.#envelopes
      .find(
        {
          recipients: userId,
          ts: { $gte: since },
          $nor: [{ sender: userId, senderDevice: deviceId }]
        },
        { promoteBuffers: true, projection: { frame: 1 } }
      )
      .sort({ ts: 1, opId: 1 })
      .limit(limit + 1)
      .toArray();
    return { frames: docs.slice(0, limit).map((doc) => doc.frame), more: docs.length > limit };
  }

  async dispose() {
    await this.#client.close();
  }
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
  PAGE,
  COLLECTION,
  addOptions,
  init
};
