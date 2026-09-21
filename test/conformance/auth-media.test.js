const test = require('node:test');
const assert = require('node:assert');
const { WS_TYPE } = require('../../libs/v3-envelope');
const { BASE, api, connect, signupWithUsername } = require('./helper');

/**
 * Session rotation / revocation (AUTH_CONTRACT 4.4-4.6, 6.3-6.5), push topic
 * registration (5.1) and presigned media (SYNC_PROTOCOL 13) against the live
 * compose stack. Skipped unless CONFORMANCE_BASE_URL is set.
 */
const { describe, it, after } = test;

/** Matches --reauth-grace-ms in the gateway; the close frame lands after it. */
const REAUTH_GRACE_MS = 5000;

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

    const revoked = await api('POST', '/v3.0/auth/session/revoke', {
      token: victim.accesskey,
      body: { refreshToken: victim.refreshToken }
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.body, { status: true });

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

  // -- 11. push topic registration -----------------------------------------

  it('accepts only https topic urls under the configured ntfy base', async () => {
    const register = await api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: { topicUrl: `https://ntfy.vartalap/${user.user_id}-conformance` }
    });
    assert.equal(register.status, 200);
    assert.deepEqual(register.body, { status: true });

    const foreign = await api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: { topicUrl: 'https://ntfy.example.com/somebody-elses-topic' }
    });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.error, 'validation_failed');

    const plaintext = await api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: { topicUrl: 'http://ntfy.vartalap/insecure' }
    });
    assert.equal(plaintext.status, 400);

    const missingBody = await api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: {}
    });
    assert.equal(missingBody.status, 400);

    // null deregisters the device's topic (5.1)
    const dereg = await api('POST', '/v3.0/push/topic', {
      token: user.accesskey,
      body: { topicUrl: null }
    });
    assert.equal(dereg.status, 200);

    const anonymous = await api('POST', '/v3.0/push/topic', {
      body: { topicUrl: 'https://ntfy.vartalap/nope' }
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
