const { ServiceBase } = require('./service-base'),
  Hapi = require('@hapi/hapi');

class HttpServiceBase extends ServiceBase {
  constructor(context) {
    super(context);
    this.hapiServer = null;
    this.meterDict = {};
    this.histDict = {};
  }

  async init() {
    const { options, log } = this.context;
    this.hapiServer = Hapi.server({
      port: options.port,
      host: options.host
    });

    this.hapiServer.ext('onRequest', async (req, h) => {
      const meter = this.meterDict[req.url.pathname];
      if (meter) meter.mark();
      req.startTime = Date.now();
      log.info(`new request : ${req.url}`);
      return h.continue;
    });

    this.hapiServer.ext('onPreResponse', (req, h) => {
      const timeElapsed = Date.now() - req.startTime;
      const hist = this.histDict[req.url.pathname];
      if (hist) hist.set(timeElapsed);
      this.log.info(`${req.url.pathname} time elapsed ${timeElapsed}ms`);
      return h.continue;
    });

    this.hapiServer.events.on('log', (event, tags) => {
      if (tags.error) {
        log.error(
          `Server error : ${event.error ? event.error.message : 'unknown'}. ${event.error}`
        );
      }
    });

    this.addRoute('/alive', 'GET', () => {
      return 'OK';
    });
  }

  addRoute(uri, method, handler, options = {}) {
    this.meterDict[uri] = this.statsClient.meter({
      name: `${uri}/sec`,
      type: 'meter'
    });
    this.histDict[uri] = this.statsClient.metric({
      name: uri,
      type: 'histogram',
      measurement: 'median'
    });
    this.hapiServer.route({
      method: method,
      path: uri,
      handler: handler,
      options: options
    });
  }

  async run() {
    await super.run();
    await this.hapiServer.start();
    this.log.info(`Hapi Http server start at ${this.hapiServer.info.uri}`);
  }

  async shutdown() {
    await this.hapiServer.stop();
  }
}

module.exports = {
  HttpServiceBase
};
