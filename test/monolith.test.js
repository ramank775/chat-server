const test = require('node:test');
const assert = require('node:assert');
const { HttpServiceBase } = require('../libs/http-service-base');
const { AuthError } = require('../services/profile-ms/auth-provider');
const { Monolith } = require('../services/monolith');

const { describe, it, before, after } = test;

// ponytail: hand rolled stubs, matching the rest of the repo. What is under
// test is the mounting and the auth hook, not any one service.
function noop() { }
const log = { info: noop, error: noop, warn: noop, debug: noop };
const statsClient = { increment: noop, timing: noop, gauge: noop, decrement: noop };
const options = { port: 0, host: '127.0.0.1', baseRoute: '' };

const SESSION = { user_id: 'a1b2c3d4e', deviceId: 'device-1' };

/** Stands in for a mounted service: echoes the identity it was handed. */
class ToyService extends HttpServiceBase {
  constructor(context, routes, internalUri, notFoundCode) {
    super(context);
    this.routes = routes;
    this.internalUri = internalUri;
    this.toyNotFoundCode = notFoundCode;
  }

  async init() {
    await super.init();
    if (this.toyNotFoundCode) this.notFoundCode = this.toyNotFoundCode;
    const echo = async (req) => ({
      user: req.headers['x-user'] || null,
      device: req.headers['x-device'] || null,
      url: req.url
    });
    this.routes.forEach(([uri, method]) => this.addRoute(uri, method, echo));
    this.addInternalRoute(this.internalUri, 'GET', echo);
  }
}

/**
 * The runner, with two services mounted the way profile-ms and channel-ms are
 * and a stub for the in-process session check.
 */
async function startMonolith() {
  const internalRoutes = [];
  const mount = (prefix) => ({ mount: { prefix, internal: internalRoutes } });
  const base = { options, log, statsClient };

  const profileLike = new ToyService(
    { ...base, ...mount('/v3.0') },
    [['/auth/otp/send', 'POST'], ['/users/me', 'GET']],
    '/echo'
  );
  const channelLike = new ToyService(
    { ...base, ...mount('/v3.0/channels') },
    [['/', 'GET'], ['/{channelId}', 'GET']],
    '/channels/echo',
    'not_found'
  );

  const monolith = new Monolith({
    ...base,
    internalRoutes,
    workers: [],
    mounts: [
      { service: profileLike, prefix: '/v3.0' },
      { service: channelLike, prefix: '/v3.0/channels' }
    ],
    profileService: {
      async resolveSession(req, gated) {
        const { authorization } = req.headers;
        // `Bearer nousername` is a signed-in user who has not picked one yet
        if (!['Bearer good', 'Bearer nousername'].includes(authorization)) {
          throw new AuthError(401, 'MISSING_ACCESSKEY', 'Authorization bearer accesskey is required');
        }
        if (gated && authorization === 'Bearer nousername') {
          throw new AuthError(403, 'USERNAME_REQUIRED', 'Set a username first');
        }
        return { session: SESSION };
      }
    }
  });
  await monolith.init();
  await monolith.server.ready();
  return monolith;
}

