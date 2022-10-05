const nats = require('nats');
const { shortuuid } = require('../../helper');
const { IEventStore } = require('./iEventStore');

/** @typedef {import('./iEventArg').IEventArg} IEventArg */

function parseAuthOptions(options) {
  const authOptions = {}
  switch (options.natsAuthType) {
    case 'pass':
      authOptions.user = options.natsAuthUser;
      authOptions.pass = options.natsAuthPass;
      break;
    case 'token':
      authOptions.token = options.natsAuthToken;
      break;
    case 'nkey':
      {
        const seed = new TextEncoder().encode(options.natsAuthNkey);
        authOptions.authenticator = nats.nkeyAuthenticator(seed);
      }
      break
    case 'jwt':
      {
        const creds = new TextEncoder().encode(`
-----BEGIN NATS USER JWT-----
${options.natsAuthJwt}
------END NATS USER JWT------
************************* IMPORTANT *************************
NKEY Seed printed below can be used sign and prove identity.
NKEYs are sensitive and should be treated as secrets.
-----BEGIN USER NKEY SEED-----
${options.natsAuthNkey}
------END USER NKEY SEED------
`
        );
        authOptions.authenticator = nats.credsAuthenticator(creds);
      }
      break;
    default:
      break;
  }
  return authOptions;
}

function parseNatsOptions(options) {
  const servers = options.natsServerList.split(',')
  const authOptions = parseAuthOptions(options)
  return {
    servers,
    ...authOptions
  };
}

function getConsumerOpts(options) {
  const opts = nats.consumerOpts();
  opts.queue(options.natsConsumerGroup);
  opts.durable(options.natsConsumerGroup);
  return opts;
}

class NatsEventStore extends IEventStore {
  /** @type {import('../logger').Logger} */
  #logger;

  #options = {};

  /** @type {nats.NatsConnection} */
  #nc;

  /** @type {import('node:async_hooks').AsyncLocalStorage} */
  #asyncStorage;

  /** @type {nats.JetStreamClient} */
  #jsc;

  /** @type {Map<string,nats.JetStreamPullSubscription>} */
  #psub = new Map();

  #isDisconnect = false;

  /** @type { string[] } */
  #subjects

  /** @type {(topic: string) => IEventArg} */
  #decodeMessageCb;

  /** @type {import('../stats-client/iStatsClient').IStatsClient} */
  statsClient;

  constructor(context) {
    super();
    this.#options = context.options;
    this.#logger = context.log;
    this.#subjects = context.listenerEvents;
    this.#asyncStorage = context.asyncStorage;
    this.statsClient = context.statsClient;
  }

  /**
   * Get Nats Connection instance
   * @param {Object} context
   * @return {Promise<nats.NatsConnection>}
   */
  async #getNatsInstance() {
    if (!this.#nc) {
      const options = parseNatsOptions(this.#options);
      this.#logger.info('connecting nats server');
      this.#nc = await nats.connect(options)
    }
    return this.#nc;
  }

