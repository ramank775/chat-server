const winston = require('winston');
const moment = require('moment');

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
      log(info, callback) {
        setImmediate(() => this.emit('logged', info));

        if (this.stderrLevels[info[LEVEL]]) {
          // eslint-disable-next-line no-console
          console.error(info[MESSAGE]);

          if (callback) {
            callback();
          }
          return;
        }

        // eslint-disable-next-line no-console
        console.log(info[MESSAGE]);

        if (callback) {
          callback();
        }
      }
    })
  ]
});

function isDebugEnabled() {
  const l = `${this.level}`;
  return l.toLowerCase() === 'debug';
};

winston.init = function init(options) {
  const formatter = winston.format((info) => {
    const result = { ...info };
    result.pid = process.pid;
    result.appName = options.appName;
    result.timeMillis = Date.now();
    return result;
  });
  const configure = {};

  if (options.debug) {
    configure.log = function log(info, callback) {
      setImmediate(() => this.emit('logged', info));

      if (this.stderrLevels[info[LEVEL]]) {
        // eslint-disable-next-line no-console
        console.error(info[MESSAGE]);

        if (callback) {
          callback();
        }
        return;
      }

      // eslint-disable-next-line no-console
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
