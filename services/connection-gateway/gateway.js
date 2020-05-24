const { worker } = require('worker_threads');
const http = require('http');
const webSocker = require('ws');
const kafka = require('../../libs/kafka-utils')
const serverName = 'server-1';

//#region Server
const server = http.createServer();
const wss = new webSocker.Server({ noServer: true });
//#endregion


//#region Events
const User = {
    onConnect: function (user) {
        publishEvent('user-connected', user, {
            user: user,
            server: serverName
        })
    },
    onDisconnect: function (user) {
        publishEvent('user-disconnected', user, {
            user: user,
            server: serverName
        })
    }
}

const Message = {
    onNewMessage: function (message) {
        publishEvent('new-message', message.from, message)
    },
    onMessageSent: function (message) {
        publishEvent('message-sent', message.from, message)
    },
    onMessageSentFailed: function (message, err) {
        publishEvent('error-message-sent', message.from, {
            message: message,
            error: err
        });
    }
}

const kafkaOptions = {}

const publisher = kafka.createKakfaProducer(kafkaOptions)
function publishEvent(event, user, eventArgs) {
    publisher.send(event, eventArgs, user)
}
//#endregion

function onUserDisconnect(user) {
    producerWorker.postMessage({
        topic: 'user-disconnected',
        user: user,
        body = {
            user: user,
            server: serverName
        }
    });
}

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        ws.user = user
        wss.emit('connection', ws, request)
    });
});

const userSockerMapping = {}

wss.on('connection', (ws, request) => {
    const { user } = request.body
    userSockerMapping[user] = ws;
    ws.user = user;
    User.onConnect(user);
    ws.on('message', function (msg) {
        msg.to = this.user;
        const message = new Message(msg);
        Message.onNewMessage(message);
    });
    ws.on('close', function (code, reason) {
        User.onDisconnect(this.user);
        delete userSockerMapping[this.user];
    })
});

const listener = kafka.createKafkaConsumer([`send-message-${serverName}`], kafkaOptions);
listener.onMessage = (topic, message) => {
    const msg = new Message(message);
    const ws = userSockerMapping[msg.to];
    if (ws) {
        ws.send(msg);
        Message.onMessageSent(message);
        return;
    } else {
        Message.onMessageSentFailed(message, {
            code: -1,
            reason: 'user socket not found'
        });
    }
};