const io = require('@pm2/io');

async function initStatsClient(context) {
    const { options: { appName } } = context;
    const statsClient = io.init({
        tracing: true
    });

    const tracer = statsClient.getTracer();
    const promise = new Promise((res) => {
            tracer.startRootSpan({
                name: appName
            }, (rootSpan) => {               
                res(rootSpan);
            });
    });
    tracer.currentRootSpan = await promise;
    context.tracer = tracer;
    context.statsClient = statsClient;
    return context;
}

module.exports = {
    initStatsClient
}
