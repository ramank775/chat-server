const {
    ServiceBase
} = require('./service-base'),
    Hapi = require('@hapi/hapi')



class HttpServiceBase extends ServiceBase {
    constructor(context) {
        super(context);
        this.hapiServer = null;
        this.meterDict = {};
    }

    async init() {
        const { options, log } = this.context;
        this.hapiServer = Hapi.server({
            port: options.port,
            host: '127.0.0.1'
        });

        this.hapiServer.ext('onRequest', (req, h) => {
            const meter = this.meterDict[req.url.pathname];
            if(meter) meter.mark();
            const tracer = this.tracer.startChildSpan(req.url.pathname, 1);
            tracer.start();
            req.tracer = tracer;
            log.info(`new request : ${req.url}`)
            return h.continue;
        });

        this.hapiServer.ext('onPreResponse', (req, h) =>{
            req.tracer.end();
            return h.continue;
        })

        this.hapiServer.events.on('log', (event, tags) => {
            if (tags.error) {
                log.error(`Server error : ${event.error ? event.error.message : 'unknown'}. ${event.error}`);
            }
        });

        this.addRoute('/alive', 'GET', () => {
            return "OK";
        });
    }

    addRoute(uri, method, handler, options = {}) {
        this.meterDict[uri] = this.statsClient.meter({
            name: `${uri}/sec`,
            type: 'meter'
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
        this.log.info(`Hapi Http server start at ${this.hapiServer.info.uri}`)
    }

    async shutdown() {
        await this.hapiServer.stop()
    }

}

module.exports = {
    HttpServiceBase
}