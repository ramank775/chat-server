const
    commander = require('commander'),
    { fork } = require('child_process'),
    path = require('path'),
    kafka = require('node-rdkafka'),
    Promise = require('bluebird')

/**
 * Add standard kafka options
 * @param {commander} cmd 
 */
function addStandardKafkaOptions(cmd) {
    cmd.option('--kafka-broker-list <broker-list>', 'List of kafka brokers endpoints')
        .option('--kafka-client-id <client-id>')
        .option('--kafka-consumer-group <consumer-group-id>')
        .option('--kafka-auto-commit <auto-commit>',
            'Automatically and periodically commit offsets in the background',
            c => c.toLowerCase() == 'true',
            true)
        .option('--kafka-auto-commit-interval <auto-commit-interval>',
            'The frequency in milliseconds that the consumer offsets are committed (written) to offset storage.',
            c => parseInt(c), 5000)
        .option('--kafka-heartbeat-interval <heartbeat-interval>', 'Group session keepalive heartbeat interval.',
            c => parseInt(c), 3000)
        .option('--kafka-retry-backoff <retry-backoff>', 'The backoff time in milliseconds before retrying a protocol request.',
            c => parseInt(c), 100)
        .option('--kafka-message-send-max-retries <message-send-max-retries>', 'How many times to retry sending a failing Message',
            c => parseInt(c), 2)
        .option('--kafka-message-max-bytes <message-max-bytes>', 'Maximum Kafka protocol request message size.',
            c => parseInt(c), 1000000)
        .option('--kafka-fetch-min-bytes <fetch-min-bytes>', 'Minimum number of bytes the broker responds with.',
            c => parseInt(c), 1)
        .option('--kafka-fetch-message-max-bytes <fetch-message-max-bytes>',
            'Initial maximum number of bytes per topic+partition to request when fetching messages from the broker',
            c => parseInt(c), 1048576)
        .option('--kafka-fetch-error-backoff <fetch-error-backoff>',
            'How long to postpone the next fetch request for a topic+partition in case of a fetch error.',
            c => parseInt(c), 500)
        .option('--kafka-queued-max-message-kbytes <queued-max-message-kbytes>', 'Maximum number of kilobytes per topic+partition in the local consumer queue.',
            c => parseInt(c), 1048576)
        .option('--kafka-fetch-wait-max <fetch-wait-max>', 'Maximum time the broker may wait to fill the response with fetch.min.bytes.',
            c => parseInt(c), 100)
        .option('--kakfa-queue-buffering-max <queue-buffering-max>',
            'Delay in milliseconds to wait for messages in the producer queue to accumulate before constructing message batches (MessageSets) to transmit to brokers',
            c => parseFloat(c), 0.5)
        .option('--kafka-queue-buffering-max-messages <queue-buffering-max-message>', 'Maximum number of messages allowed on the producer queue.',
            c => parseInt(c), 100000)
        .option('--kafka-batch-num-messages <batch-num-message>', 'Maximum number of messages batched in one MessageSet. ',
            c => parseInt(c), 10000)
        .option('--kafka-socket-timeout-ms <kafka-socket-timeout>', 'Default timeout for network requests.', c => parseInt(c), 60000)
    return cmd;
}

/**
 * Add kafka SSL options
 * @param {commander} cmd 
 */
function addKafkaSSLOptions(cmd) {
    return cmd.option('--kafka-security-protocol <protocol>', 'Protocol used to communicate with brokers [plaintext|ssl] (default plaintext)', 'plaintext')
        .option('--kafka-ssl-ca <path>', 'File or directory path to CA certificate(s) (PEM) for verifying the broker\'s key')
        .option('--kafka-ssl-certificate <path>', 'Path to client\'s public key (PEM) used for authentication')
        .option('--kafka-ssl-key <path>', 'Path to client\'s private key (PEM) used for authentication')
        .option('--kafka-ssl-key-password <password>', 'Private key passphrase, if any (for use with --kafka-ssl-key)');

}

function parseStandardKafkaOptions(options) {
    const kafkaOptions = {
        'bootstrap.servers': options.kafkaBrokerList,
        'client.id': options.kafkaClientId,
        'group.id': options.kafkaConsumerGroup,
        'enable.auto.commit': options.kafkaAutoCommit,
        'auto.commit.interval.ms': options.kafkaAutoCommitInterval,
        "heartbeat.interval.ms": options.kafkaHeartbeatInterval,
        'retry.backoff.ms': options.kafkaRetryBackoff,
        'message.send.max.retries': options.kafkaMessageSendMaxRetries,
        "message.max.bytes": options.kafkaMessageMaxBytes,
        'socket.keepalive.enable': true,
        "fetch.min.bytes": options.kafkaFetchMinBytes,
        "fetch.message.max.bytes": options.kafkaFetchMessageMaxBytes,
        "queued.min.messages": 1,
        "fetch.error.backoff.ms": options.kafkaFetchErrorBackoff,
        "queued.max.messages.kbytes": options.kafkaQueuedMaxMessageKbytes,
        "fetch.wait.max.ms": options.kafkaFetchWaitMax,
        "queue.buffering.max.ms": options.kakfaQueueBufferingMax,
        'queue.buffering.max.messages': options.kafkaQueueBufferingMaxMessages,
        'batch.num.messages': options.kafkaBatchNumMessages,
        'socket.timeout.ms': options.kafkaSocketTimeoutMs
    }
    return kafkaOptions
}


