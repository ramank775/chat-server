const fs = require('fs');
const { Kafka, logLevel } = require('kafkajs');
const { shortuuid } = require('../../helper');
const { IEventStore } = require('./iEventStore');

/** @typedef {import('./iEventArg').IEventArg} IEventArg */

/**
 * Add standard kafka options
 * @param {commander} cmd
 */
function addStandardKafkaOptions(cmd) {
  cmd
    .option('--kafka-broker-list <broker-list>', 'List of kafka brokers endpoints')
    .option('--kafka-client-id <client-id>')
    .option('--kafka-consumer-group <consumer-group-id>')
    .option(
      '--kafka-connection-timeout <connection-timeout>',
      'Time in milliseconds to wait for a sucessful connection',
      (c) => Number(c),
      3000
    )
    .option(
      '--kafka-request-timeout <request-timeout>',
      'Time in milliseconds to wait for a successful request',
      (c) => Number(c),
      30000
    )
    .option(
      '--kafka-max-retry-time <max-retry-time>',
      'Max wait time for a retry in milliseconds',
      (c) => Number(c),
      30000
    )
    .option(
      '--kafka-initial-retry-time <retry-time>',
      'Initial value used to calculate retry in milliseconds',
      (c) => Number(c),
      300
    )
    .option(
      '--kafka-max-retries <max-retries>',
      'Max number of retries per call',
      (c) => Number(c),
      5
    )
    .option(
      '--kafka-metadata-max-age <metadata-max-age>',
      'The period of time in milliseconds after which we force a refresh of metadata',
      (c) => Number(c),
      300000
    )
    .option(
      '--kafka-transaction-timeout <transaction-timeout>',
      'The maximum amount of time in ms that the transaction coordinator will wait for a transaction status update from the produce',
      (c) => Number(c),
      60000
    )
    .option(
      '--kafka-max-in-flight-reqeusts <max-in-flight-request>',
      'Max number of requests that may be in progress at any time. If falsey then no limit',
      (c) => Number(c),
      0
    )
    .option(
      '--kafka-session-timeout <session-timeout>',
      'Timeout in milliseconds used to detect failures.',
      (c) => Number(c),
      30000
    )
    .option(
      '--kafka-rebalance-timeout <rebalance-timeout>',
      'The maximum time that the coordinator will wait for each member to rejoin when rebalancing the group',
      (c) => Number(c),
      60000
    )
    .option(
      '--kafka-heartbeat-interval <heartbeat-interval>',
      'The expected time in milliseconds between heartbeats to the consumer coordinator.',
      (c) => Number(c),
      3000
    )
    .option(
      '--kafka-max-bytes-per-partition <max-bytes-per-partition>',
      'The maximum amount of data per-partition the server will return.',
      (c) => Number(c),
      1048576
    )
    .option(
      '--kafka-min-bytes <min-bytes>',
      'Minimum amount of data the server should return for a fetch request.',
      (c) => Number(c),
      1
    )
    .option(
      '--kafka-max-bytes <max-bytes>',
      'Maximum amount of bytes to accumulate in the response.',
      (c) => Number(c),
      10485760
    )
    .option(
      '--kafka-max-wait-time <max-wait-time>',
      'The maximum amount of time in milliseconds the server will block before answering the fetch request if there isn’t sufficient data to immediately satisfy the requirement given by minBytes',
      (c) => Number(c),
      5000
    );
  return cmd;
}

/**
 * Add kafka SSL options
 * @param {commander} cmd
 */
function addKafkaSSLOptions(cmd) {
  return cmd
    .option(
      '--kafka-security-protocol <protocol>',
      'Protocol used to communicate with brokers [plaintext|ssl|sasl_ssl] (default plaintext)',
      'plaintext'
    )
    .option(
      '--kafka-ssl-ca <ssl-ca-path>',
      "File or directory path to CA certificate(s) (PEM) for verifying the broker's key"
    )
    .option(
      '--kafka-ssl-certificate <ssl-path>',
      "Path to client's public key (PEM) used for authentication"
    )
    .option(
      '--kafka-ssl-key <ssl-path>',
      "Path to client's private key (PEM) used for authentication"
    )
    .option('--kafka-sasl-mechanisms <sasl-mechanisms>', 'SASL Mechanisms (default plan)', 'PLAIN')
    .option('--kafka-sasl-username <sasl-username>', 'Username to be used for SASL_SSL auth')
    .option('--kafka-sasl-password <sasl-password>', 'Password to be used for SASL_SSL auth')
    .option(
      '--kafka-authentication-timeout <authentication-timout>',
      'Timeout in ms for authentication requests',
      (c) => Number(c),
      1000
    )
    .option(
      '--kafka-reauthentication-threshold <reauthentication-threshold>',
      'When periodic reauthentication (connections.max.reauth.ms) is configured on the broker side, reauthenticate when reauthenticationThreshold milliseconds remain of session lifetime.',
      (c) => Number(c),
      10000
    );
}

