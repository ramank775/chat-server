const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startChannelMs, op, headers } = require('./helper');
const { dmChannelId } = require('../../../libs/v3-envelope');

// Occasion albums (decision 233) on the TEST_DB backend: only the chat sees
// an album (a group's current members, a connected 1:1 with no block), who
// may remove and rename what, retention, and what goes with a group or an
// account.

const ASHA = 'a1a1a1a10';
const BEN = 'b2b2b2b20';
const CHLOE = 'c3c3c3c30';
const DEV = 'd4d4d4d40';
const EVA = 'e5e5e5e50';
const GROUP = '01efabcd-7000-8000-8abc-0000000a1b01';
const DAY_MS = 24 * 60 * 60 * 1000;

/** @type {Awaited<ReturnType<typeof startChannelMs>>} */
let harness;
/** What channel-ms asked media-ms to delete. */
const deletes = [];

test.before(async () => {
  harness = await startChannelMs('channel-ms-albums-test');
  harness.server.mediaClient = {
    post: async (path, payload) => {
      assert.strictEqual(path, '/_internal/files/delete');
      deletes.push(payload);
      return { deleted: true };
    }
  };
  // ASHA knows everyone but EVA; DEV knows only ASHA
  await Promise.all([BEN, CHLOE, DEV].map((u) => harness.server.db.connect(ASHA, u, Date.now())));
  await harness.server.db.connect(BEN, CHLOE, Date.now());
  // ASHA's group: BEN and CHLOE accept
  const created = await harness.inject({
    method: 'POST',
    url: '/',
    headers: headers(ASHA),
    payload: op(ASHA, 1, { channel_id: GROUP, kind: 'group', name: 'Family', members: [ASHA, BEN, CHLOE] })
  });
  assert.strictEqual(created.statusCode, 201);
  await Promise.all([BEN, CHLOE].map((u) => harness.inject({
    method: 'POST', url: `/${GROUP}/invite/accept`, headers: headers(u), payload: {}
  })));
});
test.after(async () => { await harness.stop(); });

const body = (response) => JSON.parse(response.payload);
const call = (method, url, user, payload) => harness.inject({
  method, url, headers: headers(user), ...(payload === undefined ? {} : { payload })
});
const codes = (responses) => responses.map((r) => r.statusCode);
const newAlbum = (user, channelId, fields = {}) => call('POST', `/${channelId}/albums`, user, {
  albumId: crypto.randomUUID(), title: 'Diwali 2026', ...fields
});
const add = (user, channelId, albumId, ...fileIds) => call(
  'POST', `/${channelId}/albums/${albumId}/photos`, user,
  { photos: fileIds.map((fileId) => ({ fileId, width: 4, height: 3 })) }
);
const open = async (user, channelId, albumId, query = '') =>
  body(await call('GET', `/${channelId}/albums/${albumId}${query}`, user));
const albumsOf = async (user, channelId, peer) =>
  body(await call('GET', `/${channelId}/albums${peer ? `?peer=${peer}` : ''}`, user)).albums;

