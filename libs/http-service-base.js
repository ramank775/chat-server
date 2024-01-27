const http = require('http');
const https = require('https');
const fs = require('fs');
const Hapi = require('@hapi/hapi');
const Boom = require('@hapi/boom');
const { ServiceBase } = require('./service-base');
const { extractInfoFromRequest, shortuuid } = require('../helper');

function addHttpOptions(cmd) {
  cmd
    .option('--port <port>', 'Http port (default 8000)', (c) => Number(c), 8000)
    .option('--host <host>', 'Http Server Host (default 127.0.0.1)', '127.0.0.1')
    .option('--ssl-cert <ssl-cert>', 'SSL public certificate')
    .option('--ssl-key <ssl-key>', 'SSL private key')
    .option('--base-route <base-route>', 'Base route for http service', '');
  return cmd;
}

async function initHttpResource(context) {
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
  context.httpServer = server;
  return context;
}

class HttpServiceBase extends ServiceBase {
  constructor(context) {
    super(context);
    this.hapiServer = null;
    this.meterDict = {};
    this.histDict = {};
    this.httpServer = context.httpServer;
    this.baseRoute = this.options.baseRoute || '';
    this.internalBaseRoute = '/_internal';
  }

  get uri() {
    return this.hapiServer.info.uri;
  }

  async init() {
    const { asyncStorage } = this.context;
    const serverOptions = {
      port: this.options.port,
      host: this.options.host,
      listener: this.httpServer
    }
    this.hapiServer = Hapi.server(serverOptions);
    this.httpServer = this.hapiServer.listener;

    this.hapiServer.ext('onRequest', async (req, h) => {
      req.startTime = new Date();
      this.statsClient.increment({
        stat: 'http.request.count',
        tags: {
          url: req.url.pathname,
        }
      })
      const trackId = extractInfoFromRequest(req, 'x-request-id') || shortuuid();
      req.trackId = trackId;
      asyncStorage.enterWith(trackId);
      this.log.info(`new request : ${req.url}`);
      return h.continue;
    });

    this.hapiServer.ext('onPreResponse', (req, h) => {
      this.statsClient.timing({
        stat: 'http.request.latency',
        value: req.startTime,
        tags: {
          url: req.url.pathname,
        }
      })
      return h.continue;
    });

    this.hapiServer.events.on('log', (event, tags) => {
      if (tags.error) {
        this.log.error(
          `Server error : ${event.error ? event.error.message : 'unknown'}. ${event.error}`
        );
      }
    });

    this.addRoute('/alive', 'GET', () => 'OK');
  }

  addRoute(uri, method, handler, options = {}) {
    const path = `${this.baseRoute}${uri}`;
    if (options && options.validate) {
      options.validate.options = {
        abortEarly: false
      }
      options.validate.failAction = (_req, _h, error) => {
        const errorMessage = error.details.map(({ message }) => message).join('\n')
        throw Boom.badRequest(errorMessage)
      }
    }
    this.hapiServer.route({
      method,
      path,
      handler,
      options
    });
  }

  addInternalRoute(uri, method, handler, options = {}) {
    const path = `${this.internalBaseRoute}${this.baseRoute}${uri}`;
    if (options && options.validate) {
      options.validate.options = {
        abortEarly: false
      }
      options.validate.failAction = (_req, _h, error) => {
        const errorMessage = error.details.map(({ message }) => message).join('\n')
        throw Boom.badRequest(errorMessage)
      }
    }
    this.hapiServer.route({
      method,
      path,
      handler: (req, res) => {
        req.internal = true;
        return handler(req, res)
      },
      options
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
  addHttpOptions,
  initHttpResource,
  HttpServiceBase
};
