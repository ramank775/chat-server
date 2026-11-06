const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startProfileMs, signupWithUsername, bearer } = require('./helpers/profile-ms');

/**
 * Decision 223's timeline over REST: a post reaches its audience and no one
 * else, only the poster sees who reacted (no counts for anyone), only the
 * poster deletes, and a post and its photos go after the retention.
 */
describe('timeline', () => {
  /** @type {Awaited<ReturnType<typeof startProfileMs>>} */
  let app;
  let asha;
  let ravi;
  let meena;

  before(async () => {
    app = await startProfileMs('profile_ms_test_timeline');
    asha = await signupWithUsername(app, { phone: '+919300000001', username: 'tl_asha' });
    ravi = await signupWithUsername(app, { phone: '+919300000002', username: 'tl_ravi' });
    meena = await signupWithUsername(app, { phone: '+919300000003', username: 'tl_meena' });
    app.connect(asha, ravi);
    app.connect(asha, meena);
    app.connect(meena, ravi);
  });

  after(async () => {
    await app.stop();
  });

  const call = (who, method, url, payload) =>
    app.inject({ method, url, headers: bearer(who.accesskey), payload });
  const body = (res) => JSON.parse(res.payload);
  const post = (who, fields) =>
    call(who, 'POST', '/timeline/posts', { postId: crypto.randomUUID(), ...fields });
  const feed = async (who, query = '') =>
    body(await call(who, 'GET', `/timeline/feed${query}`));

  test('a post reaches its audience only; only the poster sees who reacted', async () => {
    const res = await post(asha, {
      text: 'Diwali at home',
      photos: [{ fileId: 'f-diwali', width: 4, height: 3 }],
      audience: [ravi.user_id]
    });
    assert.equal(res.statusCode, 201);
    const { postId, audience } = body(res);
    assert.deepEqual(audience, [ravi.user_id]);

    const [seen] = (await feed(ravi)).posts;
    assert.deepEqual(Object.keys(seen).sort(),
      ['author', 'createdAt', 'myReaction', 'photos', 'postId', 'text'],
      'no audience, no reactions, no counts');
    assert.equal(seen.postId, postId);
    assert.equal(seen.author, asha.user_id);
    assert.deepEqual(seen.photos, [{ fileId: 'f-diwali', width: 4, height: 3 }]);
    assert.deepEqual((await feed(meena)).posts, [], 'not in the audience');
    assert.deepEqual((await feed(asha)).posts, [], 'the feed is other people\'s posts');

    const react = (who, emoji) => call(who, emoji ? 'PUT' : 'DELETE',
      `/timeline/posts/${postId}/reaction`, emoji ? { emoji } : undefined);
    assert.equal((await react(meena, '😂')).statusCode, 404, 'a stranger cannot react');
    assert.equal((await react(asha, '👍')).statusCode, 404, 'nor the poster');
    assert.equal((await react(ravi, '🎉')).statusCode, 204);
    assert.equal((await react(ravi, '❤️')).statusCode, 204, 'one reaction each, the last wins');
    assert.equal((await feed(ravi)).posts[0].myReaction, '❤️');

    const mine = body(await call(asha, 'GET', '/timeline/posts/mine')).posts;
    assert.deepEqual(mine[0].reactions.map(({ userId, emoji }) => [userId, emoji]),
      [[ravi.user_id, '❤️']]);
    const list = await call(asha, 'GET', `/timeline/posts/${postId}/reactions`);
    assert.equal(body(list).reactions[0].userId, ravi.user_id);
    const denied = await Promise.all([ravi, meena].map((who) =>
      call(who, 'GET', `/timeline/posts/${postId}/reactions`)));
    assert.deepEqual(denied.map((r) => r.statusCode), [404, 404],
      'only the poster sees who reacted');

    assert.equal((await react(ravi)).statusCode, 204);
    assert.equal((await feed(ravi)).posts[0].myReaction, null);
  });

  test('only the poster deletes; the photos go with the post', async () => {
    const { postId } = body(await post(asha, {
      photos: [{ fileId: 'f-gone-1' }, { fileId: 'f-gone-2' }],
      audience: [ravi.user_id, meena.user_id]
    }));
    const del = (who) => call(who, 'DELETE', `/timeline/posts/${postId}`);
    assert.equal((await del(ravi)).statusCode, 404);
    assert.equal((await del(asha)).statusCode, 204);
    assert.equal((await feed(meena)).posts.length, 0);
    assert.deepEqual(app.fileDeletes.slice(-2).map((d) => [d.fileId, d.owner]),
      [['f-gone-1', asha.user_id], ['f-gone-2', asha.user_id]]);
    assert.equal((await del(asha)).statusCode, 404, 'once');
  });

  test('a post needs words or a photo and someone to go to; a retry is not a second post',
    async () => {
      const empty = await post(meena, { text: '  ', audience: [ravi.user_id] });
      assert.equal(empty.statusCode, 400);
      assert.equal(body(empty).error.code, 'EMPTY_POST');

      const nobody = await post(meena, { text: 'hi', audience: ['fffffffff'] });
      assert.equal(nobody.statusCode, 403);
      assert.equal(body(nobody).error.code, 'NOT_CONNECTED');

      const postId = crypto.randomUUID();
      const payload = { postId, text: 'once', audience: [ravi.user_id, 'fffffffff'] };
      const first = await call(meena, 'POST', '/timeline/posts', payload);
      assert.deepEqual(body(first).audience, [ravi.user_id], 'unknown ids dropped');
      const retry = await call(meena, 'POST', '/timeline/posts', payload);
      assert.equal(retry.statusCode, 200);
      assert.equal(body(retry).postId, postId);
      const taken = await call(ravi, 'POST', '/timeline/posts', { ...payload, audience: [meena.user_id] });
      assert.equal(taken.statusCode, 409);
      assert.equal((await feed(ravi)).posts.filter((p) => p.postId === postId).length, 1);
    });

  test('a post goes only to connections: a stranger is dropped (decision 219)', async () => {
    const stranger = await signupWithUsername(app, { phone: '+919300000008', username: 'tl_stranger' });
    const res = await post(asha, { text: 'family only', audience: [ravi.user_id, stranger.user_id] });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(body(res).audience, [ravi.user_id]);
    assert.equal((await feed(stranger)).posts.length, 0);
    const alone = await post(stranger, { text: 'hello?', audience: [asha.user_id] });
    assert.equal(body(alone).error.code, 'NOT_CONNECTED');
  });

  test('the feed pages newest first', async () => {
    const pager = await signupWithUsername(app, { phone: '+919300000004', username: 'tl_pager' });
    const reader = await signupWithUsername(app, { phone: '+919300000005', username: 'tl_reader' });
    app.connect(pager, reader);
    const texts = ['one', 'two', 'three'];
    for (let i = 0; i < texts.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await post(pager, { text: texts[i], audience: [reader.user_id] });
    }
    const first = await feed(reader, '?limit=2');
    assert.deepEqual(first.posts.map((p) => p.text), ['three', 'two']);
    const rest = await feed(reader, `?limit=2&before=${first.next}`);
    assert.deepEqual(rest.posts.map((p) => p.text), ['one']);
    assert.equal(rest.next, null);
  });

  test('posting is rate limited', async () => {
    const busy = await signupWithUsername(app, { phone: '+919300000006', username: 'tl_busy' });
    app.connect(busy, ravi);
    const codes = [];
    for (let i = 0; i < 11; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      codes.push((await post(busy, { text: `${i}`, audience: [ravi.user_id] })).statusCode);
    }
    assert.deepEqual(codes, [...Array(10).fill(201), 429]);
  });

  test('a post and its photos go after the retention, and with the account', async () => {
    const old = await signupWithUsername(app, { phone: '+919300000007', username: 'tl_old' });
    app.connect(old, ravi);
    await post(old, { photos: [{ fileId: 'f-old' }], audience: [ravi.user_id] });
    await app.server.timeline.sweepExpired(Date.now() - 24 * 60 * 60 * 1000);
    assert.equal(body(await call(old, 'GET', '/timeline/posts/mine')).posts.length, 1,
      'not yet');
    await app.server.timeline.sweepExpired(Date.now() + 31 * 24 * 60 * 60 * 1000);
    assert.equal(body(await call(old, 'GET', '/timeline/posts/mine')).posts.length, 0);
    assert.deepEqual(app.fileDeletes.at(-1), { fileId: 'f-old', owner: old.user_id });

    await post(old, { photos: [{ fileId: 'f-erased' }], audience: [ravi.user_id] });
    const erase = await call(old, 'POST', '/users/me/delete', { confirmation: 'DELETE tl_old' });
    assert.equal(erase.statusCode, 200);
    assert.deepEqual(app.fileDeletes.at(-1), { fileId: 'f-erased', owner: old.user_id });
    assert.equal((await feed(ravi)).posts.some((p) => p.author === old.user_id), false);
  });
});
