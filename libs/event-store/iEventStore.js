/**
 * @typedef {import('./iEventArg').IEventArg} IEventArg
 */
/**
 * @typedef {{producer: boolean; consumer: boolean; decodeMessageCb: (topic: string) => IEventArg }} InitOptions
 */

class IEventStore {

  constructor() {
    if (new.target === IEventStore) {
      throw new TypeError("Cannot construct IEventStore instances directly");
    }
  }


  /**
   * @property
   * Function to listen to new events
   * @param {string} _event Name of the event
   * @param {IEventArg} _args Event arguments
   * @param {string} _key Event Grouping key
   */

  // eslint-disable-next-line class-methods-use-this
  on = async (_event, _args, _key) => {
    throw new Error("Not Implemented Exception")
  };

  /**
   * @abstract
   * Initialize event store.
   * Use this function to connect to remote host or
   * perform any async setup operation
   * @param {InitOptions} _options 
   */
  /* eslint-disable-next-line class-methods-use-this, no-empty-function */
  async init(_options) { }

  /**
   * @abstract
   * Emit an new event to event store
   * @param {string} _event Name of the event
   * @param {IEventArg} _args Event arguments
   * @param {string} key Event grouping key
   */
  // eslint-disable-next-line class-methods-use-this
  async emit(_event, _args, _key) {
    throw new Error("Not Implemented Exception");
  }

  /**
   * Dispose the event store
   */
  /* eslint-disable-next-line class-methods-use-this, no-empty-function */
  async dispose() { }
}

module.exports = {
  IEventStore
};
