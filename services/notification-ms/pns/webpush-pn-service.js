const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { setTimeout: sleep } = require('timers/promises');
const webpush = require('web-push');
const { IPushNotificationService } = require('./pn-service');

/** SYNC_PROTOCOL §12.1: the whole plaintext, never message content. */
const WAKE = JSON.stringify({ t: 'wake' });
const TTL_SECONDS = 86400;
const SEND_TIMEOUT_MS = 5000;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
/**
 * ponytail: retries sleep in process, so a Retry-After past this drops the
 * wake instead of honouring it. The next queued message wakes the device
 * anyway. Upgrade path: a delayed retry queue if wakes go missing.
 */
const MAX_RETRY_DELAY_MS = 10000;

/**
 * AUTH_CONTRACT §5.1: everything a push endpoint may not resolve to.
 * net.BlockList matches IPv4-mapped IPv6 (`::ffff:10.0.0.1`) against the IPv4
 * rules on its own.
 * ponytail: NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses embedding a
 * private IPv4 pass. Add them if the server ever runs behind NAT64.
 */
const NON_PUBLIC = new net.BlockList();
[
  ['0.0.0.0', 8], // unspecified / this network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, broadcast
].forEach(([address, prefix]) => NON_PUBLIC.addSubnet(address, prefix, 'ipv4'));
[
  ['::', 96], // unspecified, loopback, deprecated IPv4-compatible
  ['fe80::', 10], // link-local
  ['fc00::', 7], // ULA
  ['ff00::', 8] // multicast
].forEach(([address, prefix]) => NON_PUBLIC.addSubnet(address, prefix, 'ipv6'));

/** @param {string} address an IP literal */
function isPublicAddress(address) {
  const family = net.isIP(address);
  return family !== 0 && !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * `dns.lookup` that fails unless every answer is public. Passed as the
 * request's `lookup`, so the socket connects to the address that was checked
 * (no DNS rebinding between the check and the connect).
 */
function lookupPublic(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(Object.assign(new Error(`${hostname} resolves to a non public address`), { code: 'ENOTPUBLIC' }));
    }
    return options.all
      ? callback(null, addresses)
      : callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * AUTH_CONTRACT §5.1: https, at most 2048 chars, no userinfo, a host that
 * resolves only to public addresses. `allowPrivate` is the dev escape hatch:
 * http and any address.
 * ponytail: a DNS failure (even a transient one) reads as an invalid endpoint.
 * @param {string} endpoint
 * @param {boolean} [allowPrivate]
 * @returns {Promise<boolean>}
 */
async function isAcceptableEndpoint(endpoint, allowPrivate = false) {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch (e) {
    return false;
  }
  if (url.username || url.password) return false;
  if (allowPrivate) return url.protocol === 'https:' || url.protocol === 'http:';
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    lookupPublic(host, { all: true }, (error) => resolve(!error));
  });
}

/**
 * @param {*} value base64url, padding tolerated
 * @param {number} length decoded byte length
 */
function decodeKey(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const key = Buffer.from(value, 'base64url');
  return key.length === length ? key : null;
}

/**
 * AUTH_CONTRACT §5.1: `p256dh` an uncompressed P-256 point (65 bytes), `auth`
 * 16 bytes, both base64url.
 */
function isValidPushKeys(p256dh, auth) {
  const point = decodeKey(p256dh, 65);
  if (!point || point[0] !== 0x04 || !decodeKey(auth, 16)) return false;
  try {
    crypto.ECDH.convertKey(point, 'prime256v1'); // throws when not on the curve
    return true;
  } catch (e) {
    return false;
  }
}

/** Retry-After (delta seconds or an HTTP date) in ms, else exponential backoff. */
function retryDelay(retryAfter, attempt) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const ms = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
    if (!Number.isNaN(ms)) return Math.max(ms, 0);
  }
  return RETRY_BASE_MS * 2 ** (attempt - 1);
}

