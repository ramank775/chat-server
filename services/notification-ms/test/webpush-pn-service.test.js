const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const webpush = require('web-push');
const {
  Implementation: WebPushService,
  isPublicAddress,
  isAcceptableEndpoint
} = require('../pns/webpush-pn-service');

const VAPID = webpush.generateVAPIDKeys();
const SUBJECT = 'mailto:push@vartalap.test';

function noop() { }
const log = { info: noop, error: noop, debug: noop };

/** A device: its ECDH key pair and auth secret, as the UnifiedPush connector holds them. */
function device() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
  };
}

/**
 * RFC 8291 / RFC 8188 decrypt, written from the RFCs rather than with the
 * library that encrypted it. Single record.
 */
function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const senderPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const secret = ecdh.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  // the last record ends in a 0x02 delimiter followed by zero padding
  const end = padded.lastIndexOf(2);
  assert.ok(padded.subarray(end + 1).every((byte) => byte === 0), 'padding is all zeros');
  return padded.subarray(0, end).toString();
}

/** Verify the RFC 8292 `vapid t=<jwt>, k=<key>` header and return its claims. */
function verifyVapid(authorization) {
  const [, token, key] = authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.strictEqual(key, VAPID.publicKey);
  const raw = Buffer.from(key, 'base64url');
  const publicKey = crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33).toString('base64url')
    },
    format: 'jwk'
  });
  const [header, claims, signature] = token.split('.');
  assert.ok(
    crypto.verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    ),
    'VAPID signature verifies'
  );
  return JSON.parse(Buffer.from(claims, 'base64url').toString());
}

/** A local push service answering from `statuses` in turn (last one repeats). */
async function pushServer(statuses) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      const [status, headers] = statuses[Math.min(requests.length, statuses.length) - 1];
      if (status === 'reset') {
        req.socket.destroy();
        return;
      }
      res.writeHead(status, headers).end('ignored');
    });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { requests, origin, close: () => server.close() };
}

async function service(allowPrivate) {
  const pns = new WebPushService({
    log,
    options: {
      vapidPublicKey: VAPID.publicKey,
      vapidPrivateKey: VAPID.privateKey,
      vapidSubject: SUBJECT,
      pushAllowPrivateEndpoints: allowPrivate
    }
  });
  await pns.init();
  return pns;
}

test('address classifier: only public unicast is public', () => {
  const nonPublic = [
    '0.0.0.0', '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '224.0.0.1',
    '239.255.255.250', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
    '::ffff:100.64.0.1', '::127.0.0.1',
    'localhost', 'not-an-ip'
  ];
  const isPublic = [
    '8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1',
    '142.250.80.10', '2001:4860:4860::8888', '2606:4700::1111', '::ffff:8.8.8.8'
  ];
  nonPublic.forEach((address) => assert.strictEqual(isPublicAddress(address), false, address));
  isPublic.forEach((address) => assert.strictEqual(isPublicAddress(address), true, address));
});

test('endpoint check: https, length, userinfo, public host; the dev flag relaxes only scheme and address', async () => {
  const cases = [
    ['https://8.8.8.8/up/x', false, true],
    ['https://[2001:4860:4860::8888]/up/x', false, true],
    ['http://8.8.8.8/up/x', false, false],
    ['https://u@8.8.8.8/up/x', false, false],
    [`https://8.8.8.8/${'a'.repeat(2033)}`, false, false], // 2049 chars
    [`https://8.8.8.8/${'a'.repeat(2032)}`, false, true], // 2048 chars
    ['https://192.168.0.10/up/x', false, false],
    ['https://[fd00::1]/up/x', false, false],
    ['https://[::ffff:10.0.0.1]/up/x', false, false],
    ['https://localhost/up/x', false, false],
    ['http://10.0.2.2:8090/up/x', true, true],
    ['https://localhost/up/x', true, true],
    ['ftp://10.0.2.2/up/x', true, false],
    ['http://u:p@10.0.2.2/up/x', true, false],
    [`http://10.0.2.2/${'a'.repeat(2048)}`, true, false]
  ];
  // eslint-disable-next-line no-restricted-syntax
  for (const [endpoint, allowPrivate, expected] of cases) {
    // eslint-disable-next-line no-await-in-loop
    assert.strictEqual(await isAcceptableEndpoint(endpoint, allowPrivate), expected, `${endpoint.slice(0, 60)} ${allowPrivate}`);
  }
});