test('a group album: members create, add and see; outsiders get nothing', async () => {
  const created = await newAlbum(BEN, GROUP, { date: '2026-11-01' });
  assert.strictEqual(created.statusCode, 201);
  const album = body(created);
  assert.strictEqual(album.creator, BEN);
  assert.strictEqual(album.date, '2026-11-01');
  assert.strictEqual(album.photoCount, 0);
  assert.strictEqual(album.cover, null);
  assert.strictEqual(album.keptUntil - album.createdAt, 90 * DAY_MS, 'kept 90 days');

  const added = await add(CHLOE, GROUP, album.albumId, 'f-g1', 'f-g2');
  assert.strictEqual(added.statusCode, 200);
  assert.deepStrictEqual(body(added).photos.map((p) => [p.fileId, p.uploader]),
    [['f-g1', CHLOE], ['f-g2', CHLOE]]);
  // a retry adds nothing twice
  assert.deepStrictEqual(body(await add(CHLOE, GROUP, album.albumId, 'f-g2')).photos, []);

  const [listed] = await albumsOf(ASHA, GROUP);
  assert.strictEqual(listed.albumId, album.albumId);
  assert.strictEqual(listed.photoCount, 2);
  assert.strictEqual(listed.cover.fileId, 'f-g2', 'the newest photo is the cover');
  const seen = await open(ASHA, GROUP, album.albumId);
  assert.deepStrictEqual(seen.photos.map((p) => p.fileId).sort(), ['f-g1', 'f-g2']);

  const outsider = await Promise.all([
    call('GET', `/${GROUP}/albums`, EVA),
    newAlbum(EVA, GROUP),
    call('GET', `/${GROUP}/albums/${album.albumId}`, EVA),
    add(EVA, GROUP, album.albumId, 'f-eva'),
    call('PATCH', `/${GROUP}/albums/${album.albumId}`, EVA, { title: 'Mine' }),
    call('DELETE', `/${GROUP}/albums/${album.albumId}`, EVA),
    call('DELETE', `/${GROUP}/albums/${album.albumId}/photos/f-g1`, EVA)
  ]);
  assert.deepStrictEqual(codes(outsider), Array(7).fill(403));
  assert.strictEqual(body(outsider[2]).error.code, 'forbidden');
  // an album of one chat is not reachable through another
  const other = dmChannelId(ASHA, BEN);
  assert.strictEqual((await call('GET', `/${other}/albums/${album.albumId}`, ASHA)).statusCode, 404);
});

test('photos page newest or oldest first', async () => {
  const { albumId } = body(await newAlbum(ASHA, GROUP, { title: 'Pages' }));
  await add(ASHA, GROUP, albumId, 'p1');
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  await add(BEN, GROUP, albumId, 'p2', 'p3');
  const newest = await open(CHLOE, GROUP, albumId, '?limit=2');
  assert.deepStrictEqual(newest.photos.map((p) => p.fileId), ['p3', 'p2']);
  const rest = await open(CHLOE, GROUP, albumId, `?limit=2&cursor=${newest.next}`);
  assert.deepStrictEqual(rest.photos.map((p) => p.fileId), ['p1']);
  assert.strictEqual(rest.next, null);
  const oldest = await open(CHLOE, GROUP, albumId, '?order=oldest');
  assert.deepStrictEqual(oldest.photos.map((p) => p.fileId), ['p1', 'p2', 'p3']);
  assert.strictEqual(oldest.next, null);
});

test('who removes and renames: uploader, creator, group owner or admin', async () => {
  const { albumId } = body(await newAlbum(BEN, GROUP, { title: 'Wedding' }));
  await add(ASHA, GROUP, albumId, 'w-asha');
  await add(CHLOE, GROUP, albumId, 'w-chloe', 'w-chloe2');
  const removePhoto = (user, fileId) =>
    call('DELETE', `/${GROUP}/albums/${albumId}/photos/${fileId}`, user);

  assert.strictEqual((await removePhoto(CHLOE, 'w-asha')).statusCode, 403, 'not hers');
  assert.strictEqual((await removePhoto(CHLOE, 'w-chloe')).statusCode, 204, 'her own');
  assert.deepStrictEqual(deletes.at(-1), { fileId: 'w-chloe', owner: CHLOE });
  assert.strictEqual((await removePhoto(BEN, 'w-asha')).statusCode, 204, 'the creator');
  assert.deepStrictEqual(deletes.at(-1), { fileId: 'w-asha', owner: ASHA }, 'deleted as its uploader');
  assert.strictEqual((await removePhoto(BEN, 'w-asha')).statusCode, 404);

  const rename = (user, fields) => call('PATCH', `/${GROUP}/albums/${albumId}`, user, fields);
  assert.strictEqual((await rename(CHLOE, { title: 'Mine' })).statusCode, 403);
  assert.strictEqual(body(await rename(BEN, { title: 'The wedding' })).title, 'The wedding');
  const renamed = body(await rename(ASHA, { date: '2026-12-01' }));
  assert.deepStrictEqual([renamed.title, renamed.date], ['The wedding', '2026-12-01'],
    'the group owner too');
  assert.strictEqual(body(await rename(BEN, { date: null })).date, null);

  assert.strictEqual((await call('DELETE', `/${GROUP}/albums/${albumId}`, CHLOE)).statusCode, 403);
  assert.strictEqual((await call('DELETE', `/${GROUP}/albums/${albumId}`, ASHA)).statusCode, 204);
  assert.deepStrictEqual(deletes.at(-1), { fileId: 'w-chloe2', owner: CHLOE });
  assert.strictEqual((await call('GET', `/${GROUP}/albums/${albumId}`, BEN)).statusCode, 404);
});

