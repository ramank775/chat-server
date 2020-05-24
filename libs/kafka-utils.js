const kakfa = require('node-rdkafka'),
    commander = require('commander'),
    { Worker } = require('worker_threads')
/**
 * Add standard kafka options
 * @param {commander} cmd 
 */
function addStandardKafkaOptions(cmd) {
    cmd.option('--kafka-broker-list <broker-list>', 'List of kafka brokers endpoints')
        .option('--kafka-client-id <client-id>')
        .option('--kafka-consumer-group <consumer-group-id>')
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

function parseOptions(options) {
    let cmd = new commander.Command();
    cmd = addStandardKafkaOptions(cmd);
    cmd = addKafkaSSLOptions(cmd)
    cmd.usage('help').on('help', () => {
        cmd.help();
        process.exit(0);
    });
    return cmd.parse(args).opts();
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

function parseKafkaProducerOptions(options) {
    return {
        'metadata.broker.list': options.kafkaBrokerList,
        'client.id': options.kafkaClientId,
        ...parseKafkaSSLOptions(options)
    }
}
function parseKafkaConsumerOptions(options) {
    return {
        'metadata.broker.list': options.kafkaBrokerList,
        'group.id': options.kafkaGroupId,
        ...parseKafkaSSLOptions(options)
    }
}
function createKakfaProducer(kafkaOptions) {
    const options = parseKafkaProducerOptions(kafkaOptions)
    const producerWorker = new Worker('./kafka-workers/producer.worker.js', {
        workerData: {
            kafka_config: options
        }
    });
    producerWorker.prototype.send = function (topic, message, key) {
        this.postMessage({
            topic,
            message,
            key
        });
    };
    return producerWorker;
}

function createKafkaConsumer(topics, kafkaOptions) {
    const options = parseKafkaConsumerOptions(kafkaOptions);
    const consumerWorker = new Worker('./kafka-workers/consumer.worker.js', {
        workerData: {
            kafka_config: options,
            topics
        }
    });
    consumerWorker.on('message', function (data) {
        this.onMessage(data.topic, JSON.parse(data.value))
    })
    consumerWorker.prototype.onMessage = function () {

    }
    return consumerWorker;
}

module.exports = {
    addStandardKafkaOptions,
    addKafkaSSLOptions,
    createKafkaConsumer,
    createKakfaProducer
}