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
 * server a relay, so all this serves is the user's timeline from the
 * device's own pointer — message history lives on the client.
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
          query: Joi.object({ since: Joi.number().integer().min(0).default(0) })
        }
      }
    );
  }

  /**
   * `GET /v3.0/sync/pending?since=` — a page of the caller's timeline from the
   * device's pointer (a server_timestamp_ms, inclusive) on, oldest first, and
   * whether more wait. Removes nothing and remembers nothing: the device keeps
   * its own pointer, and an envelope stays for the retention. What this device
   * sent itself is left out; the user's other devices get it.
   */
  async pendingSync(req, res) {
    const user = extractInfoFromRequest(req, 'x-user');
    // the gateway's default for a session that carried no device id
    const device = extractInfoFromRequest(req, 'x-device', 'default');
    const { frames, more } = await this.undeliveredQueue.pending(user, device, req.query.since);
    this.statsClient.increment({
      stat: 'sync.pending.frame_count',
      value: frames.length,
      tags: { user }
    });
    return res.response({
      frames: frames.map((frame) => frame.toString('base64')),
      more
    }).code(200);
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
