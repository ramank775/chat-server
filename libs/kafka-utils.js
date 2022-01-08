const fs = require('fs'),
  { Kafka, logLevel } = require('kafkajs');

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
      (c) => parseInt(c),
      3000
    )
    .option(
      '--kafka-request-timeout <request-timeout>',
      'Time in milliseconds to wait for a successful request',
      (c) => parseInt(c),
      30000
    )
    .option(
      '--kafka-max-retry-time <max-retry-time>',
      'Max wait time for a retry in milliseconds',
      (c) => parseInt(c),
      30000
    )
    .option(
      '--kafka-initial-retry-time <retry-time>',
      'Initial value used to calculate retry in milliseconds',
      (c) => parseInt(c),
      300
    )
    .option(
      '--kafka-max-retries <max-retries>',
      'Max number of retries per call',
      (c) => parseInt(c),
      5
    )
    .option(
      '--kafka-metadata-max-age <metadata-max-age>',
      'The period of time in milliseconds after which we force a refresh of metadata',
      (c) => parseInt(c),
      300000
    )
    .option(
      '--kafka-transaction-timeout <transaction-timeout>',
      'The maximum amount of time in ms that the transaction coordinator will wait for a transaction status update from the produce',
      (c) => parseInt(c),
      60000
    )
    .option(
      '--kafka-max-in-flight-reqeusts <max-in-flight-request>',
      'Max number of requests that may be in progress at any time. If falsey then no limit',
      (c) => parseInt(c),
      0
    )
    .option(
      '--kafka-session-timeout <session-timeout>',
      'Timeout in milliseconds used to detect failures.',
      (c) => parseInt(c),
      30000
    )
    .option(
      '--kafka-rebalance-timeout <rebalance-timeout>',
      'The maximum time that the coordinator will wait for each member to rejoin when rebalancing the group',
      (c) => parseInt(c),
      60000
    )
    .option(
      '--kafka-heartbeat-interval <heartbeat-interval>',
      'The expected time in milliseconds between heartbeats to the consumer coordinator.',
      (c) => parseInt(c),
      3000
    )
    .option(
      '--kafka-max-bytes-per-partition <max-bytes-per-partition>',
      'The maximum amount of data per-partition the server will return.',
      (c) => parseInt(c),
      1048576
    )
    .option(
      '--kafka-min-bytes <min-bytes>',
      'Minimum amount of data the server should return for a fetch request.',
      (c) => parseInt(c),
      1
    )
    .option(
      '--kafka-max-bytes <max-bytes>',
      'Maximum amount of bytes to accumulate in the response.',
      (c) => parseInt(c),
      10485760
    )
    .option(
      '--kafka-max-wait-time <max-wait-time>',
      'The maximum amount of time in milliseconds the server will block before answering the fetch request if there isn’t sufficient data to immediately satisfy the requirement given by minBytes',
      (c) => parseInt(c),
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
      (c) => parseInt(c),
      1000
    )
    .option(
      '--kafka-reauthentication-threshold <reauthentication-threshold>',
      'When periodic reauthentication (connections.max.reauth.ms) is configured on the broker side, reauthenticate when reauthenticationThreshold milliseconds remain of session lifetime.',
      (c) => parseInt(c),
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
    } else {
      return true;
    }
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
  } else if (options.kafkaSecurityProtocol === 'ssl') {
    return {
      authenticationTimeout: 1000,
      ssl: sslOptions()
    };
  } else {
    return {};
  }
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
  }
}
/**
 * Get kafka instance
 * @param {Object} context
 * @return {Kafka}
 */
function getKafkaInstance(context) {
  const { log, options } = context;
  let { kafka } = context;
  const logger = log;
  if (!kafka) {
    const kafkaOptions = parseKafkaOptions(options);
    kafka = new Kafka({
      ...kafkaOptions,
      logLevel: toLogLevel(logger.level == 'debug' ? 'info' : logger.level),
      logCreator: (level) => {
        return ({ namespace, level, label, log }) => {
          const { message, ...extra } = log;
          logger.log({
            level: toWinstonLogLevel(level),
            message,
            extra
          });
        };
      }
    });
  }
  context.kafka = kafka;
  return kafka;
}

