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

function extractInfoFromRequest(req, key = 'x-user', defaultValue = null) {
  return req.headers[key] || (req.state && req.state[key]) || defaultValue;
}

function getUTCTime() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  return utc;
}

function getUTCEpoch() {
  const utcMilllisecondsSinceEpoch = getUTCTime();
  const utcSecondsSinceEpoch = Math.round(utcMilllisecondsSinceEpoch / 1000);
  return utcSecondsSinceEpoch;
}

function getFilename(file) {
  const ext = path.extname(file);
  const filename = path.basename(file, ext);
  return `${filename}.${uuidv4()}${ext}`;
}

/**
 * Hash a low-entropy secret (OTP code, username key) with a random salt.
 * ponytail: scrypt instead of the contract's bcrypt(10); both are memory/CPU
 * hard and bcrypt would be a new dependency. Swap in bcrypt if ops standardise on it.
 * @param {string} secret
 * @returns {Promise<string>} `<salt-hex>:<derived-hex>`
 */
async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 32, (err, key) => (err ? reject(err) : resolve(key)));
  });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Verify a secret against a hash produced by `hashSecret`
 * @param {string} secret
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verifySecret(secret, hash) {
  if (!hash || typeof hash !== 'string' || !hash.includes(':')) return false;
  const [saltHex, derivedHex] = hash.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(derivedHex, 'hex');
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, expected.length, (err, key) => (err ? reject(err) : resolve(key)));
  });
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Deterministic hash for a high entropy token (refresh token, phone) so it can be looked up by index
 * @param {string} value
 * @returns {string} sha256 hex
 */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function base64ToProtoBuffer(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

module.exports = {
  uuidv4,
  extractInfoFromRequest,
  getUTCEpoch,
  getUTCTime,
  shortuuid,
  getFilename,
  hashSecret,
  verifySecret,
  sha256,
  base64ToProtoBuffer,
  schemas
};
