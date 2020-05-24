const kafka = require('../../libs/kafka-utils');


//#region DB 
// TODO: add a real db
const db = {}
let messageId = 0;
db.prototype.save = function (message) {
    this[message.to] = this[message.to] || [message]
}
db.prototype.getMessageByUser = function (user) {
    return this[user];
}
//#endregion


const kafkaOptions = {};
const listener = kafka.createKafkaConsumer(['send-message-db', 'user-connected'], kafkaOptions);
const publisher = kafka.createKakfaProducer(kafkaOptions);
listener.onMessage = (topic, message) => {
    switch (topic) {
        case 'send-message-db':
            db.save(message);
            break;
        case 'user-connected':
            const messages = db.getMessageByUser(message.user);
            publisher.send('new-message', messages, message.user);
            break;
    }
}