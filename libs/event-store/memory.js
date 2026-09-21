/* eslint-disable max-classes-per-file -- the bus is the store's other half */
const { IEventStore } = require('./iEventStore');

/** @typedef {import('./iEventArg').IEventArg} IEventArg */

/**
 * The in-process bus behind the `memory` event store: one fan-out point per
 * topic, shared by every store instance in the process.
 *
 * - a topic may have any number of subscribers (one per consuming service);
 * - a handler never runs synchronously inside `publish`;
 * - events on one topic are delivered in the order they were published, each
 *   waiting for the previous one's handlers;
 * - a handler that throws is logged by the publisher and isolated: its peers
 *   and the events behind it still run.
 *
 * ponytail: one process only, no persistence, no redelivery. nats/kafka are
 * the event stores for anything that spans processes or has to survive a
 * restart.
 */
class MemoryEventBus {
  /** @type {Map<string, Set<Function>>} */
  #subscribers = new Map();

  /** topic -> the tail of its delivery chain, which keeps ordering @type {Map<string, Promise>} */
  #tail = new Map();

  /**
   * @param {string} topic
   * @param {(event: string, args: IEventArg, key: string) => Promise<void>} handler
   * @returns {() => void} unsubscribe
   */
  subscribe(topic, handler) {
    if (!this.#subscribers.has(topic)) this.#subscribers.set(topic, new Set());
    this.#subscribers.get(topic).add(handler);
    return () => {
      const handlers = this.#subscribers.get(topic);
      if (handlers) handlers.delete(handler);
    };
  }

  /**
   * Queue one event behind whatever is already in flight on `topic`.
   * @param {string} topic
   * @param {IEventArg} args
   * @param {string} key
   * @param {(error: Error) => void} onError
   * @returns {Promise<void>} settles when every handler of this event has run
   */
  publish(topic, args, key, onError) {
    const handlers = [...(this.#subscribers.get(topic) || [])];
    // `.then` is what keeps a handler out of the caller's stack
    const delivered = (this.#tail.get(topic) || Promise.resolve()).then(() =>
      Promise.all(
        handlers.map(async (handler) => {
          try {
            await handler(topic, args, key);
          } catch (error) {
            onError(error);
          }
        })
      )
    );
    this.#tail.set(topic, delivered);
    return delivered;
  }
}

/** Process-wide, so services sharing one runner share one bus. */
const bus = new MemoryEventBus();

/**
 * In-process event store. Emitted events are recorded on `events` (what the
 * unit tests assert on) and published to the bus, where the consumers that
 * listed the topic in `context.listenerEvents` pick them up.
 */
class MemoryEventStore extends IEventStore {
  /** @type {{event: string, args: IEventArg, key: string}[]} */
  events = [];

  #bus;

  #log;

  #topics;

  /** @type {(() => void)[]} */
  #unsubscribe = [];

  constructor(context, eventBus = bus) {
    super();
    this.#bus = eventBus;
    this.#log = context.log;
    this.#topics = context.listenerEvents || [];
  }

  /**
   * @param {import('./iEventStore').InitOptions} options
   */
  async init(options) {
    if (!options.consumer) return;
    // `this.on` is assigned by the service after this runs, so it is read at
    // delivery time, not here.
    this.#unsubscribe = this.#topics.map((topic) =>
      this.#bus.subscribe(topic, (event, args, key) => this.on(event, args, key))
    );
  }

  async emit(event, args, key) {
    this.events.push({ event, args, key });
    this.#bus.publish(event, args, key, (error) =>
      this.#log.error(`Error while handling ${event}`, { error })
    );
  }

  async dispose() {
    this.#unsubscribe.forEach((unsubscribe) => unsubscribe());
    this.#unsubscribe = [];
  }
}

function initOptions(cmd) {
  return cmd;
}

async function initialize(context, options) {
  const store = new MemoryEventStore(context);
  await store.init(options);
  return store;
}

module.exports = {
  code: 'memory',
  MemoryEventBus,
  MemoryEventStore,
  initOptions,
  initialize
};
