class DeliveryManager {
  // constructor(context) { 
  //   this.initalize(context);
  //   // TODO: initialize logic
  // }

  // initalize() {
  //   // will handle all initialization logic
  // }

  async dispatch(_message) { 
    this.dispatch()
    // Group and dispatch message to relvent gateway
  }
}

function addOptions(cmd) {
  return cmd;
}

function init(context) {
  context.deliveryManager = new DeliveryManager(context)
  return context;
}

module.exports = {
  DeliveryManager,
  addOptions,
  init
}
