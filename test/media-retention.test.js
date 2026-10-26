const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { MediaMetadataMS, parseOptions } = require('../services/media-ms/media-metadata-ms');
const Database = require('../services/media-ms/database');
const { TEST_DB, mongoUrlFor, freshPgDatabase, dropPgDatabase, dbFlags } = require('./helpers/db');

const DB_NAME = 'media_ms_test_retention';
const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = 'a1b2c3d4e';
const OTHER = 'f00ba4321';
const noop = () => { };

/** @type {MediaMetadataMS} */
let service;
let failDeletes = false;
const deleted = [];

before(async () => {
  if (TEST_DB === 'pg') {
    await freshPgDatabase(DB_NAME);
  } else {
    const client = new MongoClient(mongoUrlFor(DB_NAME), { auth: null });
    await client.connect();
    await client.db().dropDatabase();
    await client.close();
  }
  const options = parseOptions([
    'node', 'media-ms', '--log-level=error', ...dbFlags(DB_NAME, ['media-metadata-db'])
  ]);
  const context = await Database.initialize({ options });
  service = new MediaMetadataMS({
    ...context,
    // no timer: the test runs the sweep itself
    options: { ...options, port: 0, host: '127.0.0.1', mediaTtlDays: 0 },
    log: { info: noop, error: noop, debug: noop },
    statsClient: { increment: noop, timing: noop },
    storage: {
      async getSignedUrl(file) {
        return `https://s3.test/${file.fileId}`;
      },
      async delete(file) {
        if (failDeletes) throw new Error('store down');
        deleted.push(file);
      }
    }
  });
  await service.init();
  service.options.mediaTtlDays = 30;
});

after(async () => {
  await service?.shutdown();
  if (TEST_DB === 'pg') await dropPgDatabase(DB_NAME);
});

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const md5 = (c) => c.repeat(32);
async function stored(md5Hex, category = 'message') {
  const fileId = await service.db.createRecord({
    category, owner: OWNER, contentType: 'application/octet-stream', md5: md5Hex
  });
  await service.db.updateFileStatus(fileId, true);
  return fileId;
}
const presign = (md5Hex) => service.server.inject({
  method: 'GET',
  url: `/upload/presigned_url?ext=bin&category=message&size=9&md5=${md5Hex}`,
  headers: { user: OTHER, accesskey: 'k', 'x-user': OTHER, 'x-device': 'd' }
}).then((res) => res.json());

test('a message file goes 30 days after it was last sent, retried until its object is gone', async () => {
  const old = await stored(md5('a'));
  const resent = await stored(md5('b'));
  const photo = await stored(md5('c'), 'profile');
  await sleep(10);
  const cutoff = Date.now();
  await sleep(10);
  assert.equal((await presign(md5('b'))).fileId, resent, 'sent again: the clock restarts');
  const fresh = await stored(md5('d'));
  const sweep = () => service.sweepExpired(cutoff + 30 * DAY_MS);

  failDeletes = true;
  await assert.rejects(sweep());
  assert.ok(await service.db.getRecord(old), 'kept while its object is not deleted');
  assert.notEqual((await presign(md5('a'))).fileId, old, 'but never reused once expiring');

  failDeletes = false;
  await sweep();
  assert.deepEqual(deleted, [{ fileId: old, category: 'message' }]);
  assert.equal(await service.db.getRecord(old), null);
  const kept = await Promise.all([resent, photo, fresh].map((id) => service.db.getRecord(id)));
  kept.forEach((record) => assert.ok(record));
});

test('the internal delete removes only the named owner\'s file', async () => {
  const photo = await stored(md5('e'), 'profile');
  const remove = (owner) => service.server.inject({
    method: 'POST', url: '/_internal/files/delete', payload: { fileId: photo, owner }
  }).then((res) => res.json());

  assert.deepEqual(await remove(OTHER), { deleted: false });
  assert.ok(await service.db.getRecord(photo));
  assert.deepEqual(await remove(OWNER), { deleted: true });
  assert.equal(await service.db.getRecord(photo), null);
  assert.deepEqual(deleted.at(-1), { fileId: photo, category: 'profile' });
});