/**
 * One POST, no redirects (node's http never follows them), body ignored.
 * @returns {Promise<{status: number, retryAfter?: string}>}
 */
function send({ endpoint, method, headers, body }, allowPrivate) {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'http:' ? http : https).request(
      url,
      {
        method,
        headers,
        lookup: allowPrivate ? undefined : lookupPublic,
        // Node gives each address 250 ms before trying the next; a far push
        // service (ntfy.sh is ~235 ms away from India) then loses its IPv4
        // attempt to a dead IPv6 one and the whole send fails (AggregateError).
        autoSelectFamilyAttemptTimeout: 1000,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode, retryAfter: res.headers['retry-after'] });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * RFC 8030 Web Push: the wake encrypted to the device (RFC 8291, aes128gcm)
 * and signed with the server's VAPID key (RFC 8292). AUTH_CONTRACT §5.
 */
class WebPushNotificationService extends IPushNotificationService {
  #options;

  #logger;

  constructor(context) {
    super(context);
    this.#options = context.options;
    this.#logger = context.log;
  }

  async init() {
    const { vapidSubject, vapidPublicKey, vapidPrivateKey } = this.#options;
    // throws on a missing or malformed VAPID config, so the service never starts without one
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  }

  /**
   * @param {{endpoint: string, p256dh: string, auth: string}} subscription
   * @returns {Promise<number>} the push service's final status
   */
  async push({ endpoint, p256dh, auth }) {
    const allowPrivate = !!this.#options.pushAllowPrivateEndpoints;
    const { origin } = new URL(endpoint);
    // checked again at send time: the host may resolve elsewhere by now, and an
    // IP literal never reaches `lookupPublic`
    if (!(await isAcceptableEndpoint(endpoint, allowPrivate))) {
      throw new Error(`Refusing to push to a non public endpoint on ${origin}`);
    }
    const request = webpush.generateRequestDetails({ endpoint, keys: { p256dh, auth } }, WAKE, {
      TTL: TTL_SECONDS,
      urgency: 'high'
    });
    const status = await this.#deliver(request, allowPrivate);
    if (status < 200 || status >= 300) {
      // origin only: the endpoint path is the device's push capability
      this.#logger.error(`Push to ${origin} answered ${status}`);
    }
    return status;
  }

  /** 429 / 5xx retry with backoff, honouring Retry-After (AUTH_CONTRACT §5.1). */
  async #deliver(request, allowPrivate, attempt = 1) {
    let status;
    let retryAfter;
    try {
      ({ status, retryAfter } = await send(request, allowPrivate));
    } catch (error) {
      // A reset, a timeout or every address failing is as transient as a 5xx;
      // a non public address is a refusal, never retried.
      if (error.code === 'ENOTPUBLIC' || attempt >= MAX_ATTEMPTS) throw error;
      await sleep(retryDelay(null, attempt));
      return this.#deliver(request, allowPrivate, attempt + 1);
    }
    if ((status !== 429 && status < 500) || attempt >= MAX_ATTEMPTS) return status;
    const delay = retryDelay(retryAfter, attempt);
    if (delay > MAX_RETRY_DELAY_MS) return status;
    await sleep(delay);
    return this.#deliver(request, allowPrivate, attempt + 1);
  }
}

function addOptions(cmd) {
  return cmd
    .option('--vapid-public-key <vapid-public-key>', 'VAPID public key, base64url uncompressed P-256 point')
    .option('--vapid-private-key <vapid-private-key>', 'VAPID private key, base64url')
    .option('--vapid-subject <vapid-subject>', 'VAPID subject, a mailto: or https: contact')
    .option(
      '--push-allow-private-endpoints',
      'DEV ONLY: accept http and private address push endpoints (a local ntfy). Never in a real deployment',
      false
    );
}

module.exports = {
  code: 'webpush',
  addOptions,
  Implementation: WebPushNotificationService,
  isPublicAddress,
  isAcceptableEndpoint,
  isValidPushKeys,
  WAKE
};
