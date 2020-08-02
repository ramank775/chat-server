const
    kafka = require('node-rdkafka'),
    Promise = require('bluebird'),
    log = require('../logger');

process.on('message', async (msg, options) => {
    if (msg == 'kill') {
        shutdown('KILL');
        return;
    }
    if (msg.type == 'option') {
        await createKafakConsumer(msg);
        await startKafkaConsumer();
    }
})


let shutdown = async (eventName) => {
    log.info(`Recieved shutdown event: ${eventName}`);
    exit = true;
    log.info("Shutting down customer");
    if (consumer) {
        await consumer.disconnectAsync();
    }
    setTimeout(() => process.exit(0), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const sleep = (time) => {
    return new Promise((resolve, _) => {
        setTimeout(resolve, time);
    })

}

let consumer;
let exit = false;
async function createKafakConsumer(options) {
    const { topics, kafka_config } = options;
    log.info(`starting kafka consumer with options  topics: ${topics}, config ${JSON.stringify(kafka_config, (key, value) =>
        (/(Password|Secret|Key|Cert|Token)$/i.test(key) ? '*****' : value))}`)
    consumer = kafka.KafkaConsumer({
        ...kafka_config
    });
    log.info(`connecting kafka consumer`)
    consumer.connect();
    log.info(`kafka consumer connected`)
    consumer.on('error', (err) => {
        log.error(`Kafka consumer error: ${err}`);
    })

    const events = ['event', 'event.log', 'event.stats', 'event.throttle'];

    events.forEach(event => {
        consumer.on(event, (data) => {
            if (/error/.test(event)) {
                log.error(`Kafka consumer ${event}: ${JSON.stringify(data || {})}`);
            } else {
                log.info(`Kafka consumer ${event}: ${JSON.stringify(data || {})}`);
            }
        });
    });


    consumer.on('disconnected', data => {
        if (!exit) {
            log.info('Disconnected, reconnecting...');
            consumer.connect();
        } else {
            log.info(`Kafka disconnected:${JSON.stringify(data || {})}`);
        }
    });
    consumer.on('event.error', data => {
        log.info(`Kafka event.error: ${JSON.stringify(data || {})}, disconnecting...`);
        consumer.disconnect();
    });

    Promise.promisifyAll(consumer, {
        filter: event => /^(connect|disconnect|flush)$/.test(event)
    });

    consumer.on('ready', () => {
        log.info('Kafka consumer connected')
        consumer.subscribe(topics);
    });

    consumer.on('data', (data) => {
        data.key = data.key.toString();
        data.value = JSON.parse(data.value.toString());
        const logInfo = { ...data, value: { META: data.value.META } };
        log.info(`new data received ${JSON.stringify(logInfo)}`);
        process.send(data);
    });

}

async function startKafkaConsumer() {
    log.info("running kafka consumer");
    // do {
    //     consumer.consume();
    //     await sleep(100);
    // } while (!exit)
    consumer.consume();
}

process.send('online');

(async () => await sleep(200))();