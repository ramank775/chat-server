const commander = require('commander');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const logger = require('./logger');
const statsClient = require('./stats-client');

async function initLogger(context) {
  context.log = logger.init(context.options, context.asyncStorage);
  return context;
}

async function initDefaultResources(options) {
  const asyncStorage = new AsyncLocalStorage();
  let ctx = {
    options: options || {},
    asyncStorage
  };
  ctx = await initLogger(ctx);
  ctx = await statsClient.initStatsClient(ctx);
  return ctx;
}



function initDefaultOptions() {
  const cmd = new commander.Command('my name').allowUnknownOption();
  cmd
    .option('--app-name <app-name>', 'application name')
    .option('--log-level <log-level>', 'logging level debug/info/error', 'info')
    .option('--debug', 'enable debug mode (set log level to debug)', false);
  cmd.usage('help').on('help', () => {
    cmd.help();
    process.exit(0);
  });
  return cmd;
}

function addStandardHttpOptions(cmd) {
  cmd
    .option('--port <port>', 'Http port (default 8000)', (c) => Number(c), 8000)
    .option('--host <host>', 'Http Server Host (default 127.0.0.1)', '127.0.0.1')
    .option('--ssl-cert <ssl-cert>', 'SSL public certificate')
    .option('--ssl-key <ssl-key>', 'SSL private key');
  return cmd;
}

async function initHttpServer(context) {
  const { options, log } = context;
  const { port, sslCert, sslKey } = options;
  let server;
  const isHttps = sslCert && sslKey;
  if (isHttps) {
    log.info(`Creating an https server on port ${port}`);

    const key = fs.readFileSync(sslKey);
    const cert = fs.readFileSync(sslCert);
    server = https.createServer({
      key,
      cert
    });
  } else {
    log.info(`Creating an http server on port ${port}`);
    server = http.createServer();
  }
  const serverPromise = new Promise((resolve, reject) => {
    server
      .listen(port, () => {
        log.info(`Http server started on ${isHttps ? 'https' : 'http'}//*:${port}`);
        resolve();
      })
      .on('error', (err) => {
        log.error('Error occur while starting a http server', err);
        reject();
      });
  });
  await serverPromise;
  context.httpServer = server;
  return context;
}

function resolveEnvVariables(options) {
  for (let index = 0; index < options.length; index += 1) {
    if (typeof options[index] === 'string') {
      options[index] = options[index].replace(/\${([A-Z0-9_]*)}/gi, (_, n) => process.env[n]);
    }
  }

  return options;
}

class ServiceBase {
  constructor(context) {
    this.context = context;
    this.options = context.options;
    this.log = context.log;
    this.statsClient = context.statsClient;
  }

  // eslint-disable-next-line class-methods-use-this
  init() { }

  async run() {
    this.log.info(
      `Starting service with options${JSON.stringify(this.options, (key, value) =>
        /(Password|Secret|Key|Cert|Token)$/i.test(key) ? '*****' : value
      )}`
    );
    this.init();
    this.handleError();
    return this;
  }

  handleError() {
    process.on('unhandledRejection', (reason, _promise) => {
      this.log.error(`unhandledRejection: Reason:`, reason, {});
      if (reason.stack) {
        this.log.error(`unhandledRejection: Stack:`, reason.stack, {});
      }
    });

    process.on('uncaughtException', (err) => {
      this.log.error('[2] uncaughtException: ', err, {});
    });

    process.on('SIGTERM', () => this._shutdown());
    process.on('SIGINT', () => this._shutdown());
  }

  /* eslint-disable-next-line class-methods-use-this, no-empty-function */
  async shutdown() { }

  async _shutdown() {
    this.log.info('Shutting down service');
    try {
      await this.shutdown();
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
};
