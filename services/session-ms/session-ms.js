const kafka = require('../../libs/kafka-utils');
//#region Memory Cache
// TODO: replace it with external memory cache like redis
const memCahce = {};
memCahce.prototype.get = function (key) {
    return memCahce[key]
}
memCahce.prototype.set = function (key, value) {
    memCahce[key] = value
}
memCahce.prototype.remove = function (key) {
    delete memCahce[key]
}
//#endregion
//TODO: implement kafkaOptions

const kafkaOptions = {}
const listener = kafka.createKafkaConsumer(['user-connected', 'user-disconnected'], kafkaOptions);

listener.onMessage = (topic, value) => {
    switch (topic) {
        case 'user-connected':
            memCahce.set(value.user, value.server)
            break;
        case 'user-disconnected':
            const server = memCahce.get(value.user)
            if (server == value.server) {
                memChahe.remove(value.user)
            }
            break;
    }
};
// TODO: implement get User session function call
