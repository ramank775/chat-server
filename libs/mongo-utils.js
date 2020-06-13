const mongodb = require('mongodb'),
    fs = require('fs');


function addMongodbOptions(cmd) {
    return cmd.option('--mongo-url <mongo-url>', 'Mongodb connection string mongodb://host:port/db')
        .option('--mongo-auth', 'Enable authentication for mongodb')
        .option('--mongo-user <mongo-url>', 'Mongodb username for auth')
        .option('--mongo-password <mongo-password>', 'Mongodb password for auth')
        .option('--mongo-ssl-enable', 'Enable SSL for connection')
        .option('--mongo-cert <cert-path>', 'Mongod client certificate path');
}

async function initMongoClient(context) {
    const { log, options } = context;
    const clientCertificate = options.mongoSslEnable ? fs.readFileSync(options.mongoCert) : null
    const auth = options.mongoAuth ? { user: options.mongoUser, password: options.mongoPassword } : null
    let mongoConnectionOptions = {
        useNewUrlParser: true,
        auth,
        sslCert: clientCertificate,
        sslKey: clientCertificate
    }
    const url = options.mongoUrl;
    if (options.mongoSslEnable) {
        url += (((url.indexOf('?') > -1) ? '&' : '?') + 'ssl=true');
    }

    context.mongoClient = await mongodb.MongoClient(url, mongoConnectionOptions);
    return context;
}

module.exports = {
    addMongodbOptions,
    initMongoClient
}