const test = require('node:test');
const assert = require('node:assert');
const { MediaMetadataMS } = require('../media-metadata-ms');
const s3 = require('../media-storage/s3-storage');
const { getContentTypeByExt } = require('../../../libs/content-type-utils');

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

  const res = await service.server.inject({
    method: 'GET',
    url: '/upload/presigned_url?ext=jpg&category=avatar&size=2048',
    headers: authHeaders(OWNER)
  });

  assert.strictEqual(res.statusCode, 200);
  // contentType is what was signed: the client's PUT must send exactly it.
  assert.deepStrictEqual(JSON.parse(res.payload), {
    url: `https://s3.test/upload/${FILE_ID}`,
    fileId: FILE_ID,
    contentType: 'image/jpeg'
  });
  assert.strictEqual(db.created[0].owner, OWNER);
  assert.strictEqual(storage.signed[0].contentType, 'image/jpeg');
  assert.strictEqual(storage.signed[0].contentLength, 2048);
});

test('upload presign refuses a size over the configured maximum', async () => {
  const db = stubDb(null);
  const storage = stubStorage();
  const service = await buildService(db, storage);

  const res = await service.server.inject({
    method: 'GET',
    url: '/upload/presigned_url?ext=.png&category=avatar&size=1048577',
    headers: authHeaders(OWNER)
  });

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(JSON.parse(res.payload).error.code, 'validation_failed');
  assert.deepStrictEqual(db.created, []);
});

test('download presign returns a url for the caller own asset', async () => {
  const storage = stubStorage();
  const service = await buildService(
    stubDb({ owner: OWNER, category: 'avatar', contentType: 'image/jpeg' }),
    storage
  );

  const res = await service.server.inject({
    method: 'GET',
    url: `/download/${FILE_ID}/presigned_url`,
    headers: authHeaders(OWNER)
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.payload).url, `https://s3.test/download/${FILE_ID}`);
});

test('download presign works for any authenticated holder of the fileId', async () => {
  // The unguessable fileId is the capability, it only reaches users entitled
  // to the message or profile carrying it.
  const storage = stubStorage();
  const service = await buildService(
    stubDb({ owner: OWNER, category: 'avatar', contentType: 'image/jpeg' }),
    storage
  );

  const res = await service.server.inject({
    method: 'GET',
    url: `/download/${FILE_ID}/presigned_url`,
    headers: authHeaders(OTHER)
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.payload).url, `https://s3.test/download/${FILE_ID}`);
});

test('download presign 404s an unknown fileId', async () => {
  const storage = stubStorage();
  const service = await buildService(stubDb(null), storage);

  const res = await service.server.inject({
    method: 'GET',
    url: `/download/${FILE_ID}/presigned_url`,
    headers: authHeaders(OWNER)
  });

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(JSON.parse(res.payload).error.code, 'NOT_FOUND');
  assert.deepStrictEqual(storage.signed, []);
});

test('file status update stays scoped to the owner', async () => {
  const service = await buildService(
    stubDb({ owner: OWNER, category: 'avatar', contentType: 'image/jpeg' }),
    stubStorage()
  );

  const res = await service.server.inject({
    method: 'PUT',
    url: `/${FILE_ID}/status`,
    headers: authHeaders(OTHER),
    payload: { status: true }
  });

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(JSON.parse(res.payload).error.code, 'NOT_FOUND');
});

const MD5 = 'ab'.repeat(16);

test('a convergent upload reuses a stored copy: no url, no record (190)', async () => {
  const db = stubDb(null);
  db.reuseByMd5 = async (md5, category) => (md5 === MD5 && category === 'message'
    ? { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: true } : null);
  const storage = stubStorage();
  const service = await buildService(db, storage);
  const presign = (md5) => service.server.inject({
    method: 'GET',
    url: `/upload/presigned_url?ext=bin&category=message&size=99&md5=${md5}`,
    headers: authHeaders(OTHER)
  });

  const hit = await presign(MD5);
  assert.strictEqual(hit.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(hit.payload), { fileId: 'aaaaaaaaaaaaaaaaaaaaaaaa', existing: true });
  assert.deepStrictEqual([db.created, storage.signed], [[], []], 'nothing created or signed');

  const miss = await presign('cd'.repeat(16));
  assert.strictEqual(JSON.parse(miss.payload).fileId, FILE_ID);
  assert.strictEqual(db.created[0].md5, 'cd'.repeat(16));
  assert.strictEqual(storage.signed[0].contentMd5, Buffer.from('cd'.repeat(16), 'hex').toString('base64'),
    'the store will check the bytes against it');
  assert.strictEqual((await presign('not-a-hash')).statusCode, 400);
});

test('a file someone may reuse is only complete once it was stored (190)', async () => {
  const record = { owner: OWNER, category: 'message', contentType: 'application/octet-stream', md5: MD5 };
  const db = stubDb(record);
  const marked = [];
  db.updateFileStatus = async (fileId, status) => { marked.push(status); };
  const storage = stubStorage();
  let stored = false;
  storage.exists = async () => stored;
  const service = await buildService(db, storage);
  const complete = () => service.server.inject({
    method: 'PUT', url: `/${FILE_ID}/status`, headers: authHeaders(OWNER), payload: { status: true }
  });

  const early = await complete();
  assert.strictEqual(early.statusCode, 409);
  assert.strictEqual(JSON.parse(early.payload).error.code, 'NOT_UPLOADED');
  assert.deepStrictEqual(marked, [], 'never indexed without the object');

  stored = true;
  assert.strictEqual((await complete()).statusCode, 200);
  assert.deepStrictEqual(marked, [true]);
});

test('content type lookup resolves every extension a record names', async () => {
  // ".jpeg, .jpg" is one mapping record naming two extensions, and callers
  // pass the extension with or without the leading dot.
  assert.strictEqual(getContentTypeByExt('jpg'), 'image/jpeg');
  assert.strictEqual(getContentTypeByExt('.jpg'), 'image/jpeg');
  assert.strictEqual(getContentTypeByExt('.jpeg'), 'image/jpeg');
  assert.strictEqual(getContentTypeByExt('PNG'), 'image/png');
  // a record dedicated to one extension beats an earlier multi extension one
  assert.strictEqual(getContentTypeByExt('xml'), 'application/xml');
  assert.strictEqual(getContentTypeByExt('nosuchext'), 'application/octet-stream');
  // What phones record and shoot.
  assert.strictEqual(getContentTypeByExt('m4a'), 'audio/mp4');
  assert.strictEqual(getContentTypeByExt('opus'), 'audio/ogg');
  assert.strictEqual(getContentTypeByExt('mov'), 'video/quicktime');
  assert.strictEqual(getContentTypeByExt('heic'), 'image/heic');
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
  // A checksum signed before the bytes exist is the empty body's: S3 rejects the upload.
  const checksums = [...parsed.searchParams.keys()].filter((k) => /checksum/i.test(k));
  assert.deepStrictEqual(checksums, []);
});

test('s3 upload url signs a given Content-MD5 (190)', async () => {
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
  const url = new URL(await storage.getSignedUrl({
    operation: 'upload',
    fileId: FILE_ID,
    category: 'message',
    contentType: 'application/octet-stream',
    contentLength: 99,
    contentMd5: Buffer.from(MD5, 'hex').toString('base64')
  }));
  assert.ok(url.searchParams.get('X-Amz-SignedHeaders').split(';').includes('content-md5'));
});
