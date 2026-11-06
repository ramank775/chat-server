const { initMongoClient } = require('../../../../libs/mongo-utils');

/** A stored document as the shared Post shape (see index.js). */
function toPost(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { postId: _id, ...rest, reactions: rest.reactions || {} };
}

/** Newest first, from after `before` on. */
function page(filter, before) {
  if (!before) return filter;
  return {
    ...filter,
    $or: [
      { createdAt: { $lt: before.createdAt } },
      { createdAt: before.createdAt, _id: { $lt: before.postId } }
    ]
  };
}

class MongoTimelineDB {
  /** @type {import('mongodb').MongoClient} */
  #client;

  /** @type {import('mongodb').Collection} */
  #posts;

  constructor(context) {
    this.#client = initMongoClient(context);
  }

  async init() {
    await this.#client.connect();
    this.#posts = this.#client.db().collection('timeline_posts');
    await this.#posts.createIndex({ audience: 1, createdAt: -1, _id: -1 });
    await this.#posts.createIndex({ author: 1, createdAt: -1, _id: -1 });
    await this.#posts.createIndex({ createdAt: 1 });
  }

  async insertPost({ postId, ...post }) {
    try {
      await this.#posts.insertOne({ _id: postId, ...post, reactions: {} });
      return true;
    } catch (error) {
      if (error.code === 11000) return false;
      throw error;
    }
  }

  async getPost(postId) {
    return toPost(await this.#posts.findOne({ _id: postId }));
  }

  async #list(filter, before, limit) {
    const docs = await this.#posts
      .find(page(filter, before))
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .toArray();
    return docs.map(toPost);
  }

  feed(userId, before, limit) {
    return this.#list({ audience: userId }, before, limit);
  }

  postsBy(author, before, limit) {
    return this.#list({ author }, before, limit);
  }

  async deletePost(postId, author) {
    return toPost(await this.#posts.findOneAndDelete({ _id: postId, author }));
  }

  async setReaction(postId, userId, emoji, at) {
    const change = emoji
      ? { $set: { [`reactions.${userId}`]: { emoji, at } } }
      : { $unset: { [`reactions.${userId}`]: '' } };
    const { matchedCount } = await this.#posts.updateOne({ _id: postId, audience: userId }, change);
    return matchedCount === 1;
  }

  async #take(filter, limit) {
    const docs = await this.#posts.find(filter).limit(limit).toArray();
    if (docs.length) await this.#posts.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
    return docs.map(toPost);
  }

  takeExpired(cutoff, limit) {
    return this.#take({ createdAt: { $lt: cutoff } }, limit);
  }

  deleteAllBy(author) {
    return this.#take({ author }, 0);
  }

  async dispose() {
    await this.#client.close();
  }
}

module.exports = { code: 'mongo', Implementation: MongoTimelineDB };