test('wake is RFC 8030 + 8291 + 8292: encrypted {"t":"wake"}, VAPID signed, TTL and Urgency', async () => {
  const server = await pushServer([[201]]);
  const target = device();
  try {
    const pns = await service(true);
    const endpoint = `${server.origin}/up/topic123?up=1`;

    const status = await pns.push({ endpoint, ...target.keys });

    assert.strictEqual(status, 201);
    assert.strictEqual(server.requests.length, 1);
    const [{ url, headers, body }] = server.requests;
    assert.strictEqual(url, '/up/topic123?up=1');
    assert.strictEqual(headers['content-encoding'], 'aes128gcm');
    assert.strictEqual(headers.ttl, '86400');
    assert.strictEqual(headers.urgency, 'high');
    assert.strictEqual(decrypt(body, target), '{"t":"wake"}');

    const claims = verifyVapid(headers.authorization);
    assert.strictEqual(claims.aud, server.origin);
    assert.strictEqual(claims.sub, SUBJECT);
    assert.ok(claims.exp <= Date.now() / 1000 + 12 * 3600, 'exp is at most 12 h out');
  } finally {
    server.close();
  }
});

test('without the dev flag a private endpoint is never contacted', async () => {
  const server = await pushServer([[201]]);
  const target = device();
  try {
    const pns = await service(false);
    const { port } = new URL(server.origin);
    await assert.rejects(pns.push({ endpoint: `https://127.0.0.1:${port}/up/x`, ...target.keys }));
    await assert.rejects(pns.push({ endpoint: `https://localhost:${port}/up/x`, ...target.keys }));
    await assert.rejects(pns.push({ endpoint: `${server.origin}/up/x`, ...target.keys }));
    assert.strictEqual(server.requests.length, 0);
  } finally {
    server.close();
  }
});

test('429 / 5xx retry honouring Retry-After, up to 3 attempts', async () => {
  const server = await pushServer([[503, { 'retry-after': '0' }], [429, { 'retry-after': '0' }], [202]]);
  try {
    const pns = await service(true);
    assert.strictEqual(await pns.push({ endpoint: `${server.origin}/up/x`, ...device().keys }), 202);
    assert.strictEqual(server.requests.length, 3);
  } finally {
    server.close();
  }

  const failing = await pushServer([[500, { 'retry-after': '0' }]]);
  try {
    const pns = await service(true);
    assert.strictEqual(await pns.push({ endpoint: `${failing.origin}/up/x`, ...device().keys }), 500);
    assert.strictEqual(failing.requests.length, 3, 'gives up after 3 attempts');
  } finally {
    failing.close();
  }
});

test('a network error (connection reset) is retried like a 5xx', async () => {
  const server = await pushServer([['reset'], [201]]);
  try {
    const pns = await service(true);
    assert.strictEqual(await pns.push({ endpoint: `${server.origin}/up/x`, ...device().keys }), 201);
    assert.strictEqual(server.requests.length, 2);
  } finally {
    server.close();
  }
});

test('a far Retry-After, a 410, a 413 or a redirect are not retried or followed', async () => {
  const responses = [
    [[429, { 'retry-after': '3600' }], 429],
    [[410], 410],
    [[413], 413],
    [[302, { location: '/elsewhere' }], 302]
  ];
  // eslint-disable-next-line no-restricted-syntax
  for (const [response, expected] of responses) {
    // eslint-disable-next-line no-await-in-loop
    const server = await pushServer([response]);
    try {
      // eslint-disable-next-line no-await-in-loop
      const pns = await service(true);
      // eslint-disable-next-line no-await-in-loop
      assert.strictEqual(await pns.push({ endpoint: `${server.origin}/up/x`, ...device().keys }), expected);
      assert.strictEqual(server.requests.length, 1, String(expected));
    } finally {
      server.close();
    }
  }
});

test('init refuses a missing VAPID key pair', async () => {
  const pns = new WebPushService({ log, options: { vapidSubject: SUBJECT } });
  await assert.rejects(pns.init());
});
