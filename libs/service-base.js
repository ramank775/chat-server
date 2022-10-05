const commander = require('commander');
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
  ctx = await statsClient.initializeStatsClient(ctx);
  return ctx;
}



function initDefaultOptions() {
  let cmd = new commander.Command('my name').allowUnknownOption();
  cmd
    .option('--app-name <app-name>', 'application name')
    .option('--log-level <log-level>', 'logging level debug/info/error', 'info')
    .option('--debug', 'enable debug mode (set log level to debug)', false);
  cmd.usage('help').on('help', () => {
    cmd.help();
    process.exit(0);
  });
  cmd = statsClient.addStatsClientOptions(cmd);
  return cmd;
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
      `Starting service with options ${JSON.stringify(this.options, (key, value) =>
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
  initDefaultOptions,
  resolveEnvVariables
};
