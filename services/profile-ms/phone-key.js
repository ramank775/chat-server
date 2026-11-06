const crypto = require('crypto');
const { promisify } = require('util');
const { Option } = require('commander');

const scrypt = promisify(crypto.scrypt);

/**
 * Only a mock-SMS server (dev stacks, tests) may run without PHONE_PEPPER:
 * nobody's number is real there. Public on purpose.
 */
const DEV_PEPPER = Buffer.from('vartalap-dev-phone-pepper');

/** Discoverability (decision 223); an account that never chose is `everyone`. */
const DISCOVERABILITY = ['everyone', 'chosen', 'nobody'];
const DEFAULT_DISCOVERABILITY = 'everyone';

function addPhoneKeyOptions(cmd) {
  return cmd.addOption(new Option(
    '--phone-pepper <hex>',
    '32-byte hex key every stored phone number is keyed with; generate once, never change'
  ).env('PHONE_PEPPER'));
}

/**
 * @param {{phonePepper?: string, smsSender?: string}} options
 * @returns {Buffer}
 */
function phonePepper({ phonePepper: hex, smsSender }) {
  if (!hex && smsSender === 'mock') return DEV_PEPPER;
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) {
    throw new Error('PHONE_PEPPER must be 64 hex characters (openssl rand -hex 32)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * The only form of a phone number the server keeps (decision 223):
 * HMAC-SHA256 under the pepper of the SHA-256 hex the app sends to
 * `/contacts/lookup`, so a lookup hash maps straight onto it.
 * @param {Buffer} pepper
 * @param {string} phoneHash sha256 hex of the E.164 number
 */
function phoneKey(pepper, phoneHash) {
  return crypto.createHmac('sha256', pepper).update(phoneHash).digest('hex');
}

/**
 * What the database remembers of the pepper, so a server started with a
 * different one refuses to boot instead of signing everybody up afresh.
 * @param {Buffer} pepper
 */
const pepperFingerprint = (pepper) => phoneKey(pepper, 'vartalap.phone-pepper');

/**
 * A `chosen` list entry: scrypt(owner user_id + the allowed person's phone
 * key, salt = pepper). Node 22 has no built-in Argon2id.
 * @param {Buffer} pepper
 * @param {string} ownerId
 * @param {string} allowedKey a `phoneKey`
 */
async function discoveryToken(pepper, ownerId, allowedKey) {
  return (await scrypt(ownerId + allowedKey, pepper, 32)).toString('hex');
}

module.exports = {
  DISCOVERABILITY,
  DEFAULT_DISCOVERABILITY,
  addPhoneKeyOptions,
  phonePepper,
  phoneKey,
  pepperFingerprint,
  discoveryToken
};
