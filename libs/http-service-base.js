const {
    ServiceBase
} = require('./service-base'),
    Hapi = require('@hapi/hapi')



class HttpServiceBase extends ServiceBase {
    constructor(context) {
        super(context);
        this.hapiServer = null;
    }

    async init() {
        const { options } = this.context;
        this.hapiServer = Hapi.server({
            port: options.port,
            host: '127.0.0.1'
        });

        this.addRoute('/alive', 'GET', () => {
            return "OK";
        })
    }

    addRoute(uri, method, handler) {
        this.hapiServer.route({
            method: method,
            path: uri,
            handler: handler
        })
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