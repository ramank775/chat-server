const protobufjs = require('protobufjs');
const path = require('path');

let protoRoot = null;
function loadProtoDefination(location) {
  if (!location) {
    location = path.join(__dirname, '../../proto', 'event-args.proto');
  }
  protoRoot = protobufjs.loadSync(location);
  return protoRoot;
}

function getProtoDefination(type) {
  if (!protoRoot) {
    protoRoot = loadProtoDefination();
  }
  return protoRoot.lookupType(type);
}

module.exports = {
  loadProtoDefination,
  getProtoDefination,
};