/**
 * Prepare kafka standard options
 * @param {commander} cmd
 */
function parseStandardKafkaOptions(options) {
  const kafkaOptions = {
    brokers: options.kafkaBrokerList.split(','),
    clientId: options.kafkaClientId,
    connectionTimeout: options.kafkaConnectionTimeout,
    requestTimeout: options.kafkaRequestTimeout,
    retry: {
      maxRetryTime: options.kafkaMaxRetryTime,
      initialRetryTime: options.kafkaInitialRetryTime,
      retries: options.kafkaMaxRetries
    }
  };
  return kafkaOptions;
}

/**
 * Prepare SSL options for kafka client.
 * @param {Object} options
 * @returns {Object}
 */
function parseKafkaSSLOptions(options) {
  function sslOptions() {
    if (options.kafkaSslCa && options.kafkaSslKey && options.kafkaSslCertificate) {
      return {
        rejectUnauthorized: false,
        ca: [fs.readFileSync(options.kafkaSslCa, 'utf-8')],
        key: fs.readFileSync(options.kafkaSslKey, 'utf-8'),
        cert: fs.readFileSync(options.kafkaSslCertificate, 'utf-8')
      };
    }
    return true;

  }

  if (options.kafkaSecurityProtocol === 'sasl_ssl') {
    return {
      authenticationTimeout: options.kafkaAuthenticationTimeout,
      reauthenticationThreshold: options.kafkaReauthenticationThreshold,
      ssl: sslOptions(),
      sasl: {
        mechanism: options.kafkaSaslMechanisms,
        username: options.kafkaSaslUsername,
        password: options.kafkaSaslPassword
      }
    };
  } if (options.kafkaSecurityProtocol === 'ssl') {
    return {
      authenticationTimeout: 1000,
      ssl: sslOptions()
    };
  }
  return {};

}

/**
 * Prepare Producer options.
 * @param {Object} options
 * @returns {Object}
 */
function parseKakfaProducerOptions(options) {
  const kafkaProducerOptions = {
    metadataMaxAge: options.kafkaMetadataMaxAge,
    allowAutoTopicCreation: false,
    transactionTimeout: options.kafkaTransactionTimeout,
    maxInFlightRequests: options.kafkaMaxInFlightRequests
  };
  return kafkaProducerOptions;
}

/**
 * Prepare Consumer options.
 * @param {Object} options
 * @returns {Object}
 */
function parseKakfaConsumerOptions(options) {
  const kafkaConsumerOptions = {
    groupId: options.kafkaConsumerGroup,
    sessionTimeout: options.kafkaSessionTimeout,
    rebalanceTimeout: options.kafkaRebalanceTimeout,
    heartbeatInterval: options.kafkaHeartbeatInterval,
    metadataMaxAge: options.kafkaMetadataMaxAge,
    allowAutoTopicCreation: false,
    maxInFlightRequests: options.kafkaMaxInFlightRequests,
    maxBytesPerPartition: options.kafkaMaxBytesPerPartition,
    minBytes: options.kafkaMinBytes,
    maxBytes: options.kafakMaxBytes,
    maxWaitTimeInMs: options.kafkaMaxWaitTime
  };
  return kafkaConsumerOptions;
}

function parseKafkaOptions(options) {
  return {
    ...parseStandardKafkaOptions(options),
    ...parseKafkaSSLOptions(options)
  };
}

function toWinstonLogLevel(level) {
  switch (level) {
    case logLevel.ERROR:
    case logLevel.NOTHING:
      return 'error';
    case logLevel.WARN:
      return 'warn';
    case logLevel.INFO:
      return 'info';
    case logLevel.DEBUG:
      return 'debug';
    default:
      return 'info'
  }
}

function toLogLevel(level) {
  switch (level) {
    case 'error':
      return logLevel.ERROR;
    case 'warn':
      return logLevel.WARN;
    case 'info':
      return logLevel.INFO;
    case 'debug':
      return logLevel.DEBUG;
    default:
      return logLevel.INFO
  }
}

/**
 * Add kafka broker options
 * @param {commander} cmd
 */
function initOptions(cmd) {
  cmd = addStandardKafkaOptions(cmd);
  cmd = addKafkaSSLOptions(cmd);
  return cmd;
}

class KafkaEventStore extends IEventStore {
  /** @type {import('../logger').Logger} */
  #logger;

  #options = {};

  /** @type {Kafka} */
  #kafka;

  /** @type {import('node:async_hooks').AsyncLocalStorage} */
  #asyncStorage;

  /** @type {import('kafkajs').Producer} */
  #producer;

  /** @type {import('kafkajs').Consumer} */
  #consumer;

  #isDisconnect = false;

  /** @type { string[] } */
  #listenerEvents

