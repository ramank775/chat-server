const { INotificationDB } = require('./pn-service');
const firebase = require('./firebase-pn-service');
const mock = require('./mock-pn-service');

const PN_IMPL = [
  firebase,
  mock
]

/**
 * Add command line options for PN service
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--pn-service <pn-service>', 'Which push notification service to use (firebase)', 'firebase');
  PN_IMPL.forEach(impl => {
    cmd = impl.addOptions(cmd)
  })
  return cmd;
}

/**
 * @private
 * Get the PN service implementation as per the context options
 * @param {{options: {pnService: string}}} context
 * @returns
 */
function getPNImpl(context) {
  const {
    options: { pnService }
  } = context;
  const store = PN_IMPL.find((s) => s.code === pnService);
  if (!store) {
    throw new Error(`${pnService} is not a registered push notification service`);
  }
  return store;
}

/**
 * Initialize database
 * @returns 
 */
async function initialize(context) {
  const impl = getPNImpl(context)
  const pns = new impl.Implementation(context);
  await pns.init();
  context.pns = pns;
  return context;
}


module.exports = {
  INotificationDB,
  addPNSOptions: addOptions,
  initializePNS: initialize
}
