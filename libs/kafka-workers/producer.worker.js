const {
    parentPort, workerData
} = require('worker_threads');
const kafka = require('node-rdkafka');
const { kafka_config} = workerData;

const producer = kafka.HighLevelProducer(kafka_config);

producer.setValueSerializer((value) => {
    return Buffer.from(JSON.stringify(value));
});
producer.connect();

producer.on('ready', () => {
    parentPort.on('message', (value) => {
        const { topic, message, key } = value;
        producer.produce(topic, null, body, key, Date.now(), (err, offset)=> {
            if(err) {
                console.error("Error while producing topic ",err);
            }
            console.log("offset", offset);
        });
    });
});

