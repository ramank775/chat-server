const { MongoClient } = require('mongodb');
const fs = require('fs');

function addMongodbOptions(cmd) {
  return cmd
    .option('--mongo-url <mongo-url>', 'Mongodb connection string mongodb://host:port/db')
    .option('--mongo-auth', 'Enable authentication for mongodb', false)
    .option('--mongo-user <mongo-url>', 'Mongodb username for auth')
    .option('--mongo-password <mongo-password>', 'Mongodb password for auth')
    .option('--mongo-ssl-enable', 'Enable SSL for connection', false)
    .option('--mongo-cert <cert-path>', 'Mongod client certificate path');
}

function prepareMongoOptions(options) {
  const clientCertificate = options.mongoCert ? fs.readFileSync(options.mongoCert) : null;
  const auth = options.mongoAuth
    ? { username: options.mongoUser, password: options.mongoPassword }
    : null;
  const dbOptions = {
    auth,
    sslCert: clientCertificate,
    sslKey: clientCertificate,
  };
  let url = options.mongoUrl;
  if (options.mongoSslEnable) {
    url += `${url.indexOf('?') > -1 ? '&' : '?'}ssl=true`;
  }
  return { url, options: dbOptions };
}

/**
 * One client per context: profile-ms opens two databases, the monolith opens
 * six, and they all talk to the same `--mongo-url` with one connection pool.
 */
function initMongoClient(context) {
  if (!context.mongoClient) {
    const { url, options } = prepareMongoOptions(context.options);
    const client = new MongoClient(url, options);
    // every database sharing this client closes it on dispose, and the
    // driver's second close races with the first (it reads a topology the
    // first one already dropped). One close, everyone awaits it.
    const close = client.close.bind(client);
    let closing = null;
    client.close = (...args) => {
      closing = closing || close(...args);
      return closing;
    };
    context.mongoClient = client;
  }
  return context.mongoClient;
}

module.exports = {
  addMongodbOptions,
  initMongoClient
};