test('a 1:1 album: the two connected people only, never through a block', async () => {
  const dm = dmChannelId(ASHA, DEV);
  assert.strictEqual((await newAlbum(ASHA, dm)).statusCode, 403, 'the peer is needed');
  const created = await newAlbum(ASHA, dm, { peer: DEV });
  assert.strictEqual(created.statusCode, 201);
  const { albumId } = body(created);
  assert.strictEqual((await add(DEV, dm, albumId, 'dm-1')).statusCode, 200);
  assert.strictEqual((await albumsOf(DEV, dm, ASHA)).length, 1);
  assert.strictEqual((await call('GET', `/${dm}/albums`, DEV)).statusCode, 403, 'without the peer');

  // a third person names either of the two: not their chat
  const third = await Promise.all([
    call('GET', `/${dm}/albums?peer=${ASHA}`, EVA),
    call('GET', `/${dm}/albums?peer=${DEV}`, BEN),
    newAlbum(EVA, dm, { peer: DEV }),
    call('GET', `/${dm}/albums/${albumId}`, EVA),
    add(BEN, dm, albumId, 'dm-ben')
  ]);
  assert.deepStrictEqual(codes(third), Array(5).fill(403));

  // not connected: no album
  const strangers = dmChannelId(DEV, EVA);
  assert.strictEqual((await newAlbum(DEV, strangers, { peer: EVA })).statusCode, 403);

  // a block either way shuts the album for both, and lifting it opens it again
  await call('POST', '/blocks', DEV, { user_id: ASHA });
  const blocked = await Promise.all([
    call('GET', `/${dm}/albums/${albumId}`, ASHA),
    call('GET', `/${dm}/albums/${albumId}`, DEV),
    call('GET', `/${dm}/albums?peer=${DEV}`, ASHA),
    add(ASHA, dm, albumId, 'dm-2')
  ]);
  assert.deepStrictEqual(codes(blocked), [403, 403, 403, 403]);
  await call('DELETE', `/blocks/${ASHA}`, DEV);
  assert.strictEqual((await open(ASHA, dm, albumId)).photos.length, 1);
});

test('a removed member loses the group\'s albums', async () => {
  const { albumId } = body(await newAlbum(CHLOE, GROUP, { title: 'Picnic' }));
  await add(CHLOE, GROUP, albumId, 'picnic-1');
  const removed = await call('DELETE', `/${GROUP}/members/${CHLOE}`, ASHA, op(ASHA, 7));
  assert.strictEqual(removed.statusCode, 200);
  const after = await Promise.all([
    call('GET', `/${GROUP}/albums`, CHLOE),
    call('GET', `/${GROUP}/albums/${albumId}`, CHLOE),
    add(CHLOE, GROUP, albumId, 'picnic-2'),
    call('DELETE', `/${GROUP}/albums/${albumId}`, CHLOE)
  ]);
  assert.deepStrictEqual(codes(after), [403, 403, 403, 403]);
  assert.strictEqual((await open(BEN, GROUP, albumId)).photos.length, 1, 'her photos stay');
});

