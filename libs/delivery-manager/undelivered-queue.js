const { ObjectId } = require('mongodb');
const { addMongodbOptions, initMongoClient } = require('../mongo-utils');
const { addPgOptions, initPgPool } = require('../pg-utils');

/** SYNC_PROTOCOL.md §19 decisions 1-2: 30 days, 10,000 frames, drop-oldest. */
const MAX_FRAMES = 10000;
const TTL_SEC = 30 * 24 * 60 * 60;

const COLLECTION = 'undelivered_frames';

/** Enqueue order: `at` is when the frame was queued, `_id` breaks a tie. */
const FIFO = { at: 1, _id: 1 };

/**
 * The undelivered queue of SYNC_PROTOCOL.md §10.6: `toPushFrame()` bytes held
 * for a `user_id:device_id` subject (TRIM_4_12_CONTRACT §7) whose socket was
 * closed, drained in one shot by `GET /v3.0/sync/pending`.
 *
 * Written by message-delivery, read by message-ms. It is the one piece of
 * server state a restart must not lose (DECISIONS rows 125 and 127), so it
 * lives in the database in every mode. This is the mongo one (the default):
 * one `{subject, frame, at}` document per frame, expired by a TTL index on
 * `at`. `--undelivered-queue pg` picks pg-undelivered-queue.js instead.
 */
class UndeliveredQueue {
  /** @type {import('mongodb').MongoClient} */
  #client;

  /** @type {import('mongodb').Collection} */
  #frames;

  #maxFrames;

  /**
   * @param {{client: import('mongodb').MongoClient, maxFrames?: number}} options
   *   `client` points at the database the queue lives in.
   */
  constructor({ client, maxFrames = MAX_FRAMES }) {
    this.#client = client;
    this.#frames = client.db().collection(COLLECTION);
    this.#maxFrames = maxFrames;
  }

  /** The drain index and the TTL index. Idempotent; `init` runs it at boot. */
  async createIndexes() {
    await this.#frames.createIndexes([
      { key: { subject: 1, ...FIFO } },
      { key: { at: 1 }, expireAfterSeconds: TTL_SEC }
    ]);
  }

  /**
   * Append one push frame for a `user_id:device_id` subject, dropping the
   * oldest past the cap.
   * ponytail: the cap check walks up to `maxFrames` index keys per enqueue;
   * keep a per-subject count if queues ever sit at the cap.
   * @param {string} subject
   * @param {Buffer} frame serialized WsEnvelope{type: WS_PUSH}
   */
  async enqueue(subject, frame) {
    await this.#frames.insertOne({ subject, frame, at: new Date() });
    const excess = await this.#frames
      .find({ subject }, { projection: { _id: 1 } })
      .sort({ at: -1, _id: -1 })
      .skip(this.#maxFrames)
      .toArray();
    if (excess.length) {
      await this.#frames.deleteMany({ _id: { $in: excess.map(({ _id }) => _id) } });
    }
  }

  /**
   * Hand back everything queued for a `user_id:device_id` subject, in enqueue
   * order, and remove exactly that — at-most-once by design (§10.6 drain
   * semantics). A drain first claims the frames, each one atomically, so two
   * drains racing (two gateways, a retried request) never return the same
   * frame, and one enqueued mid-drain waits for the next drain. Clients order
   * by (server_timestamp_ms, op_id) themselves.
   * ponytail: a process that dies between claim and delete strands what it
   * claimed until the TTL; re-claim claims older than a minute if that shows up.
   * @param {string} subject
   * @returns {Promise<Buffer[]>}
   */
  async drain(subject) {
    const claim = new ObjectId();
    await this.#frames.updateMany({ subject, claim: null }, { $set: { claim } });
    try {
      const claimed = await this.#frames
        .find({ subject, claim }, { promoteBuffers: true })
        .sort(FIFO)
        .toArray();
      await this.#frames.deleteMany({ subject, claim });
      return claimed.map((doc) => doc.frame);
    } catch (error) {
      // nothing was handed out: give the frames back for the client's retry
      await this.#frames.updateMany({ subject, claim }, { $unset: { claim: '' } });
      throw error;
    }
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
  MAX_FRAMES,
  TTL_SEC,
  COLLECTION,
  addOptions,
  init
};
