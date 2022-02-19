const JsonServer = require('./json-socket-server');
const JsonClient = require('./json-socket-client');

const defaultPort = 8001;

function addJsonServerOptions(cmd) {
  return cmd.option(
    '--json-server-port <json-port>',
    'Json server port to start',
    (c) => Number(c),
    defaultPort
  );
}

function initJsonServer(context) {
  const { options } = context;
  const server = new JsonServer(options.jsonServerPort);
  context.jsonServer = server;
  return context;
}

function initJsonClient(url) {
  if (!url) return null;
  // eslint-disable-next-line prefer-const
  let [host, port] = url.split(':', 2);
  if (port) {
    port = Number(port);
  } else {
    port = defaultPort;
  }
  return new JsonClient(host, port);
}

module.exports = {
  addJsonServerOptions,
  initJsonServer,
  initJsonClient
};
