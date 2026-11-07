const { IChannelDB } = require('./channel-db');
const mongodb = require('./mongo-channel-db')
const pg = require('./pg-channel-db')
const mongoAlbums = require('./mongo-album-db');
const pgAlbums = require('./pg-album-db');

const DATABASE_IMPL = [
  mongodb,
  pg
]

/**
 * Add command line options for database store
 * @param {import('commander').Command} cmd
 * @returns {import('commander').Command}
 */
function addOptions(cmd) {
  cmd = cmd.option('--channel-db <channel-db>', 'Which database implementation to use (mongo, pg)', 'mongo');
  DATABASE_IMPL.forEach(impl => {
    cmd = impl.addOptions(cmd)
  })
  return cmd;
}

/**
 * @private
 * Get the database implementation as per the context options
 * @param {{options: {channelDb: string}}} context
 * @returns
 */
function getDatabaseImpl(context) {
  const {
    options: { channelDb }
  } = context;
  const store = DATABASE_IMPL.find((s) => s.code === channelDb);
  if (!store) {
    throw new Error(`${channelDb} is not a registered database implementation for Channel database`);
  }
  return store;
}

/**
 * Occasion albums (decision 233), on the `--channel-db` backend: albums
 * belong to chats. Both stores answer the same calls with the same objects:
 *
 * Album `{albumId, channelId, members: [user_id, user_id] (a 1:1's pair) |
 *   null (a group's), creator, title, date: 'YYYY-MM-DD' | null,
 *   createdAt: Date, keptUntil: Date | null,
 *   photos: [{fileId, width, height, uploader, addedAt (ms)}] (oldest first)}`.
 *
 * - `insertAlbum(album)` -> false when `albumId` exists already
 * - `getAlbum(albumId)` -> Album | null
 * - `listAlbums(channelId, now)` -> the chat's albums not expired by `now`,
 *   newest first, with `photoCount` and `cover` (the newest photo) in place
 *   of `photos`
 * - `countAlbums(channelId)`
 * - `updateAlbum(albumId, {title?, date?})` -> the Album after
 * - `deleteAlbum(albumId)` -> the deleted Album, or null
 * - `addPhotos(albumId, photos, max)` -> false when that would pass `max`
 * - `removePhoto(albumId, fileId)`
 * - `takeExpired(now, limit)`, `takeChat(channelId)`, `takeMember(userId)`
 *   -> albums expired / of a chat / of a 1:1 with `userId`, deleted
 * - `takePhotosBy(uploader)` -> `uploader`'s photos, taken out of every album
 */
async function initialize(context) {
  const impl = getDatabaseImpl(context)
  const db = new impl.Implementation(context);
  await db.init();
  context.channelDb = db;
  const albums = [mongoAlbums, pgAlbums].find((s) => s.code === impl.code);
  context.albumDb = new albums.Implementation(context);
  await context.albumDb.init();
  return context;
}


module.exports = {
  IChannelDB,
  addDatabaseOptions: addOptions,
  initializeDatabase: initialize
}
