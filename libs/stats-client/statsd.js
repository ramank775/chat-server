const { StatsD } = require('hot-shots');
const { IStatsClient } = require('./iStatsClient');

/** @typedef {import('./iStatsClient').Stats} Stats */

class StatsDClient extends IStatsClient {
  /** @type {import('hot-shots').StatsD} */
  client;

  constructor(options) {
    super();

    this.client = new StatsD({
      host: options.statsdHost || '127.0.0.1',
      port: options.statsdPort || 8125,
      protocol: options.statsdProtocol || 'udp',
      globalTags: {
        app: options.appName,
      }
    })
  }

  /**
   * Increments a stat by specified amount
   * @param {Stats} stats 
   * @returns
   */
  increment(stats) {
    this.client.increment(stats.stat, stats.value, stats.sample_rate, stats.tags);
  }

  /**
   * Decrements a stat by a specified amount
   * @param {Stats} stats
   * @returns
   */
  decrement(stats) {
    this.client.increment(stats.stat, stats.value, stats.sample_rate, stats.tags);
  }

  /**
   * Measure the value of a resource. It maintain its value until it is next set.
   * @param {Stats} stats 
   * @returns
   */
  gauge(stats) {
    this.client.gauge(stats.stat, stats.value, stats.sample_rate, stats.tags);
  }

  /**
   * Mesaure the time taken by an operation.
   * @param {Stats} stats 
   * @returns
   */
  timing(stats) {
    this.client.timing(stats.stat, stats.value, stats.sample_rate, stats.tags);
  }

}

/**
 * Add StatsD options
 * @param {import('commander').Command} cmd
 */
async function initOptions(cmd) {
  return cmd
    .option('--statsd-host', 'StatsD server host, default 127.0.0.1', '127.0.0.1')
    .option('--statsd-port', 'StatsD server port, default 8125', (c) => Number(c), 8125)
    .option('statsd-protocol', 'StatsD protocol, default UDP', 'udp')
}

async function initialize(context, options) {
  const client = new StatsDClient(options);
  return client;
}

module.exports = {
  code: 'statsd',
  initOptions,
  initialize,
}