  async #getJetStreamClient() {
    if (!this.#jsc) {
      const nc = await this.#getNatsInstance();
      this.#jsc = nc.jetstream()
    }
    return this.#jsc;
  }

  async #createNatsConsumer(decodeMessageCb) {
    nats.createInbox()
    const js = await this.#getJetStreamClient();
    this.#decodeMessageCb = decodeMessageCb
    try {
      this.#logger.info('subscribing to consumer.');
      const promises = this.#subjects.map((subject) => {
        const opts = getConsumerOpts(this.#options);
        opts.callback(async (err, msg) => {
          if (err) {
            this.#logger.error('Error while processing nats message', err);
          }
          if (!msg) {
            return;
          }
          await this.#eachMessage(msg);
          this.#psub.get(subject).pull();
        })
        const subp = js.pullSubscribe(`${subject}.>`, opts);
        subp.then((sub) => {
          this.#psub.set(subject, sub);
        })
        return subp;
      })
      await Promise.all(promises)
      this.#logger.info('Consumer subscribe sucessfully.');
    } catch (error) {
      this.#logger.error(`Error while subscribing consumer. ${error}`);
      throw error;
    }

    setTimeout(async () => {
      this.#psub.forEach((sub) => {
        sub.pull();
      })
    }, 500);

    return this.#jsc;
  }

  async #eachMessage(msg) {
    const start = new Date();
    const trackId = msg.headers.get('track_id') || shortuuid();
    const [topic, key, partition] = msg.subject.split('.', 3);
    try {
      await this.#asyncStorage.run(trackId, async () => {
        const Message = this.#decodeMessageCb(topic)
        const logInfo = {
          topic,
          partition,
          offset: msg.seq,
          key
        };
        this.#logger.info(`new data received`, logInfo);
        const sConsume = new Date();
        const message = Message.fromBinary(msg.data)
        await this.on(topic, message, key);
        this.statsClient.timing({
          stat: 'event-consumed-latency',
          value: sConsume,
          tags: {
            event: topic,
            partition,
            key,
            broker: 'nats',
          }
        });
        this.statsClient.timing({
          stat: 'event-received-latency',
          value: start,
          tags: {
            event: topic,
            partition,
            key,
            broker: 'nats'
          }
        });
        this.#logger.info('message consumed', logInfo);
      });
      msg.ack();
      this.statsClient.increment({
        stat: 'event-received',
        tags: {
          event: topic,
          partition,
          key,
          broker: 'nats'
        }
      })
    } catch (e) {
      this.#logger.error(`Error while processing message`, { err: e });
      // TODO: wait to msg to have retryCount
      if (msg.redelivered)
        msg.term();
      else
        msg.nak();
      this.statsClient.increment({
        stat: 'event-received-error',
        tags: {
          event: topic,
          partition,
          key,
          broker: 'nats'
        }
      })
    }
  }

  /**
   * Initialize Nats event store
   * @param {import('./iEventStore').InitOptions} options 
   */
  async init(options) {
    await this.#getJetStreamClient();
    if (options.consumer) {
      await this.#createNatsConsumer(options.decodeMessageCb);
    }
  }

  /**
   * Emit an new event to event store
   * @param {string} event Name of the event
   * @param {IEventArg} args Event arguments
   * @param {string} key
   */
  async emit(event, args, key) {
    const trackId = this.#asyncStorage.getStore() || shortuuid();
    try {
      const start = new Date();
      const jc = await this.#getJetStreamClient()
      const headers = nats.headers()
      headers.append('track_id', trackId)
      const data = args.toBinary()
      const response = await jc.publish(`${event}.${key}`, data, {
        headers,
      });
      this.statsClient.timing({
        stat: 'event-emit-latency',
        value: start,
        tags: {
          event,
          key,
          broker: 'nats',
        }
      });
      this.statsClient.increment({
        stat: 'event-emit',
        tags: {
          event,
          key,
          broker: 'nats'
        }
      });

      this.#logger.info(`Sucessfully produced message`, {
        event,
        stream: response.stream,
        offset: response.seq,
        duplicate: response.duplicate,
        key,
      });
    } catch (error) {
      this.#logger.error(`Error while producing message`, { error });
      this.statsClient.increment({
        stat: 'event-emit-error',
        tags: {
          event,
          key,
          broker: 'nats'
        }
      });
      throw error;
    }
  }

  async dispose() {
    super.dispose();
    if (this.#psub) {
      this.#psub.unsubscribe();
    }
  }
}

/**
 * Add Nats server options
 * @param {import('commander').Command} cmd
 */
function initOptions(cmd) {
  return cmd
    .option('--nats-server-list <server-list>', 'List of nats server endpoints')
    .option('--nats-auth-type <auth-type>', 'Nats client auth options <pass,token,nkey,jwt>')
    .option('--nats-auth-user <auth-user>', 'Nats client username for pass authentication')
    .option('--nats-auth-pass <auth-pass>', 'Nats client password for pass authentication')
    .option('--nats-auth-token <auth-token>', 'Nats client authentication token for token authentication')
    .option('--nats-auth-nkey <auth-nkey>', 'Nats client secret nkey for nkey/jwt authentication')
    .option('--nats-auth-jwt <auth-jwt>', 'Nats client user jwt token for jwt authentication')
    .option('--nats-consumer-group <consumer-group>', 'Nats consumer group name for durable consumer');
}

async function initialize(context, options) {
  const store = new NatsEventStore(context);
  await store.init(options);
  return store;
}

module.exports = {
  code: 'nats',
  initOptions,
  initialize
}
