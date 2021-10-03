const net = require('net');
const JsonSocket = require('./json-socket');
const events = require('events');

class JsonServer extends events.EventEmitter {
  constructor(port) {
    super();
    this.socket = net.createServer((socket) => {
      const _socket = new JsonSocket(socket);
      _socket.on('data', (data) => {
        this.emit('request', data, _socket);
      });
      _socket.on('close', (hadError) => this.emit('close', hadError));
      _socket.on('connect', () => this.emit('connect'));
      _socket.on('drain', () => this.emit('drain'));
      _socket.on('end', () => this.emit('end'));
      _socket.on('error', (err) => this.emit('error', err));
      _socket.on('lookup', (err, address, family, host) => this.emit('lookup', err, address, family, host)); // prettier-ignore
      _socket.on('ready', () => this.emit('ready'));
      _socket.on('timeout', () => this.emit('timeout'));
    });
    this.socket.listen(port);
  }
  async disconnect() {
    this.socket.close();
  }
}

module.exports = JsonServer;
