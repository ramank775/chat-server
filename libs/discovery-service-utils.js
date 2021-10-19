const fs = require('fs')

class FileDiscoveryService {
  _services = {};

  /**
   * File service constructor
   * @params {{serviceDiscoveryPath: string}} options
   */
  constructor(options) {
    const file = fs.readFileSync(options.serviceDiscoveryPath)
    this._services = JSON.parse(file)
  }

  async getServiceUrl(srv) {
    return this._services[srv]
  }
}

function addDiscoveryServiceOptions(cmd) {
  cmd = cmd.option('--service-discovery-path <service-discovery-path>', 'Path to service discovery service')
  return cmd;
}

async function initDiscoveryService(context) {
  const { options } = context;
  context.discoveryService = new FileDiscoveryService(options);
  return context;
}

module.exports = {
  addDiscoveryServiceOptions,
  initDiscoveryService,
}
