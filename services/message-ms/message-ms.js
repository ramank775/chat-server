const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const UndeliveredQueue = require('../../libs/delivery-manager/undelivered-queue');
const { extractInfoFromRequest, schemas } = require('../../helper');

const asMain = require.main === module;

async function initResources(options) {
  const context = await initDefaultResources(options)
    .then(initHttpResource)
    .then(UndeliveredQueue.init);
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = UndeliveredQueue.addOptions(cmd);
  return cmd.parse(argv).opts();
}

/**
 * The REST half of the sync wire (SYNC_PROTOCOL.md §10.6). v3 makes the
 * server a relay, so all this serves is the device's log past its pointer —
 * message history lives on the client.
 */
class MessageMs extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('../../libs/delivery-manager/undelivered-queue').UndeliveredQueue} */
    this.undeliveredQueue = this.context.undeliveredQueue;
  }

  async init() {
    await super.init();
    // nginx strips `/v3.0` and the `/sync` prefix before proxying here.
    this.addRoute(
      '/pending',
      'get',
      this.pendingSync.bind(this),
      {
        validate: {
          headers: schemas.authHeaders,
          query: Joi.object({ after: Joi.number().integer().min(0).default(0) })
        }
      }
    );
  }

  /**
   * `GET /v3.0/sync/pending?after=` — a page of the calling device's log past
   * its pointer, oldest first, and whether more wait. Removes nothing: the
   * device moves its own pointer, and a frame stays for the retention. The
   * log is keyed per `(user_id, device_id)`, so another device of the same
   * user keeps its own (TRIM_4_12_CONTRACT §7).
   */
  async pendingSync(req, res) {
    const subject = this.subject(req);
    const { frames, more } = await this.undeliveredQueue.pending(subject, req.query.after);
    this.statsClient.increment({
      stat: 'sync.pending.frame_count',
      value: frames.length,
      tags: { user: subject.split(':')[0] }
    });
    return res.response({
      frames: frames.map((frame) => frame.toString('base64')),
      more
    }).code(200);
  }

  /** The calling device's queue: `user_id:device_id`. */
  // eslint-disable-next-line class-methods-use-this
  subject(req) {
    const user = extractInfoFromRequest(req, 'x-user');
    // the gateway's default for a session that carried no device id
    const device = extractInfoFromRequest(req, 'x-device', 'default');
    return `${user}:${device}`;
  }

  async shutdown() {
    await super.shutdown();
    await this.undeliveredQueue.dispose();
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResources(options)
    .then(async (context) => {
      await new MessageMs(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Message MS', error);
      process.exit(1);
    });
}

module.exports = {
  MessageMs,
  parseOptions,
  initResources
}
