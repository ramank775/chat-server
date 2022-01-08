const winston = require('winston'),
  moment = require('moment');

const LEVEL = Symbol.for('level');
const MESSAGE = Symbol.for('message');
// Setup winston by default to the console.
winston.configure({
  exitOnError: false,
  transports: [
    new winston.transports.Console({
      timestamp: () => moment().format('YYYY-MM-DD HH:mm:ss.SSS'),
      // enable color only when output supports TTY
      colorize: process.stdout.isTTY,
      handleExceptions: true,
      humanReadableUnhandledException: true,
      log: function (info, callback) {
        setImmediate(() => this.emit('logged', info));

        if (this.stderrLevels[info[LEVEL]]) {
          console.error(info[MESSAGE]);

          if (callback) {
            callback();
          }
          return;
        }

        console.log(info[MESSAGE]);

        if (callback) {
          callback();
        }
      }
    })
  ]
});

isDebugEnabled = function () {
  let l = this.level + '';
  return l.toLowerCase() === 'debug';
};

winston.init = function (options, asyncStorage) {
  const formatter = winston.format((info) => {
    let result = Object.assign({}, info);
    result.pid = process.pid;
    result.appName = options.appName;
    result.timeMillis = Date.now();
    result.track_id = asyncStorage.getStore()
    return result;
  });
  const configure = {};

  if (options.debug) {
    configure['log'] = function (info, callback) {
      setImmediate(() => this.emit('logged', info));

      if (this.stderrLevels[info[LEVEL]]) {
        console.error(info[MESSAGE]);

        if (callback) {
          callback();
        }
        return;
      }

      console.log(info[MESSAGE]);

      if (callback) {
        callback();
      }
    };
  }

  winston.configure({
    exitOnError: options.exitOnError || false,
    format: winston.format.combine(formatter(), winston.format.json()),
    transports: [new winston.transports.Console(configure)]
  });

  const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal', 'none'];
  const level = (options.logLevel || '').trim().toLowerCase();
  const mappedLevel = LOG_LEVELS.find((l) => l === level);
  winston.level = (options.debug ? 'debug' : mappedLevel) || 'info';
  winston.isDebugEnabled = isDebugEnabled;
  return winston;
};

module.exports = winston;
