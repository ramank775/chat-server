const short = require('short-uuid'),
  crypto = require('crypto');

function uuidv4() {
  return crypto.randomUUID()
}

function shortuuid() {
  return short.generate();
}

function extractInfoFromRequest(req, key = 'user', defaultValue = null) {
  return req.headers[key] || (req.state && req.state[key]) || defaultValue;
}

function getUTCEpoch() {
  const now = new Date();
  const utcMilllisecondsSinceEpoch = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
  const utcSecondsSinceEpoch = Math.round(utcMilllisecondsSinceEpoch / 1000);
  return utcSecondsSinceEpoch;
}

module.exports = {
  uuidv4,
  extractInfoFromRequest,
  getUTCEpoch,
  shortuuid
};
