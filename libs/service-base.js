const
    commander = require('commander'),
    logger = require('./logger')


async function initDefaultResources(options) {
    let ctx = {
        options: options || {}
    }
    ctx = initLogger(ctx);
    return ctx;
}

async function initLogger(context) {
    context.log = logger.init(context.options)
    return context;
}

function initDefaultOptions() {
    const cmd = new commander.Command('my name').allowUnknownOption()
    cmd.option('--app-name <app-name>', 'application name')
        .option('--log-level <log-level>', 'logging level debug/info/error', 'info')
        .option('--debug', 'enable debug mode (set log level to debug)', false);
    cmd.usage('help').on('help', () => {
        cmd.help();
        process.exit(0);
    });
    return cmd;
}

function addStandardHttpOptions(cmd) {
    cmd.option('--port <port>', 'Http port (default 8000)',(c) => parseInt(c), 8000)
        .option('--ssl-cert <ssl-cert>', 'SSL public certificate')
        .option('--ssl-key <ssl-key>', 'SSL private key');
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


function resolveEnvVariables(options) {
    for (let index = 0; index < options.length; index++) {
        if(typeof options[index] === "string") {
            options[index] = options[index].replace(/\${([A-Z0-9_]*)}/ig, (_, n) => process.env[n])
        }        
    }
    // options = { ...options }
    // for (const key in options) {
    //     if (options.hasOwnProperty(key)) {
    //         const element = options[key];
    //         if (typeof element === "string") {
    //             options[key] = element.replace(/\${([A-Z0-9_]*)}/ig, (_, n) => process.env[n]);
    //         }
    //     }
    // }
    return options
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
        this.log.info('Starting service with options'+ JSON.stringify(this.options, (key, value) =>
            (/(Password|Secret|Key|Cert|Token)$/i.test(key) ? '*****' : value)
        ));
        this.init();
        this.handleError();
        return this;
    }

    handleError() {
        process.on('unhandledRejection', (reason, promise) => {
            this.log.error(`unhandledRejection: Reason:`, reason, {});
            if (reason.stack) {
                this.log.error(`unhandledRejection: Stack:`, reason.stack, {});
            }
        });

        process.on('uncaughtException', err => {
            this.log.error('[2] uncaughtException: ', err, {});
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
    addStandardHttpOptions,
    resolveEnvVariables
}