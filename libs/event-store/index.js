/**
 * @callback Produce
 * @param {string} topic
 * @param {*} message
 * @param {string|undefined} key
 */
/**
 * @typedef IProducer
 * @property {Produce} produce
 */

/**
 * @typedef IConsumer
 * @function onMessage
 */

/**
 * @typedef IEventStore
 * @property {IProducer} producer
 * @property {} consumer
 * @callback disconnect
 */

const EVENT_STORE = [];

/**
 * Add command line options for event store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addEventStoreOptions(cmd) {
  cmd = cmd.option('--event-store <event-source>', 'Which event store to use (Kafka)', 'kafka');
  EVENT_STORE.forEach((store) => {
    if (store.initOptions) {
      cmd = store.initOptions(cmd);
    }
  });
  return cmd;
}

/**
 * @private
 * Get the event store as per the context options
 * @param {{options: {eventStore: string}}} context
 * @returns
 */
function getEventStoreImpl(context) {
  const {
    options: { eventStore }
  } = context;
  const store = EVENT_STORE.find((s) => s.code === eventStore);
  if (!store) {
    throw new Error(`${eventStore} is not a registered event store`);
  }
  return store;
}

/**
 * Initialize event store
 * @param {{options: { eventStore: string, [key: string]: any}, [key: string]: *}} context
 */
async function initEventStoreProducer(context) {
  const store = getEventStoreImpl(context);
  const producer = store.initProducer(context);
  const eventStore = context.eventStore || {};
  eventStore.producer = producer;
  context.eventStore = eventStore;
  return context;
}

/**
 * Initialize event store
 * @param {{options: { eventStore: string, [key: string]: any}, [key: string]: *}} context
 */
async function initEventStoreConsumer(context) {
  const store = getEventStoreImpl(context);
  const consumer = store.initConsumer(context);
  context.consumer = consumer;
  return context;
}

module.exports = {
  addEventStoreOptions,
  initEventStoreProducer,
  initEventStoreConsumer
}
