const io = require('@pm2/io');

async function initStatsClient(context) {
  const statsClient = io;
  context.statsClient = statsClient;
  return context;
}

module.exports = {
  initStatsClient
};
