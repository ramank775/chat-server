/* eslint-disable class-methods-use-this */
/**
 * @typedef {Object} Stats
 * @property {string} stat name of the stat
 * @property {number|Date} value value of the stat
 * @property {number} sample_rate Determines the sampling rate. Range (0.0-1.0)
 * @property {Object} tags Set additional meta data for the stat.
 */

/**
 * @abstract
 * Base class for the stats client.
 */
class IStatsClient {

  constructor() {
    if (new.target === IStatsClient) {
      throw new TypeError("Cannot construct IStatsClient instances directly");
    }
  }

  /**
   * Increments a stat by specified amount
   * @param {Stats} stats 
   * @returns
   */
  // eslint-disable-next-line no-unused-vars
  increment(stats) {
    throw new Error("Not Implemented Exception")
  }

  /**
   * Decrements a stat by a specified amount
   * @param {Stats} stats
   * @returns
   */
  // eslint-disable-next-line no-unused-vars
  decrement(stats) {
    throw new Error("Not Implemented Exception")
  }

  /**
   * Measure the value of a resource. It maintain its value until it is next set.
   * @param {Stats} stats 
   * @returns
   */
  // eslint-disable-next-line no-unused-vars
  gauge(stats) {
    throw new Error("Not Implemented Exception")
  }

  /**
   * Mesaure the time taken by an operation.
   * @param {Stats} stats 
   * @returns
   */
  // eslint-disable-next-line no-unused-vars
  timing(stats) {
    throw new Error("Not Implemented Exception")
  }
}

module.exports = {
  IStatsClient
}
