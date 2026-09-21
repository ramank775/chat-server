const test = require('node:test');
const assert = require('node:assert');
const { MediaMetadataMS } = require('../media-metadata-ms');
const s3 = require('../media-storage/s3-storage');

const OWNER = 'a1b2c3d4e';
const OTHER = 'f00ba4321';
const FILE_ID = '665f1b2c3d4e5f6071829304';

// ponytail: hand rolled stubs, the repo has no test framework and media-ms
// only talks to a metadata db and a storage backend.
function noop() { }
const log = { info: noop, error: noop, debug: noop };
const statsClient = { increment: noop, timing: noop };

function stubDb(record) {
  return {
    created: [],
    async createRecord(payload) {
      this.created.push(payload);
      return FILE_ID;
    },
    async getRecord() {
      return record;
    }
  };
}

function stubStorage() {
  return {
    signed: [],
    async getSignedUrl(payload) {
      this.signed.push(payload);
      return `https://s3.test/${payload.operation}/${payload.fileId}`;
    }
  };
}

async function buildService(db, storage) {
  const context = {
    options: {
      port: 0,
      host: '127.0.0.1',
      baseRoute: '',
      maxUploadSize: 1024 * 1024
    },
    log,
    statsClient,
    db,
    storage
  };
  const service = new MediaMetadataMS(context);
  await service.init();
  return service;
}

function authHeaders(user) {
  // The auth layer sets x-user/x-device; user/accesskey are kept until
  // helper/schema.js drops them.
  return {
    user,
    accesskey: 'test-accesskey',
    'x-user': user,
    'x-device': 'device-1'
  };
}

test('upload presign returns a url scoped to the caller and the declared size', async () => {
  const db = stubDb(null);
  const storage = stubStorage();
  const service = await buildService(db, storage);

  const res = await service.hapiServer.inject({
    method: 'GET',
    url: '/upload/presigned_url?ext=.png&category=avatar&size=2048',
    headers: authHeaders(OWNER)
  });

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.payload), {
    url: `https://s3.test/upload/${FILE_ID}`,
    fileId: FILE_ID
  });
  assert.strictEqual(db.created[0].owner, OWNER);
  assert.strictEqual(storage.signed[0].contentType, 'image/png');
  assert.strictEqual(storage.signed[0].contentLength, 2048);
});

test('upload presign refuses a size over the configured maximum', async () => {
  const db = stubDb(null);
  const storage = stubStorage();
  const service = await buildService(db, storage);

  const res = await service.hapiServer.inject({
    method: 'GET',
    url: '/upload/presigned_url?ext=.png&category=avatar&size=1048577',
    headers: authHeaders(OWNER)
  });

  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(db.created, []);
});

test('download presign returns a url for the caller own asset', async () => {
  const storage = stubStorage();
  const service = await buildService(
    stubDb({ owner: OWNER, category: 'avatar', contentType: 'image/jpeg' }),
    storage
  );

  const res = await service.hapiServer.inject({
    method: 'GET',
    url: `/download/${FILE_ID}/presigned_url`,
    headers: authHeaders(OWNER)
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.payload).url, `https://s3.test/download/${FILE_ID}`);
});

test('download presign refuses another user fileId', async () => {
  const storage = stubStorage();
  const service = await buildService(
    stubDb({ owner: OWNER, category: 'avatar', contentType: 'image/jpeg' }),
    storage
  );

  const res = await service.hapiServer.inject({
    method: 'GET',
    url: `/download/${FILE_ID}/presigned_url`,
    headers: authHeaders(OTHER)
  });

  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(storage.signed, []);
});

test('s3 upload url is bucket scoped and signs content type and length', async () => {
  const storage = new s3.Implementation({
    options: {
      baseUploadDir: 'uploads',
      s3AccessKeyId: 'access_key',
      s3SecretAccessKey: 'secret_access_key',
      s3Region: 'us-east-1',
      urlExpireTime: 600,
      s3BucketName: 'vartalap',
      s3Endpoint: 'http://localhost:9000',
      s3ForcePathStyle: true
    }
  });
  await storage.init();

  const url = await storage.getSignedUrl({
    operation: 'upload',
    fileId: FILE_ID,
    category: 'avatar',
    contentType: 'image/jpeg',
    contentLength: 2048
  });

  const parsed = new URL(url);
  assert.strictEqual(parsed.origin, 'http://localhost:9000');
  assert.strictEqual(parsed.pathname, `/vartalap/uploads/avatar/${FILE_ID}`);
  const signedHeaders = parsed.searchParams.get('X-Amz-SignedHeaders').split(';');
  assert.ok(signedHeaders.includes('content-type'), signedHeaders.join(','));
  assert.ok(signedHeaders.includes('content-length'), signedHeaders.join(','));
});
