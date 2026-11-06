const mongo = require('./mongo-timeline-db');
const pg = require('./pg-timeline-db');

/**
 * Decision 223's private timeline: a post, on the backend `--profile-db`
 * picks (posts live next to their authors). Both stores answer the same
 * calls with the same objects:
 *
 * Post `{postId, author, text, photos: [{fileId, width, height}],
 *   audience: [user_id], reactions: {user_id: {emoji, at}}, createdAt: Date}`.
 *
 * - `insertPost(post)` -> false when `postId` exists already
 * - `getPost(postId)` -> Post | null
 * - `feed(userId, before, limit)` -> the posts whose audience has `userId`
 * - `postsBy(author, before, limit)` -> `author`'s own posts
 *   (both newest first, `before` an optional `{createdAt, postId}` cursor)
 * - `deletePost(postId, author)` -> the deleted Post, or null
 * - `setReaction(postId, userId, emoji|null, at)` -> false unless `userId`
 *   is in the post's audience
 * - `takeExpired(cutoff, limit)` -> posts made before `cutoff`, deleted
 * - `deleteAllBy(author)` -> every post of `author`, deleted
 */
const IMPLEMENTATIONS = [mongo, pg];

async function initialize(context) {
  const { profileDb } = context.options;
  const impl = IMPLEMENTATIONS.find((s) => s.code === profileDb);
  if (!impl) throw new Error(`${profileDb} is not a registered timeline database`);
  const db = new impl.Implementation(context);
  await db.init();
  context.timelineDB = db;
  return context;
}

module.exports = { initialize };
