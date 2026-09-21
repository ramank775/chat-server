const { IEventStore } = require('./iEventStore');

/** @typedef {import('./iEventArg').IEventArg} IEventArg */

/**
 * In-process event store. No broker, no persistence: emitted events are recorded
 * on `events` and delivered to `on` when a consumer has set one. Intended for
 * tests and single process dev runs.
 * ponytail: no fanout across processes; use nats/kafka for anything real.
 */
class MemoryEventStore extends IEventStore {
  /** @type {{event: string, args: IEventArg, key: string}[]} */
  events = [];

  #notImplementedOn;

  constructor() {
    super();
    this.#notImplementedOn = this.on;
  }

  async emit(event, args, key) {
    this.events.push({ event, args, key });
    if (this.on !== this.#notImplementedOn) {
      await this.on(event, args, key);
    }
  }
}

function initOptions(cmd) {
  return cmd;
}

async function initialize(context, options) {
  const store = new MemoryEventStore();
  await store.init(options);
  return store;
}

module.exports = {
  code: 'memory',
  initOptions,
  initialize
};
