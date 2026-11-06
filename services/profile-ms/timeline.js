const Joi = require('joi');
const { AuthError } = require('./auth-provider');
const { errorEnvelope } = require('../../helper');

/**
 * Decision 223's private timeline, over REST and not end-to-end encrypted
 * (owner, 2026-11-06): a post goes to the audience its phone names, user
 * ids the phone resolves from its own labels (the server never sees a
 * label). Only that audience reads a post or reacts to it; only the poster
 * sees who reacted, and nobody gets a count; only the poster deletes. New
 * posts wake nobody: the app refreshes its feed when it opens.
 *
 * Here and not in a service of its own: posts belong to users, the routes
 * share profile-ms' auth, rate limiting and media-ms client, and nothing
 * needs a new deployment unit.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 100;
const PAGE = 50;
const MAX_PAGE = 100;
const MAX_TEXT = 2000;
const MAX_PHOTOS = 10;
const MAX_AUDIENCE = 256;
const MAX_EMOJI = 16;

const userId = Joi.string().pattern(/^[0-9a-f]{9}$/);
const postParams = Joi.object({ postId: Joi.string().uuid().required() });
/** `<createdAt ms>_<postId>`: the last post of the page before. */
const CURSOR = /^(\d{1,15})_([0-9a-f-]{36})$/;
const pageQuery = Joi.object({
  before: Joi.string().pattern(CURSOR),
  limit: Joi.number().integer().min(1).max(MAX_PAGE).default(PAGE)
});

function addTimelineOptions(cmd) {
  return cmd
    .option(
      '--timeline-retention-days <days>',
      'Delete a timeline post, and its photos, this many days after it was posted',
      (c) => Number(c),
      30
    )
    .option('--timeline-post-hour <count>', 'Timeline posts per user per hour', (c) => Number(c), 10)
    .option('--timeline-post-day <count>', 'Timeline posts per user per day', (c) => Number(c), 30);
}

function cursorOf(post) {
  return `${post.createdAt.getTime()}_${post.postId}`;
}

function parseCursor(before) {
  if (!before) return null;
  const [, ms, postId] = before.match(CURSOR);
  return { createdAt: new Date(Number(ms)), postId };
}

/** Everyone but the poster sees this much: no audience, no one else's reaction. */
function viewerPost(post, viewer) {
  return {
    postId: post.postId,
    author: post.author,
    text: post.text || null,
    photos: post.photos,
    createdAt: post.createdAt.getTime(),
    myReaction: post.reactions[viewer]?.emoji || null
  };
}

function reactionList(post) {
  return Object.entries(post.reactions)
    .map(([user, { emoji, at }]) => ({ userId: user, emoji, at }))
    .sort((a, b) => a.at - b.at);
}

/** The poster's own view: who it went to and who reacted. */
function ownPost(post) {
  return {
    postId: post.postId,
    author: post.author,
    text: post.text || null,
    photos: post.photos,
    createdAt: post.createdAt.getTime(),
    audience: post.audience,
    reactions: reactionList(post)
  };
}

function page(posts, limit, view) {
  return {
    posts: posts.map(view),
    next: posts.length === limit ? cursorOf(posts[posts.length - 1]) : null
  };
}

class Timeline {
  /** @param {import('./profile-ms').ProfileMs} service */
  constructor(service) {
    this.service = service;
    this.db = service.context.timelineDB;
    this.options = service.options;
  }

  addRoutes() {
    const s = this.service;
    const route = (path, method, handler, validate) =>
      s.addRoute(path, method, s.guard(handler.bind(this)), {
        pre: [s.authPre()],
        validate
      });

    route('/timeline/posts', 'POST', this.createPost, {
      payload: Joi.object({
        postId: Joi.string().uuid().required(),
        text: Joi.string().trim().max(MAX_TEXT).allow('', null),
        photos: Joi.array()
          .items(
            Joi.object({
              fileId: Joi.string().max(128).required(),
              width: Joi.number().integer().min(0).max(100000).default(0),
              height: Joi.number().integer().min(0).max(100000).default(0)
            })
          )
          .max(MAX_PHOTOS)
          .default([]),
        audience: Joi.array().items(userId).min(1).max(MAX_AUDIENCE).unique().required()
      }).required()
    });
    route('/timeline/feed', 'GET', this.feed, { query: pageQuery });
    route('/timeline/posts/mine', 'GET', this.mine, { query: pageQuery });
    route('/timeline/posts/{postId}', 'DELETE', this.deletePost, { params: postParams });
    route('/timeline/posts/{postId}/reaction', 'PUT', this.react, {
      params: postParams,
      payload: Joi.object({ emoji: Joi.string().max(MAX_EMOJI).required() }).required()
    });
    route('/timeline/posts/{postId}/reaction', 'DELETE', this.react, { params: postParams });
    route('/timeline/posts/{postId}/reactions', 'GET', this.reactions, { params: postParams });

    if (this.options.timelineRetentionDays > 0) {
      this.sweepTimer = setInterval(() => {
        this.sweepExpired().catch((error) =>
          s.log.error(`Timeline sweep failed: ${error.message}`));
      }, SWEEP_EVERY_MS).unref();
    }
  }

