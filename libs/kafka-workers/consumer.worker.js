const {
    parentPort, workerData
} = require('worker_threads');
const kafka = require('node-rdkafka');
const { topics, kafka_config } = workerData;
const consumer = kafka.KafkaConsumer(kafka_config);

consumer.connect();

consumer.on('ready', () => {
    consumer.subscribe(topics);
    consumer.consume();
}).on('data', (data) => {
    parentPort.postMessage(data.toString());
    consumer.consume();
});
