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
    const formatter = winston.format((info) => {
        let result = Object.assign({}, info);
        result.pid = process.pid;
        result.appName = options.appName;
        result.timeMillis = Date.now();

        return result;
    })
    winston.configure({
        exitOnError: options.exitOnError || false,
        format: winston.format.combine(
            formatter(),
            winston.format.json()
        ),
        transports: [
            new winston.transports.Console({
                json: true,
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