/**
 * Prepare SSL options for kafka client.
 * @param {Object} options
 * @returns {Object}
 */
function parseKafkaSSLOptions(options) {
    if (options.kafkaSecurityProtocol === 'ssl') {
        return {
            'security.protocol': options.kafkaSecurityProtocol,
            'ssl.ca.location': options.kafkaSslCa,
            'ssl.certificate.location': options.kafkaSslCertificate,
            'ssl.key.location': options.kafkaSslKey,
            'ssl.key.password': options.kafkaSslKeyPassword
        };
    } else {
        return {};
    }
}

function parseKafkaOptions(options) {
    return {
        ...parseStandardKafkaOptions(options),
        ...parseKafkaSSLOptions(options)
    }
}

async function createKakfaProducer(context) {
    const { log, options } = context
    const kafkaOptions = parseKafkaOptions(options)
    const producer = kafka.HighLevelProducer({ ...kafkaOptions, dr_cb: true });
    Promise.promisifyAll(producer, {
        filter: event => /^(connect|disconnect|flush)$/.test(event)
    })
    producer.setValueSerializer((value) => {
        return Buffer.from(JSON.stringify(value));
    });
    producer.setPollInterval(100);

    producer.on('error', (err) => {
        log.error(`Kafka producer: error: ${JSON.stringify(err)}`);
    });

    producer.on('event.error', (err) => {
        log.error(`Kafka producer: event.error: ${JSON.stringify(err)}`);
    });

    producer.on('delivery-report', (err, report) => {
        if (err) {
            log.error(`Kafka producer: Delivery error: ${err}`);
        } else {
            const r = { ...report };
            r.key = r.key.toString();
            log.info(`Kafka producer: Delivery report: ${r}`);
        }
    });

    const ready = new Promise((resolve, _) => {
        producer.on('ready', () => {
            resolve();
        })
    });

    log.info('Connecting kafka producer');
    await producer.connectAsync({});
    log.info('kafka producer connected')

    await ready;
    log.info('kafka producer is ready')

    producer.setPollInterval(100);

    const kafkaProducer = {
        _producer: producer
    }

    kafkaProducer.send = function (topic, message, key) {
        this._producer.produce(topic, null, message, key, Date.now(), (err, offset) => {
            if (err) {
                log.error(`Error while producing topic ${err}`);
            }
            log.info(`offset: ${offset}`);
        });
    };
    kafkaProducer.disconnect = async function () {
        log.info("Disconnecting kafka producer");
        try {
            await this._producer.flushAsync(20000)
            log.info("Producer flushed all queued message");
        } catch (err) {
            log.error(`Error while flushing kafka message queue: ${err}`);
        } finally {
            await this._producer.disconnectAsync(10000, (err, data) => {
                if (err) {
                    log.error(`Producer failed to disconnect ${err}`);
                    return;
                }
                log.info("Producer disconnected")
            })
        }
    }
    return kafkaProducer;
}

async function createKafkaConsumer(context) {
    const { listenerEvents, options, log } = context;
    const kafkaOptions = parseKafkaOptions(options);
    const consumer_worker_path = path.join(__dirname, 'kafka-workers/consumer.worker.js');
    let consumerWorker = fork(consumer_worker_path, [], {
        slient: true,
        execArgv: ['--harmony']
    });
    

    const kafkaConsumer = {
        _consumer: consumerWorker,
        onMessage: () => { },
        disconnect: async function() {
            this._consumer.send('kill')
        }
    }
    let resolve;
    const ready = new Promise((success, _) => { resolve = success });
    consumerWorker.on('message', function (msg) {
        if (msg === 'online') {
            resolve();
            consumerWorker.send({ type: 'option', topics: listenerEvents, kafka_config: kafkaOptions });
            return;
        }
        kafkaConsumer.onMessage(msg.topic, msg.value)
    })
    consumerWorker.on('error', (err) => {
        log.error(`consumer worker throws error ${err}`)
    });

    consumerWorker.on('exit', (exitCode) => {
        log.info(`consumer worker exit with code ${exitCode}`);
    });

    await ready

    return kafkaConsumer;
}

async function initEventProducer(context) {
    context.publisher = await createKakfaProducer(context)
    return context;
}

async function initEventListener(context) {
    context.listener = await createKafkaConsumer(context)
    return context;
}

module.exports = {
    addStandardKafkaOptions,
    addKafkaSSLOptions,
    initEventProducer,
    initEventListener
}