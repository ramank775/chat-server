const JsonServer = require('./json-tcp/json-socket-server'),
    JsonClient = require('./json-tcp/json-socket-client');

const defaultPort = 8001;

function addJsonServerOptions(cmd) {
    return cmd.option('json-server-port <json-port>', 'Json server port to start', (c) => parseInt(c), defaultPort)
}

function initJsonServer(context) {
    const { options } = context;
    const server = JsonServer(options.jsonServerPort);
    return context.jsonServer = server;
}

function initJsonClient(url) {
    if (!url) return null;
    let [host, port] = url.split(':', 2);
    if (port) {
        port = parseInt(port)
    } else {
        port = defaultPort
    }
    return new JsonClient({host, port});
}

module.exports = {
    addJsonServerOptions,
    initJsonServer,
    initJsonClient
};