  stop() {
    clearInterval(this.sweepTimer);
  }

  /**
   * Of `users`, the ones `poster` may share with. Decision 219: people they
   * are connected to, with no block either way (channel-ms keeps both).
   */
  async connectedTo(poster, users) {
    const { connected } = await this.service.channelClient.post(
      '/_internal/connections/pairs', { user_id: poster, users }
    );
    return connected;
  }

  async createPost(req, res) {
    const { user } = req.pre.auth;
    const { postId, text, photos, audience } = req.payload;
    if (!text && !photos.length) {
      return res.response(errorEnvelope('EMPTY_POST', 'A post needs text or a photo')).code(400);
    }
    // a retry of a post that went in is answered, not counted again
    const existing = await this.db.getPost(postId);
    if (existing) {
      if (existing.author !== user.user_id) {
        return res.response(errorEnvelope('POST_EXISTS', 'That post id is taken')).code(409);
      }
      return ownPost(existing);
    }
    const { timelinePostHour, timelinePostDay } = this.options;
    await this.service.rateLimit(`timeline:post:${user.user_id}:h`, timelinePostHour, 3600, 'user');
    await this.service.rateLimit(`timeline:post:${user.user_id}:d`, timelinePostDay, 86400, 'user');
    const reach = await this.connectedTo(user.user_id, audience);
    if (!reach.length) {
      throw new AuthError(403, 'NOT_CONNECTED', 'None of the audience is connected to you');
    }
    const post = {
      postId,
      author: user.user_id,
      text: text || null,
      photos,
      audience: reach,
      createdAt: new Date()
    };
    // two retries racing: the loser reads what the winner stored
    if (!(await this.db.insertPost(post))) return ownPost(await this.db.getPost(postId));
    return res.response(ownPost({ ...post, reactions: {} })).code(201);
  }

  async feed(req) {
    const { limit, before } = req.query;
    const viewer = req.pre.auth.user.user_id;
    const posts = await this.db.feed(viewer, parseCursor(before), limit);
    return page(posts, limit, (post) => viewerPost(post, viewer));
  }

  async mine(req) {
    const { limit, before } = req.query;
    const posts = await this.db.postsBy(req.pre.auth.user.user_id, parseCursor(before), limit);
    return page(posts, limit, ownPost);
  }

  async deletePost(req, res) {
    const post = await this.db.deletePost(req.params.postId, req.pre.auth.user.user_id);
    if (!post) return res.response(errorEnvelope('POST_NOT_FOUND', 'No such post of yours')).code(404);
    await this.deletePhotos([post]);
    return res.response().code(204);
  }

  /** PUT sets the caller's one reaction, DELETE takes it back. */
  async react(req, res) {
    const emoji = req.method === 'PUT' ? req.payload.emoji : null;
    const ok = await this.db.setReaction(
      req.params.postId,
      req.pre.auth.user.user_id,
      emoji,
      Date.now()
    );
    // the poster is not in their own audience; a stranger learns nothing
    if (!ok) return res.response(errorEnvelope('POST_NOT_FOUND', 'No such post')).code(404);
    return res.response().code(204);
  }

  async reactions(req, res) {
    const post = await this.db.getPost(req.params.postId);
    if (!post || post.author !== req.pre.auth.user.user_id) {
      return res.response(errorEnvelope('POST_NOT_FOUND', 'No such post of yours')).code(404);
    }
    return { reactions: reactionList(post) };
  }

  /** Posts past retention go, photos with them. A failed photo delete is logged. */
  async sweepExpired(now = Date.now()) {
    const cutoff = new Date(now - this.options.timelineRetentionDays * DAY_MS);
    const batch = await this.db.takeExpired(cutoff, SWEEP_BATCH);
    await this.deletePhotos(batch);
    if (batch.length === SWEEP_BATCH) await this.sweepExpired(now);
  }

  /**
   * AUTH_CONTRACT 8.2: an account's posts go with it. Best effort, like the
   * account's other side stores: what is left expires with the retention.
   */
  async eraseAuthor(author) {
    try {
      await this.deletePhotos(await this.db.deleteAllBy(author));
    } catch (error) {
      this.service.log.error(`Timeline erase failed for ${author}: ${error.message}`);
    }
  }

  /** media-ms deletes a file only for its uploader: the poster. Best effort. */
  async deletePhotos(posts) {
    const deletes = posts.flatMap((post) =>
      post.photos.map(({ fileId }) =>
        this.service.mediaClient
          .post('/_internal/files/delete', { fileId, owner: post.author })
          .catch((error) =>
            this.service.log.error(`Timeline photo delete failed: ${error.message}`))));
    await Promise.all(deletes);
  }
}

module.exports = { Timeline, addTimelineOptions };