test('an album and its photos go after the retention', async () => {
  const dm = dmChannelId(ASHA, BEN);
  const { albumId, keptUntil } = body(await newAlbum(BEN, dm, { peer: ASHA, title: 'Old' }));
  await add(ASHA, dm, albumId, 'old-1');
  await harness.server.albums.sweepExpired(keptUntil - 1000);
  assert.strictEqual((await albumsOf(BEN, dm, ASHA)).length, 1, 'not yet');
  await harness.server.albums.sweepExpired(keptUntil + 1000);
  assert.strictEqual((await albumsOf(BEN, dm, ASHA)).length, 0);
  assert.deepStrictEqual(deletes.at(-1), { fileId: 'old-1', owner: ASHA });
  assert.strictEqual((await call('GET', `/${dm}/albums/${albumId}`, BEN)).statusCode, 404);
});

test('an album is full at 500 photos; creating is rate limited', async () => {
  const { albumId } = body(await newAlbum(ASHA, GROUP, { title: 'Full' }));
  const many = Array.from({ length: 499 }, (_, i) => ({
    fileId: `many-${i}`, width: 0, height: 0, uploader: ASHA, addedAt: Date.now()
  }));
  assert.ok(await harness.server.context.albumDb.addPhotos(albumId, many, 500));
  const full = await add(BEN, GROUP, albumId, 'one', 'two');
  assert.strictEqual(full.statusCode, 409);
  assert.strictEqual(body(full).error.code, 'album_full');
  assert.strictEqual((await add(BEN, GROUP, albumId, 'one')).statusCode, 200);

  const busy = '0f0f0f0f0';
  const own = '01efabcd-7000-8000-8abc-0000000a1b02';
  await call('POST', '/', busy, op(busy, 1, { channel_id: own, kind: 'group', name: 'Me', members: [busy] }));
  const results = [];
  for (let i = 0; i < 11; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await newAlbum(busy, own, { title: `${i}` }));
  }
  assert.deepStrictEqual(codes(results), [...Array(10).fill(201), 429]);
  // a retry of one made is still answered
  const retry = await call('POST', `/${own}/albums`, busy, {
    albumId: body(results[0]).albumId, title: '0'
  });
  assert.strictEqual(retry.statusCode, 200);
});

test('a deleted group takes its albums; a deleted account its photos and 1:1 albums', async () => {
  const group = '01efabcd-7000-8000-8abc-0000000a1b03';
  await call('POST', '/', BEN, op(BEN, 2, { channel_id: group, kind: 'group', name: 'Trip', members: [BEN] }));
  const { albumId } = body(await newAlbum(BEN, group, { title: 'Trip' }));
  await add(BEN, group, albumId, 'trip-1');
  assert.strictEqual((await call('DELETE', `/${group}`, BEN, op(BEN, 3))).statusCode, 204);
  assert.deepStrictEqual(deletes.at(-1), { fileId: 'trip-1', owner: BEN });
  assert.strictEqual(await harness.server.context.albumDb.getAlbum(albumId), null);

  const dm = dmChannelId(ASHA, DEV);
  const { albumId: dmAlbum } = body(await newAlbum(DEV, dm, { peer: ASHA, title: 'Us' }));
  await add(ASHA, dm, dmAlbum, 'us-asha');
  const groupAlbum = body(await newAlbum(BEN, GROUP, { title: 'Family' })).albumId;
  await add(BEN, GROUP, groupAlbum, 'ben-1');
  await add(ASHA, GROUP, groupAlbum, 'asha-1');

  const gone = deletes.length;
  const erased = await harness.inject({
    method: 'POST', url: '/_internal/members/remove', payload: { user_id: ASHA }
  });
  assert.strictEqual(erased.statusCode, 200);
  assert.strictEqual(await harness.server.context.albumDb.getAlbum(dmAlbum), null);
  const left = await harness.server.context.albumDb.getAlbum(groupAlbum);
  assert.deepStrictEqual(left.photos.map((p) => p.fileId), ['ben-1'], 'only her photos go');
  const fileIds = deletes.slice(gone).map((d) => d.fileId);
  assert.ok(fileIds.includes('us-asha') && fileIds.includes('asha-1'));
  assert.ok(!fileIds.includes('ben-1'));
});
