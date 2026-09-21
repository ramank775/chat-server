const http = require('http');
const https = require('https');
const fs = require('fs');
const Fastify = require('fastify');
const { ServiceBase } = require('./service-base');
const { shortuuid, errorEnvelope } = require('../helper');
const { als, getRequestId } = require('./request-context');

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

const kResponse = Symbol('response');

/**
 * The hapi response toolkit handlers still get as their second argument, so
 * `h.response(body).code(404)` keeps working on fastify. Returning one of these
 * from a handler (or a `pre` method) is what sends it.
 */
const h = {
  response: (source) => ({
    [kResponse]: true,
    source,
    statusCode: 200,
    headers: {},
    code(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    header(name, value) {
      this.headers[name] = value;
      return this;
    },
    /** hapi needs this to stop the lifecycle from a `pre`; here returning it is enough. */
    takeover() {
      return this;
    }
  })
};

function send(reply, response) {
  reply.code(response.statusCode);
  Object.keys(response.headers).forEach((name) => reply.header(name, response.headers[name]));
  // `undefined` is fastify's empty body; `null` would serialize to "null"
  return reply.send(response.source == null ? undefined : response.source);
}

/** The caller's request id, or a fresh one. */
function newStore(req) {
  return { requestId: req.headers['x-request-id'] || shortuuid() };
}

class HttpServiceBase extends ServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('fastify').FastifyInstance} */
    this.server = null;
    this.meterDict = {};
    this.histDict = {};
    this.httpServer = context.httpServer;
    /**
     * Mounted mode (services/monolith.js): the runner owns the Fastify
     * instance and the raw http server and hands this service an encapsulated
     * scope under `prefix` (assigned to `this.server` before `init()`).
     * `internal` collects the `/_internal/...` routes, which stay at the root
     * prefix so every internal http client keeps one base url.
     * Null means standalone: this service owns its server.
     * @type {{prefix: string, internal: object[]}|null}
     */
    this.mount = context.mount || null;
    this.baseRoute = this.options.baseRoute || '';
    this.internalBaseRoute = '/_internal';
    /** §11 envelope code for an unknown route; channel-ms answers lowercase. */
    this.notFoundCode = 'NOT_FOUND';
  }

  get uri() {
    const { address, port } = this.httpServer.address();
    return `${this.httpServer instanceof https.Server ? 'https' : 'http'}://${address}:${port}`;
  }

  async init() {
    if (!this.mount) {
      // media-ms and notification-ms tests build a service without initHttpResource
      this.httpServer = this.httpServer || http.createServer();
      this.server = Fastify({
        serverFactory: (handler) => {
          // the whole lifecycle - parsing, hooks, handler, serialization - runs
          // inside the store, so nothing below can lose the request id
          this.httpServer.on('request', (req, res) => als.run(newStore(req), handler, req, res));
          return this.httpServer;
        }
      });

      // per http server, not per mounted service: the monolith's root scope
      // already carries these and fastify inherits them down every prefix.
      // hapi read an empty body as `null`, and nginx's auth_request subrequest
      // forwards the caller's content-type with no body, so an empty json body
      // must reach the route (and its schema) instead of failing with a 400.
      const json = this.server.getDefaultJsonParser('error', 'error');
      this.server.addContentTypeParser(
        'application/json',
        { parseAs: 'string' },
        (req, body, done) => (body === '' ? done(null, null) : json(req, body, done))
      );
      this.server.decorateRequest('payload', { getter() { return this.body; } });
      this.server.decorateRequest('internal', false);
      this.server.decorateRequest('pre', null);
      this.server.decorateRequest('startTime', null);
    }

    // Everything below is fastify-encapsulated, so when mounted it covers this
    // service's prefix only: its own validator, hooks, error and 404 handler.
    this.server.setValidatorCompiler(({ schema }) => (data) =>
      schema.validate(data, { abortEarly: false })
    );

    this.server.addHook('onRequest', (req, _reply, done) => {
      // `inject` never reaches the http server above, so it enters the store
      // here: the rest of the lifecycle is driven from this `done()`.
      als.run(als.getStore() || newStore(req), () => {
        req.startTime = new Date();
        this.statsClient.increment({
          stat: 'http.request.count',
          tags: {
            url: req.url.split('?')[0],
          }
        })
        this.log.info(`new request : ${req.url}`);
        done();
      });
    });

    this.server.addHook('onSend', (req, reply, payload, done) => {
      reply.header('cache-control', 'no-cache');
      if (getRequestId()) reply.header('x-request-id', getRequestId());
      // hapi only ranged GETs; matching it keeps the response headers identical
      if (req.method === 'GET' && reply.statusCode === 200) {
        reply.header('accept-ranges', 'bytes');
      }
      done(null, payload);
    });

    this.server.addHook('onResponse', (req, _reply, done) => {
      this.statsClient.timing({
        stat: 'http.request.latency',
        value: req.startTime,
        tags: {
          url: req.url.split('?')[0],
        }
      })
      done();
    });

    // every non-envelope error (joi rejection, unknown route, crash) still leaves
    // the service through the AUTH_CONTRACT §11 envelope
    this.server.setErrorHandler((error, req, reply) => {
      const status = error.statusCode || 500;
      if (status >= 500) {
        this.log.error(`Unhandled error on ${req.url}: ${error.message}`);
        return reply.code(status).send(errorEnvelope('INTERNAL_ERROR', 'Internal server error'));
      }
      let { message } = error;
      if (error.details) {
        message = error.details.map((detail) => detail.message).join('\n');
      } else if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
        message = 'Invalid request payload JSON format';
      }
      return reply.code(status).send(errorEnvelope('validation_failed', message));
    });

    this.server.setNotFoundHandler((_req, reply) =>
      reply.code(404).send(errorEnvelope(this.notFoundCode, 'Not Found'))
    );

    this.addRoute('/alive', 'GET', (_req, res) =>
      res.response('OK').header('content-type', 'text/html; charset=utf-8')
    );
  }

  addRoute(uri, method, handler, options = {}) {
    this.route(`${this.baseRoute}${uri}`, method, handler, options, false);
  }

  addInternalRoute(uri, method, handler, options = {}) {
    this.route(`${this.internalBaseRoute}${this.baseRoute}${uri}`, method, handler, options, true);
  }

  /**
   * The one place a route reaches the server, so whoever owns `this.server`
   * (own instance today, one shared instance under a prefix tomorrow) is
   * invisible to the services.
   */
  route(path, method, handler, options, internal) {
    const { validate, pre } = options;
    // fastify warns about a schema key that is present but undefined
    const schema = {};
    [['params', 'params'], ['querystring', 'query'], ['body', 'payload'], ['headers', 'headers']]
      .filter(([, source]) => validate && validate[source])
      .forEach(([part, source]) => { schema[part] = validate[source]; });
    const config = {
      method: (Array.isArray(method) ? method : [method]).map((m) => m.toUpperCase()),
      url: path.replace(/{(\w+)}/g, ':$1'),
      schema,
      ...(pre && {
        preHandler: async (req, reply) => {
          for (let i = 0; i < pre.length; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            const result = await pre[i].method(req, h);
            if (result && result[kResponse]) return send(reply, result);
            req.pre = { ...req.pre, [pre[i].assign]: result };
          }
          return undefined;
        }
      }),
      handler: async (req, reply) => {
        if (internal) req.internal = true;
        const result = await handler(req, h);
        return result && result[kResponse] ? send(reply, result) : result;
      }
    };
    // mounted, `/_internal/...` must not pick up the service's prefix, and the
    // runner registers what lands here once every service has been mounted.
    if (internal && this.mount) this.mount.internal.push(config);
    else this.server.route(config);
  }

  async run() {
    await super.run();
    if (this.mount) return;
    await this.server.listen({ port: this.options.port, host: this.options.host });
    this.log.info(`Fastify Http server start at ${this.uri}`);
  }

  async shutdown() {
    if (!this.mount) await this.server.close();
  }
}

module.exports = {
  addHttpOptions,
  initHttpResource,
  HttpServiceBase
};
