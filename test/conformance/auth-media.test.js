const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { WS_TYPE } = require('../../libs/v3-envelope');
const { BASE, api, connect, pushTopic, signupWithUsername } = require('./helper');

/**
 * Session rotation / revocation (AUTH_CONTRACT 4.4-4.6, 6.3-6.5), push topic
 * registration (5.1) and presigned media (SYNC_PROTOCOL 13) against the live
 * compose stack. Skipped unless CONFORMANCE_BASE_URL is set.
 */
const { describe, it, after } = test;

/** Matches --reauth-grace-ms in the gateway; the close frame lands after it. */
const REAUTH_GRACE_MS = 5000;

/**
 * A Web Push endpoint the stack accepts without the network: an IP literal
 * resolves to itself. Nothing is ever pushed to it, every registration here is
 * dropped before a message could queue for its device.
 */
const PUBLIC_ENDPOINT = 'https://8.8.8.8/conformance';

/** A device's UnifiedPush keys (AUTH_CONTRACT 5.1). */
function deviceKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url')
  };
}

describe('conformance: sessions, push and media', { skip: BASE ? false : 'CONFORMANCE_BASE_URL not set' }, () => {
  /** @type {*} */ let user;
  /** @type {*} */ let peer;
  /** @type {*} */ let socket;
  let fileId;

  after(async () => {
    if (socket) await socket.close();
  });

  it('signs two users in', async () => {
    user = await signupWithUsername('device-a');
    peer = await signupWithUsername('device-b');
    assert.ok(user.accesskey && peer.accesskey);
  });

  // -- 10. refresh rotation, replay, revoke --------------------------------

  it('rotates the refresh token and 401s the replay', async () => {
    const rotated = await api('POST', '/v3.0/auth/session/refresh', {
      body: { refreshToken: user.refreshToken, deviceId: user.deviceId }
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.user_id, user.user_id);
    assert.notEqual(rotated.body.accesskey, user.accesskey);
    assert.notEqual(rotated.body.refreshToken, user.refreshToken);

    // 4.3 — the old token matched and was replaced in one write
    const replay = await api('POST', '/v3.0/auth/session/refresh', {
      body: { refreshToken: user.refreshToken, deviceId: user.deviceId }
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'INVALID_REFRESH_TOKEN');

    // 4.1 — issuing invalidates the prior accesskey
    const stale = await api('GET', '/v3.0/users/me', { token: user.accesskey });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error.code, 'INVALID_ACCESSKEY');

    user.accesskey = rotated.body.accesskey;
    user.refreshToken = rotated.body.refreshToken;
    const fresh = await api('GET', '/v3.0/users/me', { token: user.accesskey });
    assert.equal(fresh.status, 200);
  });

  it('warns then closes the socket with 4002 when the session is revoked', async () => {
    // a throwaway session: 4.6 is a logout, nothing about it survives
    const victim = await signupWithUsername('device-x');
    socket = connect(victim.accesskey);
    await socket.opened;

    // 5.1/4.6 step 3 — register an endpoint so the revoke has something to deregister
    const registered = await api('POST', '/v3.0/push/topic', {
      token: victim.accesskey,
      body: { endpoint: `${PUBLIC_ENDPOINT}/${victim.user_id}-revoke`, ...deviceKeys() }
    });
    assert.equal(registered.status, 200);
    assert.ok(await pushTopic(victim.user_id, victim.deviceId), 'topic was not registered');

    const revoked = await api('POST', '/v3.0/auth/session/revoke', {
      token: victim.accesskey,
      body: { refreshToken: victim.refreshToken }
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.body, { status: true });

    assert.equal(
      await pushTopic(victim.user_id, victim.deviceId),
      null,
      'revoke must deregister the device push topic (4.6 step 3)'
    );

    const warning = await socket.waitFor((frame) => frame.type === WS_TYPE.WS_REAUTH_REQUIRED);
    assert.equal(warning.reauthRequired, true);

    const closed = await Promise.race([
      socket.closed,
      new Promise((resolve) => {
        setTimeout(() => resolve(null), REAUTH_GRACE_MS + 5000);
      })
    ]);
    assert.ok(closed, 'socket was never closed');
    assert.equal(closed.code, 4002);
    assert.equal(closed.reason, 'session_revoked');
    socket = null;

    // 4.6 — revoking an already revoked accesskey is a no-op, not an error
    const again = await api('POST', '/v3.0/auth/session/revoke', {
      token: victim.accesskey,
      body: {}
    });
    assert.equal(again.status, 200);

    const dead = await api('GET', '/v3.0/users/me', { token: victim.accesskey });
    assert.equal(dead.status, 401);
    assert.equal(dead.body.error.code, 'INVALID_ACCESSKEY');

    // the refresh token went with it, so the device has to log in again
    const refresh = await api('POST', '/v3.0/auth/session/refresh', {
      body: { refreshToken: victim.refreshToken, deviceId: victim.deviceId }
    });
    assert.equal(refresh.status, 401);
    assert.equal(refresh.body.error.code, 'INVALID_REFRESH_TOKEN');
  });

  // -- 11. push registration -----------------------------------------------

  it('serves the VAPID public key behind auth (5.0)', async () => {
    const vapid = await api('GET', '/v3.0/push/vapid', { token: user.accesskey });
    assert.equal(vapid.status, 200);
    assert.match(vapid.body.vapidPublicKey, /^[A-Za-z0-9_-]{87}$/);
    const point = Buffer.from(vapid.body.vapidPublicKey, 'base64url');
    assert.equal(point.length, 65);
    assert.equal(point[0], 0x04);

    const anonymous = await api('GET', '/v3.0/push/vapid');
    assert.equal(anonymous.status, 401);
  });

  it('registers only https public Web Push endpoints with valid keys (5.1)', async () => {
    const keys = deviceKeys();
    const endpoint = `${PUBLIC_ENDPOINT}/${user.user_id}`;
    const register = await api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: { endpoint, ...keys }
    });
    assert.equal(register.status, 200);
    assert.deepEqual(register.body, { status: true });
    const stored = await pushTopic(user.user_id, user.deviceId);
    assert.equal(stored.endpoint, endpoint);
    assert.equal(stored.p256dh, keys.p256dh);
    assert.equal(stored.auth, keys.auth);

    // a registration replaces the previous one for the same (user_id, deviceId)
    const replaced = await api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: { endpoint: `${endpoint}-2`, ...keys }
    });
    assert.equal(replaced.status, 200);
    assert.equal((await pushTopic(user.user_id, user.deviceId)).endpoint, `${endpoint}-2`);

    const badEndpoints = [
      'http://8.8.8.8/insecure',
      'https://someone:secret@8.8.8.8/userinfo',
      'https://127.0.0.1/loopback',
      'https://10.0.0.1/rfc1918',
      'https://169.254.169.254/link-local',
      'https://100.64.0.1/cgnat',
      'https://[::1]/loopback',
      'https://[fd00::1]/ula',
      'https://[::ffff:192.168.0.1]/mapped',
      `${PUBLIC_ENDPOINT}/${'a'.repeat(2048)}`
    ];
    const rejected = await Promise.all(badEndpoints.map((bad) => api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: { endpoint: bad, ...keys }
    })));
    rejected.forEach((res, index) => {
      assert.equal(res.status, 400, badEndpoints[index].slice(0, 60));
      assert.equal(res.body.error.code, 'INVALID_PUSH_ENDPOINT', badEndpoints[index].slice(0, 60));
    });

    const badKeys = [
      { p256dh: keys.p256dh },
      { ...keys, p256dh: keys.p256dh.slice(0, 43) },
      { ...keys, auth: crypto.randomBytes(8).toString('base64url') }
    ];
    const keyErrors = await Promise.all(badKeys.map((bad) => api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: { endpoint, ...bad }
    })));
    keyErrors.forEach((res) => {
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_PUSH_KEYS');
    });
    // none of the rejects touched the registration
    assert.equal((await pushTopic(user.user_id, user.deviceId)).endpoint, `${endpoint}-2`);

    const missingBody = await api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: {}
    });
    assert.equal(missingBody.status, 400);

    // null deregisters the device's endpoint (5.1)
    const dereg = await api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: { endpoint: null }
    });
    assert.equal(dereg.status, 200);
    assert.equal(await pushTopic(user.user_id, user.deviceId), null);

    const anonymous = await api('POST', '/v3.0/push/topic', {
      body: { endpoint, ...keys }
    });
    assert.equal(anonymous.status, 401);
  });

  // -- 12. presigned upload / download -------------------------------------

  it('presigns an upload the object store accepts', async () => {
    const blob = Buffer.from('conformance upload payload');
    const presigned = await api(
      'GET',
      `/v3.0/assets/upload/presigned_url?ext=txt&category=message&size=${blob.length}`,
      { token: user.accesskey }
    );
    assert.equal(presigned.status, 200);
    assert.ok(presigned.body.url.startsWith('http'));
    assert.ok(presigned.body.fileId);
    ({ fileId } = presigned.body);

    const put = await fetch(presigned.body.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'content-length': String(blob.length) },
      body: blob
    });
    assert.equal(put.status, 200, await put.text());

    const marked = await api('PUT', `/v3.0/assets/${fileId}/status`, {
      token: user.accesskey,
      body: { status: true }
    });
    assert.equal(marked.status, 200);

    // the unguessable fileId is the capability: the peer may download it
    const download = await api('GET', `/v3.0/assets/download/${fileId}/presigned_url`, {
      token: peer.accesskey
    });
    assert.equal(download.status, 200);
    const fetched = await fetch(download.body.url);
    assert.equal(fetched.status, 200);
    assert.equal(await fetched.text(), blob.toString());
  });

  // -- 12b. convergent uploads are stored once (decision 190) ---------------

  it('stores the same encrypted file once, and only bytes that match their hash', async () => {
    const blob = crypto.randomBytes(512);
    const sha256 = crypto.createHash('sha256').update(blob).digest('hex');
    const presign = (who) => api(
      'GET',
      `/v3.0/assets/upload/presigned_url?ext=bin&category=message&size=${blob.length}&sha256=${sha256}`,
      { token: who.accesskey }
    );
    const upload = async (url, bytes) => fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
      body: bytes
    });
    const complete = (id) => api('PUT', `/v3.0/assets/${id}/status`, {
      token: user.accesskey, body: { status: true }
    });

    // Junk under the hash is never indexed.
    const first = await presign(user);
    assert.equal(first.status, 200);
    assert.equal((await upload(first.body.url, crypto.randomBytes(512))).status, 200);
    const junk = await complete(first.body.fileId);
    assert.equal(junk.status, 409);
    assert.equal(junk.body.error.code, 'HASH_MISMATCH');
    assert.ok((await presign(peer)).body.url, 'still nothing to reuse');

    const second = await presign(user);
    assert.equal((await upload(second.body.url, blob)).status, 200);
    assert.equal((await complete(second.body.fileId)).status, 200);

    // Anyone uploading the same bytes now gets that copy, and no upload url.
    const again = await presign(peer);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { fileId: second.body.fileId, existing: true });
    const download = await api('GET', `/v3.0/assets/download/${again.body.fileId}/presigned_url`, {
      token: peer.accesskey
    });
    const fetched = Buffer.from(await (await fetch(download.body.url)).arrayBuffer());
    assert.ok(fetched.equals(blob));
  });

  it('rejects an oversize upload and an unknown fileId', async () => {
    const tooBig = await api(
      'GET',
      '/v3.0/assets/upload/presigned_url?ext=txt&category=message&size=999999999',
      { token: user.accesskey }
    );
    assert.equal(tooBig.status, 400);

    const unknown = await api('GET', '/v3.0/assets/download/does-not-exist/presigned_url', {
      token: user.accesskey
    });
    assert.equal(unknown.status, 404);
  });
});
