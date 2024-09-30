const { IEventStore } = require('./iEventStore');
const { IEventArg } = require('./iEventArg');
const Kafka = require('./kafka');
const Nats = require('./nats');

const EVENT_STORE = [Kafka, Nats];

/**
 * Add command line options for event store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option(
    '--event-store <event-source>',
    'Which event store to use (kafka, nats)',
    'nats'
  );
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
    options: { eventStore },
  } = context;
  const store = EVENT_STORE.find((s) => s.code === eventStore);
  if (!store) {
    throw new Error(`${eventStore} is not a registered event store`);
  }
  return store;
}

/**
 * Initialize Eventstore
 * @param {import('./iEventStore').InitOptions} options
 * @returns
 */
function initialize(options) {
  return async (context) => {
    const impl = getEventStoreImpl(context);
    const store = await impl.initialize(context, options);
    context.eventStore = store;
    return context;
  };
}

module.exports = {
  IEventStore,
  IEventArg,
  addEventStoreOptions: addOptions,
  initializeEventStore: initialize,
};
