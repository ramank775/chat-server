const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { Implementation: WebPush } = require('../pns/webpush-pn-service');

/** A stand-in for Google's token endpoint and FCM, recording each request. */
async function stubGoogle(sendStatuses) {
  const seen = { tokens: [], sends: [] };
  let issued = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/token') {
        seen.tokens.push(new URLSearchParams(body).get('assertion'));
        issued += 1;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: `access-${issued}`, expires_in: 3600 }));
        return;
      }
      seen.sends.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.statusCode = sendStatuses.shift() ?? 200;
      res.end('{}');
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

function serviceAccount(tokenUri) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    type: 'service_account',
    project_id: 'vartalap-test',
    client_email: 'push@vartalap-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: tokenUri
  };
  return { base64: Buffer.from(JSON.stringify(key)).toString('base64'), publicKey };
}

async function service(google, base64, logs = []) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pns = new WebPush({
    options: {
      vapidSubject: 'mailto:test@example.com',
      vapidPublicKey: ecdh.getPublicKey().toString('base64url'),
      vapidPrivateKey: ecdh.getPrivateKey().toString('base64url'),
      fcmServiceAccountKey: base64,
      fcmApiUrl: google.url
    },
    log: { info: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} }
  });
  await pns.init();
  return pns;
}

test('an fcm: registration gets a signed, data only, high priority wake (decision 209)', async (t) => {
  const google = await stubGoogle([200]);
  t.after(() => google.server.close());
  const { base64, publicKey } = serviceAccount(`${google.url}/token`);
  const logs = [];
  const pns = await service(google, base64, logs);

  const status = await pns.push({ endpoint: 'fcm:device-token-0123456789abcdef0123456789', p256dh: null, auth: null });

  assert.strictEqual(status, 200);
  const [assertion] = google.seen.tokens;
  const [header, claims, signature] = assertion.split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')));
  const claimSet = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.strictEqual(claimSet.iss, 'push@vartalap-test.iam.gserviceaccount.com');
  assert.strictEqual(claimSet.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.deepStrictEqual(google.seen.sends, [{
    url: '/v1/projects/vartalap-test/messages:send',
    auth: 'Bearer access-1',
    body: {
      message: {
        token: 'device-token-0123456789abcdef0123456789',
        data: { t: 'wake' },
        android: { priority: 'HIGH', ttl: '86400s' }
      }
    }
  }]);
  assert.deepStrictEqual(logs, ['Push to FCM answered 200']);
});

test('the access token is reused, refreshed once on a 401, and a 404 comes back as gone', async (t) => {
  const google = await stubGoogle([200, 401, 200, 404]);
  t.after(() => google.server.close());
  const pns = await service(google, serviceAccount(`${google.url}/token`).base64);
  const topic = { endpoint: 'fcm:device-token-0123456789abcdef0123456789' };

  assert.strictEqual(await pns.push(topic), 200);
  assert.strictEqual(await pns.push(topic), 200);
  assert.strictEqual(await pns.push(topic), 404);

  assert.strictEqual(google.seen.tokens.length, 2);
  assert.deepStrictEqual(google.seen.sends.map((s) => s.auth),
    ['Bearer access-1', 'Bearer access-1', 'Bearer access-2', 'Bearer access-2']);
});

test('without a key an fcm: registration fails loudly; a bad key stops the start', async (t) => {
  const google = await stubGoogle([]);
  t.after(() => google.server.close());
  const pns = await service(google, undefined);
  await assert.rejects(pns.push({ endpoint: 'fcm:device-token-0123456789abcdef0123456789' }), /fcm-service-account-key/);
  await assert.rejects(service(google, Buffer.from('{"type":"x"}').toString('base64')), /not a base64 service account key/);
});

test('a failed sign in or send never puts a credential in the error', async (t) => {
  const { base64 } = serviceAccount('http://127.0.0.1:1/token');
  const google = await stubGoogle([]);
  t.after(() => google.server.close());
  const pns = await service(google, base64);
  const error = await pns.push({ endpoint: 'fcm:device-token-0123456789abcdef0123456789' }).catch((e) => e);
  assert.match(error.message, /^FCM sign in failed: ECONNREFUSED$/);
  assert.strictEqual(Object.keys(error).length, 0);
});
