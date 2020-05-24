const kafka = require('../../libs/kafka-utils');

const maxRetryCount = 3;
const kafkaOptions = {}
const topics = ['new-message', 'message-sent-failed'];
const messageListener = kafka.createKafkaConsumer(topics, kafkaOptions);
const messageRedirector = kafka.createKakfaProducer(kafkaOptions);

messageListener.onMessage = (topic, message) => {
    if (topic == 'error-message-sent') {
        message.retry = message.retry || 0;
        message.retry += 1;
        if (message.retry > maxRetryCount) {
            messageRedirector.send('message-sent-failed', message);
            return;
        }
    }
    redirectMessage(message.to, message);
}

function redirectMessage(user, message) {
    const server = getServer(user);
    messageRedirector.send(`send-message-${server}`, message)
}

function getServer(user) {
    // call session service and get server user connected to
    const server = ''
    return server || 'db'; // if user is not online save the message to the db
}