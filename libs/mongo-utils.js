const { MongoClient } = require('mongodb');
const fs = require('fs');

/**
 * Add mongodb options in command
 * @param {import('commander').Command} cmd
 * @returns
 */
function addMongodbOptions(cmd) {
  if (cmd.options.find((option) => option.is('--mongo-url'))) {
    return cmd;
  }
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

function initMongoClient(context) {
  const { url, options } = prepareMongoOptions(context.options);
  const mongoClient = new MongoClient(url, options);
  return mongoClient;
}

module.exports = {
  addMongodbOptions,
  initMongoClient,
};