async function createKakfaProducer(context) {
  const { log, options } = context;
  const kafka = getKafkaInstance(context);
  const producerOptions = parseKakfaProducerOptions(options);
  const producer = kafka.producer(producerOptions);
  log.info('connecting kafka producer');
  await producer.connect();
  const kafkaProducer = {
    _producer: producer
  };

  kafkaProducer.send = async function (topic, message, key) {
    try {
      const start = Date.now();
      const response = await this._producer.send({
        topic: topic,
        messages: [
          {
            key: key,
            value: JSON.stringify(message),
            acks: 1
          }
        ]
      });
      const elasped = Date.now() - start
      log.info(`Sucessfully produced message`, { response, produceIn: elasped });
    } catch (error) {
      log.error(`Error while producing message`, { error: error });
      throw error;
    }
  };

  kafkaProducer.disconnect = async function () {
    log.info('Disconnecting kafka producer');
    try {
      await this._producer.disconnect();
      log.info('Producer disconnected');
    } catch (err) {
      log.error(`Producer failed to disconnect ${err}`);
    }
  };
  return kafkaProducer;
}

async function createKafkaConsumer(context) {
  const { listenerEvents, options, log } = context;
  const kafka = getKafkaInstance(context);
  const consumerOptions = parseKakfaConsumerOptions(options);
  const consumer = kafka.consumer(consumerOptions);
  const kafkaConsumer = {
    _consumer: consumer,
    disconnect: false,
    onMessage: () => { },
    disconnect: async function () {
      this.disconnect = true;
      try {
        log.info('Disconnecting kafka producer');
        await this._consumer.disconnect();
        log.info('Producer disconnected');
      } catch (error) {
        log.error(`Consumer failed to disconnect ${err}`);
      }
    }
  };
  try {
    log.info('Connecting consumer.');
    await consumer.connect();
    log.info('Consumer connected sucessfully.');
  } catch (error) {
    log.error(`Error while connecting consumer. ${error}`);
    throw error;
  }

  try {
    log.info(`Subscribing consumer to topics ${listenerEvents}`);
    const subscribePromise = [];
    for (let i = 0; i < listenerEvents.length; i++) {
      let promise = consumer.subscribe({ topic: listenerEvents[i] });
      subscribePromise.push(promise);
    }
    await Promise.all(subscribePromise);
    log.info(`Consumer subscribe to topics successfully`);
  } catch (error) {
    log.error(`Error while subscribing to the topics ${error}`);
    throw error;
  }
  setTimeout(async () => {
    try {
      log.info(`Running consumer`);
      await consumer.run({
        eachMessage: ({ topic, partition, message }) => {
          const start = Date.now();
          const data = {
            key: message.key ? message.key.toString() : null,
            value: JSON.parse(message.value.toString())
          };
          const logInfo = {
            topic,
            partition,
            offset: message.offset,
            key: data.key,
          };
          log.info(`new data received`, {...logInfo, ...(data.value.META || {})});
          const sConsume = Date.now();
          kafkaConsumer.onMessage(topic, data.value);
          logInfo.latency = Date.now() - start;
          logInfo.consume_latency = Date.now() - sConsume;
          log.info('message consumed', logInfo);
        }
      });
    } catch (error) {
      log.error(`Error while running consumer ${error}`, { error });
    }
  }, 500);

  return kafkaConsumer;
}

async function initEventProducer(context) {
  context.publisher = await createKakfaProducer(context);
  return context;
}

async function initEventListener(context) {
  context.listener = await createKafkaConsumer(context);
  return context;
}

module.exports = {
  addStandardKafkaOptions,
  addKafkaSSLOptions,
  initEventProducer,
  initEventListener
};
