const JsonSocket = require('./json-socket');
const events = require('events')

class JsonClient extends events.EventEmitter {
    constructor(host, port) {
       this._socket = new JsonSocket();
       this._socket.connect({host, port});
    }

    send(data) {
        this._socket.write(data);
    }
}
