const { addMongodbOptions, initMongoClient } = require('../mongo-utils');
const { addPgOptions, initPgPool } = require('../pg-utils');

/** SYNC_PROTOCOL.md §19 decision 1: a frame is kept 30 days, read or not. */
const TTL_SEC = 30 * 24 * 60 * 60;

/** SYNC_PROTOCOL.md §10.6: frames per pull. */
const PAGE = 500;

const COLLECTION = 'undelivered_frames';

/** The one document holding the last offset handed out. */
const COUNTERS = 'counters';

/**
 * The device logs of SYNC_PROTOCOL.md §10.6, Kafka style: every `toPushFrame()`
 * fanned out to a `user_id:device_id` subject (TRIM_4_12_CONTRACT §7), under
 * the fanout's offset, kept for the retention whether the device read it or
 * not. Nothing is removed on a read: the device keeps its own pointer and
 * pulls what lies past it (`GET /v3.0/sync/pending?after=`), so a frame
 * pushed into a socket that died is still there for the next pull.
 *
 * Written by message-delivery, read by message-ms. It is the one piece of
 * server state a restart must not lose (DECISIONS rows 125 and 127), so it
 * lives in the database in every mode. This is the mongo one (the default):
 * one `{subject, offset, frame, at}` document per frame, expired by a TTL
 * index on `at`. `--undelivered-queue pg` picks pg-undelivered-queue.js
 * instead.
 *
 * ponytail: offsets are drawn and frames written by one fanout at a time
 * (the monolith's bus runs a topic's events in order), so a device never
 * sees a higher offset land before a lower one. Ceiling: two message-delivery
 * workers would break that; give each subject one writer (a partition, as
 * kafka does) before running more than one.
 */
class UndeliveredQueue {
  /** @type {import('mongodb').MongoClient} */
  #client;

  /** @type {import('mongodb').Collection} */
  #frames;

  /** @type {import('mongodb').Collection} */
  #counters;

  /**
   * @param {{client: import('mongodb').MongoClient}} options `client` points at
   *   the database the logs live in.
   */
  constructor({ client }) {
    this.#client = client;
    this.#frames = client.db().collection(COLLECTION);
    this.#counters = client.db().collection(COUNTERS);
  }

  /** The read index and the TTL index. Idempotent; `init` runs it at boot. */
  async createIndexes() {
    await this.#frames.createIndexes([
      { key: { subject: 1, offset: 1 }, unique: true },
      { key: { at: 1 }, expireAfterSeconds: TTL_SEC }
    ]);
  }

  /**
   * The next offset: strictly increasing across restarts, one per fanout and
   * shared by all its recipients.
   * @returns {Promise<number>}
   */
  async nextOffset() {
    const counter = await this.#counters.findOneAndUpdate(
      { _id: COLLECTION },
      { $inc: { offset: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    return counter.offset;
  }

  /**
   * Append one push frame to a subject's log. Once per offset: a fanout run
   * again writes nothing new.
   * @param {string} subject
   * @param {number} offset from `nextOffset`, stamped on the frame's envelope
   * @param {Buffer} frame serialized WsEnvelope{type: WS_PUSH}
   */
  async enqueue(subject, offset, frame) {
    await this.#frames.updateOne(
      { subject, offset },
      { $setOnInsert: { frame, at: new Date() } },
      { upsert: true }
    );
  }

  /**
   * The frames in a subject's log past `after`, oldest first, and whether
   * more wait past this page (§10.6). Removes nothing.
   * @param {string} subject
   * @param {number} [after] the device's pointer; 0 reads everything kept
   * @param {number} [limit]
   * @returns {Promise<{frames: Buffer[], more: boolean}>}
   */
  async pending(subject, after = 0, limit = PAGE) {
    const docs = await this.#frames
      .find({ subject, offset: { $gt: after } }, { promoteBuffers: true, projection: { frame: 1 } })
      .sort({ offset: 1 })
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
    'Where the undelivered queue lives (mongo, pg)',
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
    throw new Error(`${type} is not a registered undelivered queue implementation`);
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
