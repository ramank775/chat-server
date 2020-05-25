const
    commander = require('commander'),
    logger = require('./logger')


async function initDefaultResources(options) {
    let ctx = {
        options: options || {}
    }
    initLogger(ctx);
    return context;
}

async function initLogger(context) {
    context.log = logger.init(context.options)
}

function initDefaultOptions() {
    const cmd = new commander.Command()
    cmd.option('--app-name', 'application name')
        .option('--log-level', 'logging level debug/info/error', 'info')
        .option('--debug', 'enable debug mode (set log level to debug', false);
    cmd.usage('help').on('help', () => {
        cmd.help();
        process.exit(0);
    });
    return cmd;
}

function addStandardHttpOptions(cmd) {
    cmd.option('--port', 'Http port (default 8000)', 8000)
        .option('--ssl-cert', 'SSL public certificate')
        .option('--ssl-key', 'SSL private key');
    return cmd;
}

async function initHttpServer(context) {
    const { options, log } = context;
    const { port, sslCert, sslKey } = options;
    let server;
    const isHttps = (sslCert && sslKey);
    if (isHttps) {
        log.info(`Creating an https server on port ${port}`)
        const https = require('https');
        const fs = require('fs');
        const key = fs.readFileSync(sslKey);
        const cert = fs.readFileSync(sslCert);
        server = https.createServer({
            key,
            cert
        });
    } else {
        log.info(`Creating an http server on port ${port}`);
        const http = require('http');
        server = http.createServer();
    }
    const serverPromise = new Promise((resolve, reject) => {
        server.listen(port, () => {
            log.info(`Http server started on ${isHttps ? 'https' : 'http'}//*:${port}`);
            resolve();
        }).on('error', (err) => {
            log.error('Error occur while starting a http server', err);
            reject();
        })
    })
    await serverPromise;
    context.httpServer = server;
    return context;
}


class ServiceBase {
    constructor(context) {
        this.context = context;
        this.options = context.options;
        this.log = context.log;
    }
    init() {

    }

    async run() {
        this.log.info('Starting service with options', JSON.stringify(this.options, (key, value) =>
            (/(Password|Secret|Key|Cert|Token)$/i.test(key) ? '*****' : value)
        ));
        this.init();
        this.handleError();
        return this;
    }

    handleError() {
        process.on('unhandledRejection', (reason, promise) => {
            log.error(`unhandledRejection: Reason:`, reason, {});
            if (reason.stack) {
                log.error(`unhandledRejection: Stack:`, reason.stack, {});
            }
        });

        process.on('uncaughtException', err => {
            log.error('[2] uncaughtException: ', err, {});
        });

        process.on('SIGTERM', () => this._shutdown());
        process.on('SIGINT', () => this._shutdown());
    }

    async shutdown() {

    }

    async _shutdown() {
        this.log.info('Shutting down service');
        try {
            await this.shutdown()
            process.exit(0);
        } catch (error) {
            this.log.error('Error while shutdown the application gracefully', error);
            process.exit(1);
        }
    }
}

module.exports = {
    ServiceBase,
    initDefaultResources,
    initHttpServer,
    initDefaultOptions,
    addStandardHttpOptions
}