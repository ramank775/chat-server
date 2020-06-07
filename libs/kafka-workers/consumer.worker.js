const {
    parentPort, workerData
} = require('worker_threads'),
    kafka = require('node-rdkafka'),
    Promise = require('bluebird'),
    log = require('../logger');

const { topics, kafka_config } = workerData;
const consumer = kafka.KafkaConsumer({
    ...kafka_config,
    offset_commit_cb: commitCallback
});

consumer.connect();

consumer.on('error', (err) => {
    log.error('Kafka consumer error', err);
})

const events = ['event', 'event.log', 'event.stats', 'event.throttle'];

events.forEach(event => {
    consumer.on(event, (data) => {
        if (/error/.test(event)) {
            log.error('Kafka consumer %s: %s', event, JSON.stringify(data || {}));
        } else {
            log.info('Kafka consumer %s: %s', event, JSON.stringify(data || {}));
        }
    });
});

let exit = false;
consumer.on('disconnected', data => {
    if (!exit) {
        log.info('Disconnected, reconnecting...');
        consumer.connect();
    } else {
        log.info('Kafka %s: %s', 'disconnected', JSON.stringify(data || {}));
    }
});
consumer.on('event.error', data => {
    log.info('Kafka %s: %s, disconnecting...', 'event.error', JSON.stringify(data || {}));
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
    parentPort.postMessage(data.toString());
});

const shutdown = async (eventName) => {
    log.info("Recieved shutdown event %s", eventName);
    exit = true;
    log.info("Shutting down customer");

    await consumer.disconnectAsync();

    setTimeout(() => process.exit(0), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const sleep = (time) => {
    return new Promise((resolve, _) => {
        setTimeout(resolve, time);
    })

}

(
    async () => {
        do {
            consumer.consumer();
            await sleep(100);
        } while (!exit)

    }

)();
