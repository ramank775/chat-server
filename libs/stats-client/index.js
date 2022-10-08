const { IStatsClient } = require('./iStatsClient');
const StatsD = require('./statsd');

const STATS_CLIENT = [
  StatsD
];

/**
 * Add command line options for Stats Client
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--stats-client', 'Which stats client to use (statsd)', 'statsd');
  STATS_CLIENT.forEach((client) => {
    if (client.initOptions) {
      cmd = client.initOptions(cmd);
    }
  });
  return cmd;
}

/**
 * @private
 * Get Stats client as per the context options
 * @param {{options: {statsClient: string}}} context
 * @returns
 */
function getStatsClientImpl(context) {
  const {
    options: { statsClient }
  } = context;
  const client = STATS_CLIENT.find((c) => c.code === statsClient);
  if (!client) {
    throw new Error(`${statsClient} is not a registered stats client`);
  }
  return client;
}

/**
 * Initialize Stats client
 * @param {Object} context
 */
async function initialize(context) {
  const impl = getStatsClientImpl(context);
  const client = await impl.initialize(context, context.options);
  context.statsClient = client;
  return context;
}

module.exports = {
  IStatsClient,
  addStatsClientOptions: addOptions,
  initializeStatsClient: initialize,
}