describe('monolith mounting', () => {
  /** @type {Monolith} */ let monolith;
  const inject = (request) => monolith.server.inject(request);

  before(async () => { monolith = await startMonolith(); });
  after(async () => { await monolith.server.close(); });

  it('serves each service under the path nginx proxied it to', async () => {
    const me = await inject({
      method: 'GET',
      url: '/v3.0/users/me',
      headers: { authorization: 'Bearer good' }
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().url, '/v3.0/users/me');

    // a prefixed `/` route answers with and without the trailing slash
    const list = await inject({
      method: 'GET',
      url: '/v3.0/channels?type=group',
      headers: { authorization: 'Bearer good' }
    });
    assert.equal(list.statusCode, 200);

    const one = await inject({
      method: 'GET',
      url: '/v3.0/channels/abc',
      headers: { authorization: 'Bearer good' }
    });
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().url, '/v3.0/channels/abc');
  });

  it('keeps `/_internal/...` at the root, off the authenticated prefix', async () => {
    const internal = await inject({
      method: 'GET',
      url: '/_internal/echo',
      headers: { 'x-user': 'f00ba4321' }
    });
    assert.equal(internal.statusCode, 200);
    // no auth hook ran, so the caller's own x-user survives
    assert.equal(internal.json().user, 'f00ba4321');
  });

  it('answers /alive and gives each service its own 404 envelope', async () => {
    assert.equal((await inject({ method: 'GET', url: '/alive' })).statusCode, 200);

    const rootMiss = await inject({ method: 'GET', url: '/nope' });
    assert.equal(rootMiss.statusCode, 404);
    assert.equal(rootMiss.json().error.code, 'NOT_FOUND');

    // channel-ms spells its codes lowercase; the scope keeps that local to it
    const channelMiss = await inject({
      method: 'GET',
      url: '/v3.0/channels/a/b/c',
      headers: { authorization: 'Bearer good' }
    });
    assert.equal(channelMiss.statusCode, 404);
    assert.equal(channelMiss.json().error.code, 'not_found');
  });
});

describe('the in-process auth hook', () => {
  /** @type {Monolith} */ let monolith;
  const inject = (request) => monolith.server.inject(request);

  before(async () => { monolith = await startMonolith(); });
  after(async () => { await monolith.server.close(); });

  it('sets x-user and x-device from the session', async () => {
    const response = await inject({
      method: 'GET',
      url: '/v3.0/users/me',
      headers: { authorization: 'Bearer good' }
    });
    assert.deepEqual(
      { user: response.json().user, device: response.json().device },
      { user: SESSION.user_id, device: SESSION.deviceId }
    );
  });

  it('strips a client supplied identity instead of trusting it', async () => {
    const spoofed = await inject({
      method: 'GET',
      url: '/v3.0/users/me',
      headers: { authorization: 'Bearer good', 'x-user': 'deadbeef1', 'x-device': 'evil' }
    });
    assert.equal(spoofed.json().user, SESSION.user_id);
    assert.equal(spoofed.json().device, SESSION.deviceId);

    // and on a public route, where nothing sets it back
    const unauthenticated = await inject({
      method: 'POST',
      url: '/v3.0/auth/otp/send',
      headers: { 'x-user': 'deadbeef1', 'x-device': 'evil' }
    });
    assert.equal(unauthenticated.statusCode, 200);
    assert.deepEqual(
      { user: unauthenticated.json().user, device: unauthenticated.json().device },
      { user: null, device: null }
    );
  });

  it('leaves the /v3.0/auth/ routes unauthenticated, as nginx did', async () => {
    const response = await inject({ method: 'POST', url: '/v3.0/auth/otp/send' });
    assert.equal(response.statusCode, 200);
  });

  it('answers a rejection with the same envelope nginx @auth_error passed through', async () => {
    const missing = await inject({ method: 'GET', url: '/v3.0/users/me' });
    assert.equal(missing.statusCode, 401);
    assert.deepEqual(missing.json(), {
      error: {
        code: 'MISSING_ACCESSKEY',
        message: 'Authorization bearer accesskey is required'
      }
    });

    // the USERNAME_REQUIRED gate still decides per route: `/users/me` is
    // exempt, `/channels` is not
    const exempt = await inject({
      method: 'GET',
      url: '/v3.0/users/me',
      headers: { authorization: 'Bearer nousername' }
    });
    assert.equal(exempt.statusCode, 200);

    const gated = await inject({
      method: 'GET',
      url: '/v3.0/channels',
      headers: { authorization: 'Bearer nousername' }
    });
    assert.equal(gated.statusCode, 403);
    assert.equal(gated.json().error.code, 'USERNAME_REQUIRED');
  });

  it('never runs on the internal routes or on /alive', async () => {
    assert.equal((await inject({ method: 'GET', url: '/alive' })).statusCode, 200);
    assert.equal((await inject({ method: 'GET', url: '/_internal/echo' })).statusCode, 200);
  });
});
