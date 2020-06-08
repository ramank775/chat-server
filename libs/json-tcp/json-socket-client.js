const JsonSocket = require('./json-socket');
const events = require('events')

class JsonClient extends events.EventEmitter {
    constructor(host, port) {
       this._socket = new JsonSocket();
       this._socket.connect({host, port});
       this._socket.on('data', (data) => {
            this.emit('response', data);
        });
    }

    send(data) {
        this._socket.write(data);
    }

}

module.exports = JsonClient;