  constructor(context) {
    super();
    this.#options = context.options;
    this.#logger = context.log;
    this.#listenerEvents = context.listenerEvents;
    this.#asyncStorage = context.asyncStorage;
  }

  /**
   * Get kafka instance
   * @param {Object} context
   * @return {Kafka}
   */
  #getKafkaInstance() {
    if (!this.#kafka) {
      const options = parseKafkaOptions(this.#options);
      this.#kafka = new Kafka({
        ...options,
        logLevel: toLogLevel(this.#logger.level === 'debug' ? 'info' : this.#logger.level),
        logCreator: (_level) => ({ _namespace, level, _label, log }) => {
          const { message, ...extra } = log;
          this.#logger.log({
            level: toWinstonLogLevel(level),
            message,
            extra
          });
        }
      });
    }
    return this.#kafka;
  }

  async #createKakfaProducer() {
    const kafka = this.#getKafkaInstance();
    const producerOptions = parseKakfaProducerOptions(this.#options);
    this.#producer = kafka.producer(producerOptions);
    this.#logger.info('connecting kafka producer');
    await this.#producer.connect();
    return this.#producer;
  }

  async #createKafkaConsumer(decodeMessageCb) {
    const kafka = this.#getKafkaInstance();
    const consumerOptions = parseKakfaConsumerOptions(this.#options);
    this.#consumer = kafka.consumer(consumerOptions);

    try {
      this.#logger.info('Connecting consumer.');
      await this.#consumer.connect();
      this.#logger.info('Consumer connected sucessfully.');
    } catch (error) {
      this.#logger.error(`Error while connecting consumer. ${error}`);
      throw error;
    }

    try {
      this.#logger.info(`Subscribing consumer to topics ${this.#listenerEvents}`);
      const subscribePromise = this.#listenerEvents.map(event => this.#consumer.subscribe({ topic: event }));
      await Promise.all(subscribePromise);
      this.#logger.info(`Consumer subscribe to topics successfully`);
    } catch (error) {
      this.#logger.error(`Error while subscribing to the topics ${error}`);
      throw error;
    }
    setTimeout(async () => {
      try {
        this.#logger.info(`Running consumer`);
        await this.#consumer.run({
          partitionsConsumedConcurrently: this.#listenerEvents.length,
          eachMessage: ({ topic, partition, message }) => {
            const start = Date.now();
            const trackId = message.headers.track_id.toString() || shortuuid();
            this.#asyncStorage.run(trackId, () => {
              const data = {
                key: message.key ? message.key.toString() : null,
                value: message.value
              };
              const logInfo = {
                topic,
                partition,
                offset: message.offset,
                key: data.key,
              };
              /** @type {import('./iEventArg').IEventArg} */
              const Message = decodeMessageCb(topic)

              this.#logger.info(`new data received`, logInfo);
              const sConsume = Date.now();
              const eventArg = Message.fromBinary(data.value);
              this.on(topic, eventArg, data.key);
              logInfo.latency = Date.now() - start;
              logInfo.consume_latency = Date.now() - sConsume;
              this.#logger.info('message consumed', logInfo);
            });
          }
        });
      } catch (error) {
        this.#logger.error(`Error while running consumer ${error}`, { error });
      }
    }, 500);

    return this.#consumer;
  }

  /**
   * Initialize kafka event store
   * @param {import('./iEventStore').InitOptions} options 
   */
  async init(options) {
    if (options.producer) {
      await this.#createKakfaProducer();
    }
    if (options.consumer) {
      await this.#createKafkaConsumer(options.decodeMessage);
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
      const start = Date.now();
      const [response] = await this.#producer.send({
        topic: event,
        messages: [
          {
            key,
            value: args.toBinary(),
            headers: {
              track_id: trackId
            }
          }
        ],
        acks: 1,
      });
      const elasped = Date.now() - start;
      this.#logger.info(`Sucessfully produced message`, {
        event,
        partition: response.partition,
        offset: response.baseOffset,
        key,
        produceIn: elasped
      });
    } catch (error) {
      this.#logger.error(`Error while producing message`, { error });
      throw error;
    }
  }

  async dispose() {
    super.dispose();
    if (this.#producer) {
      this.#logger.info('Disconnecting kafka producer');
      try {
        await this.#producer.disconnect();
        this.#logger.info('Producer disconnected');
      } catch (err) {
        this.#logger.error(`Producer failed to disconnect ${err}`);
      }
    }
    if (this.#consumer) {
      this.#isDisconnect = true;
      try {
        this.#logger.info('Disconnecting kafka producer');
        await this.#consumer.disconnect();
        this.#logger.info('Consumer disconnected');
      } catch (error) {
        this.#logger.error(`Consumer failed to disconnect ${error}`, error);
      }
    }
  }
}

async function initialize(context, options) {
  const store = new KafkaEventStore(context);
  await store.init(options);
  return store;
}
module.exports = {
  code: 'kafka',
  initOptions,
  initialize
};
