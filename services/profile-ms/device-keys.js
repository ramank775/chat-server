const crypto = require('crypto');
const Joi = require('joi');
const { AuthError } = require('./auth-provider/auth-provider');

const MAX_PREKEYS = 200;
const keyId = Joi.number().integer().min(0).max(0xffffff).required();
const bytes = (length) => Joi.string().base64().custom((value, helpers) => {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === length && decoded.toString('base64') === value
    ? value : helpers.error('any.invalid');
}).required();
const publicKey = bytes(33).custom((value, helpers) =>
  (Buffer.from(value, 'base64')[0] === 5 ? value : helpers.error('any.invalid')));
const bundleSchema = Joi.object({
  identityKey: publicKey,
  registrationId: Joi.number().integer().min(1).max(16383).required(),
  signedPreKey: Joi.object({ id: keyId, publicKey, signature: bytes(64) }).required(),
  preKeys: Joi.array().items(Joi.object({ id: keyId, publicKey }))
    .unique('id').max(MAX_PREKEYS).required()
}).required();

function publicBundle(record) {
  return {
    deviceId: record.deviceId,
    generation: record.generation,
    identityKey: record.identityKey,
    registrationId: record.registrationId,
    signedPreKey: record.signedPreKey
  };
}

// Both backends compare the revision atomically: claims and replenishment never lose each other.
async function changeKeys(db, userId, deviceId, change) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const current = await db.getDeviceKeys(userId, deviceId);
    const { next, result } = change(current);
    next.revision = crypto.randomUUID();
    // eslint-disable-next-line no-await-in-loop
    if (await db.saveDeviceKeys(next, current?.revision || null)) return result;
  }
  throw new AuthError(503, 'KEYS_BUSY', 'Key state changed; retry the request');
}

async function publishKeys(db, userId, deviceId, bundle) {
  return changeKeys(db, userId, deviceId, (current) => {
    const sameIdentity = current?.identityKey === bundle.identityKey;
    if (sameIdentity && current.registrationId !== bundle.registrationId) {
      throw new AuthError(409, 'KEY_CONFLICT', 'Keep the registration id for this identity');
    }
    if (sameIdentity && current.signedPreKey.id === bundle.signedPreKey.id
        && (current.signedPreKey.publicKey !== bundle.signedPreKey.publicKey
          || current.signedPreKey.signature !== bundle.signedPreKey.signature)) {
      throw new AuthError(409, 'KEY_CONFLICT', 'A signed prekey id cannot be reused');
    }
    const lastPreKeyId = sameIdentity ? current.lastPreKeyId : -1;
    const added = bundle.preKeys.filter((key) => key.id > lastPreKeyId);
    const preKeys = [...(sameIdentity ? current.preKeys : []), ...added];
    if (preKeys.length > MAX_PREKEYS) {
      throw new AuthError(409, 'PREKEY_CAPACITY', 'Too many unclaimed prekeys');
    }
    const next = {
      user_id: userId,
      deviceId,
      generation: sameIdentity ? current.generation : crypto.randomUUID(),
      identityKey: bundle.identityKey,
      registrationId: bundle.registrationId,
      signedPreKey: sameIdentity && current.signedPreKey.id > bundle.signedPreKey.id
        ? current.signedPreKey : bundle.signedPreKey,
      preKeys,
      // A retry of an old upload cannot resurrect a consumed one-time key.
      lastPreKeyId: Math.max(lastPreKeyId, ...added.map((key) => key.id))
    };
    return { next, result: { ...publicBundle(next), preKeyCount: preKeys.length } };
  });
}

async function claimKeys(db, userId, deviceId, generation) {
  return changeKeys(db, userId, deviceId, (current) => {
    if (!current || current.generation !== generation) {
      throw new AuthError(404, 'KEYS_NOT_FOUND', 'This device key generation is unavailable');
    }
    const [preKey, ...remaining] = current.preKeys;
    return {
      next: { ...current, preKeys: remaining },
      result: { ...publicBundle(current), preKey: preKey || null }
    };
  });
}

module.exports = { bundleSchema, publicBundle, publishKeys, claimKeys };
