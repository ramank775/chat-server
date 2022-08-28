const short = require('short-uuid');
const crypto = require('crypto');
const path = require('path');
const schemas = require('./schema');

function uuidv4() {
  return crypto.randomUUID();
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

function getFilename(file) {
  const ext = path.extname(file);
  const filename = path.basename(file, ext);
  return `${filename}.${uuidv4()}${ext}`;
}

function base64ToProtoBuffer(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

module.exports = {
  uuidv4,
  extractInfoFromRequest,
  getUTCEpoch,
  shortuuid,
  getFilename,
  base64ToProtoBuffer,
  schemas
};
