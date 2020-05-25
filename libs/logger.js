const winston = require('winston'),
    moment = require('moment');

// Setup winston by default to the console.
winston.configure({
    exitOnError: false,
    transports: [
        new winston.transports.Console({
            timestamp: () => moment().format('YYYY-MM-DD HH:mm:ss.SSS'),
            // enable color only when output supports TTY
            colorize: process.stdout.isTTY,
            handleExceptions: true,
            humanReadableUnhandledException: true
        })
    ]
});

isDebugEnabled = function () {
    let l = this.level + '';
    return l.toLowerCase() === 'debug';
};

winston.init = function (options) {

    winston.configure({
        exitOnError: options.exitOnError || false,
        rewriters: [(level, msg, meta, _) => {
            let result = Object.assign({}, meta);
            result.pid = process.pid;
            result.appName = options.appName;
            result.timeMillis = Date.now();
            
            return result;
        }],
        transports: [
            new winston.transports.Console({
                json: useJson,
                stringify: (obj) => JSON.stringify(obj),
                timestamp: () => moment().format('YYYY-MM-DD HH:mm:ss.SSS'),
                handleExceptions: true,
                humanReadableUnhandledException: true
            })
        ]
    });
    const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal', 'none'];
    const level = (options.logLevel || '').trim().toLowerCase();
    const mappedLevel = LOG_LEVELS.find(l => l === level);
    winston.level = (options.debug ? 'debug' : mappedLevel) || 'info';
    winston.isDebugEnabled = isDebugEnabled;
    return winston;
};

module.exports = winston;
