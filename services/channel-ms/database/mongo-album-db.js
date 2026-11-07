const { initMongoClient } = require('../../../libs/mongo-utils');

/** What a list shows of an album: no photos, their count and the newest. */
const SUMMARY = {
  channelId: 1,
  members: 1,
  creator: 1,
  title: 1,
  date: 1,
  createdAt: 1,
  keptUntil: 1,
  photoCount: { $size: '$photos' },
  cover: { $arrayElemAt: ['$photos', -1] }
};

function toAlbum(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { albumId: _id, ...rest };
}

/** Occasion albums (decision 233), photos inside their album; see index.js. */
class MongoAlbumDB {
  /** @type {import('mongodb').MongoClient} */
  #client;

  /** @type {import('mongodb').Collection} */
  #albums;

  constructor(context) {
    this.#client = initMongoClient(context);
  }

  async init() {
    await this.#client.connect();
    this.#albums = this.#client.db().collection('albums');
    await this.#albums.createIndex({ channelId: 1, createdAt: -1 });
    await this.#albums.createIndex({ keptUntil: 1 });
    await this.#albums.createIndex({ members: 1 }, { sparse: true });
    await this.#albums.createIndex({ 'photos.uploader': 1 });
  }

  async insertAlbum({ albumId, ...album }) {
    try {
      await this.#albums.insertOne({ _id: albumId, ...album });
      return true;
    } catch (error) {
      if (error.code === 11000) return false;
      throw error;
    }
  }

  async getAlbum(albumId) {
    return toAlbum(await this.#albums.findOne({ _id: albumId }));
  }

  async listAlbums(channelId, now) {
    const docs = await this.#albums
      .find(
        { channelId, $or: [{ keptUntil: null }, { keptUntil: { $gt: now } }] },
        { projection: SUMMARY }
      )
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    return docs.map(toAlbum);
  }

  countAlbums(channelId) {
    return this.#albums.countDocuments({ channelId });
  }

  async updateAlbum(albumId, changes) {
    return toAlbum(await this.#albums.findOneAndUpdate(
      { _id: albumId },
      { $set: changes },
      { returnDocument: 'after' }
    ));
  }

  async deleteAlbum(albumId) {
    return toAlbum(await this.#albums.findOneAndDelete({ _id: albumId }));
  }

  async addPhotos(albumId, photos, max) {
    // the size check and the push are one write: two adds racing cannot pass the cap
    const { matchedCount } = await this.#albums.updateOne(
      { _id: albumId, $expr: { $lte: [{ $add: [{ $size: '$photos' }, photos.length] }, max] } },
      { $push: { photos: { $each: photos } } }
    );
    return matchedCount === 1;
  }

  async removePhoto(albumId, fileId) {
    await this.#albums.updateOne({ _id: albumId }, { $pull: { photos: { fileId } } });
  }

  async #take(filter, limit = 0) {
    const docs = await this.#albums.find(filter).limit(limit).toArray();
    if (docs.length) await this.#albums.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
    return docs.map(toAlbum);
  }

  takeExpired(now, limit) {
    return this.#take({ keptUntil: { $lt: now } }, limit);
  }

  takeChat(channelId) {
    return this.#take({ channelId });
  }

  takeMember(userId) {
    return this.#take({ members: userId });
  }

  async takePhotosBy(uploader) {
    const docs = await this.#albums
      .find({ 'photos.uploader': uploader }, { projection: { photos: 1 } })
      .toArray();
    if (!docs.length) return [];
    await this.#albums.updateMany(
      { 'photos.uploader': uploader },
      { $pull: { photos: { uploader } } }
    );
    return docs.flatMap((d) => d.photos.filter((p) => p.uploader === uploader));
  }

  async dispose() {
    await this.#client.close();
  }
}

module.exports = { code: 'mongo', Implementation: MongoAlbumDB };
