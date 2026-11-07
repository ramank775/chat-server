const Joi = require('joi');
const { extractInfoFromRequest, schemas, errorEnvelope } = require('../../helper');
const { dmChannelId } = require('../../libs/v3-envelope');

/**
 * Occasion albums (PRODUCT_DIRECTION "Sharing", decision 233): a chat's
 * photos of an event, over REST and not end-to-end encrypted, like the
 * timeline (224). An album belongs to one chat and only that chat sees it:
 * a group's current members, or the two people of a 1:1 while they are
 * connected with no block either way (219). Anyone in the chat adds
 * photos; a photo's uploader, the album's creator or a group's owner or
 * admin removes one; the creator or a group's owner or admin renames or
 * deletes the album. An album goes with its photos --album-retention-days
 * after it was made (the free tier: permanent albums may become a paid
 * extra), with its group, and a 1:1's with either account. Nobody is
 * woken: the app reads albums when chat info or an album opens.
 *
 * Here because chat membership, connections and blocks live here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 100;
/** Live albums one chat may have: the list is never paged. */
const MAX_ALBUMS = 100;
const MAX_PHOTOS = 500;
const MAX_ADD = 50;
const PAGE = 60;
const MAX_PAGE = 200;
const MAX_TITLE = 100;
/** Per user: albums made, photos added. */
const CREATE_HOUR = 10;
const CREATE_DAY = 30;
const PHOTOS_HOUR = 300;
const PHOTOS_DAY = 1000;

/** A derived DM id (TRIM_4_12_CONTRACT §1); a group's is a dashed UUID. */
const DM_ID = /^d[0-9a-f]{31}$/;
const USER_ID = Joi.string().pattern(/^[0-9a-f]{9}$/);
/** `<addedAt ms>_<fileId>`: the last photo of the page before. */
const CURSOR = /^(\d{1,15})_(.{1,128})$/;
const DATE = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null);
const TITLE = Joi.string().trim().min(1).max(MAX_TITLE);
const PHOTO = Joi.object({
  fileId: Joi.string().max(128).required(),
  width: Joi.number().integer().min(0).max(100000).default(0),
  height: Joi.number().integer().min(0).max(100000).default(0)
});

const chatParams = Joi.object({ channelId: Joi.string().required() });
const albumParams = Joi.object({
  channelId: Joi.string().required(),
  albumId: Joi.string().uuid().required()
});

function addAlbumOptions(cmd) {
  return cmd
    .option(
      '--album-retention-days <days>',
      'Delete an album, and its photos, this many days after it was made (0 = keep forever)',
      (c) => Number(c),
      90
    );
}

function photoView({ fileId, width, height, uploader, addedAt }) {
  return { fileId, width, height, uploader, addedAt };
}

function albumView(album) {
  const cover = album.photos ? album.photos[album.photos.length - 1] : album.cover;
  return {
    albumId: album.albumId,
    channelId: album.channelId,
    title: album.title,
    date: album.date || null,
    creator: album.creator,
    createdAt: album.createdAt.getTime(),
    keptUntil: album.keptUntil ? album.keptUntil.getTime() : null,
    photoCount: album.photos ? album.photos.length : album.photoCount,
    cover: cover ? photoView(cover) : null
  };
}

function notFound(res) {
  return res.response(errorEnvelope('not_found', 'No such album')).code(404);
}

function forbidden(res) {
  return res.response(errorEnvelope('forbidden', 'Not allowed in this chat')).code(403);
}

function rateLimited(res) {
  return res.response(errorEnvelope('rate_limited', 'Too many requests. Try again later.'))
    .code(429);
}

const isAdmin = (role) => role === 'owner' || role === 'admin';

class Albums {
  /** @param {import('./channel-ms').ChannelMs} service */
  constructor(service) {
    this.service = service;
    /** @type {import('./database/mongo-album-db').Implementation} */
    this.db = service.context.albumDb;
    this.options = service.options;
  }

  addRoutes() {
    const s = this.service;
    const route = (path, method, handler, validate) =>
      s.addRoute(path, method, handler.bind(this), {
        validate: { headers: schemas.authHeaders, ...validate }
      });

    route('/{channelId}/albums', 'GET', this.list, {
      params: chatParams,
      query: Joi.object({ peer: USER_ID })
    });
    route('/{channelId}/albums', 'POST', this.create, {
      params: chatParams,
      payload: Joi.object({
        albumId: Joi.string().uuid().required(),
        title: TITLE.required(),
        date: DATE,
        peer: USER_ID
      }).required()
    });
    route('/{channelId}/albums/{albumId}', 'GET', this.get, {
      params: albumParams,
      query: Joi.object({
        order: Joi.string().valid('newest', 'oldest').default('newest'),
        cursor: Joi.string().pattern(CURSOR),
        limit: Joi.number().integer().min(1).max(MAX_PAGE).default(PAGE)
      })
    });
    route('/{channelId}/albums/{albumId}', 'PATCH', this.edit, {
      params: albumParams,
      payload: Joi.object({ title: TITLE, date: DATE }).or('title', 'date').required()
    });
    route('/{channelId}/albums/{albumId}', 'DELETE', this.remove, { params: albumParams });
    route('/{channelId}/albums/{albumId}/photos', 'POST', this.addPhotos, {
      params: albumParams,
      payload: Joi.object({
        photos: Joi.array().items(PHOTO).min(1).max(MAX_ADD).required()
      }).required()
    });
    route('/{channelId}/albums/{albumId}/photos/{fileId}', 'DELETE', this.removePhoto, {
      params: albumParams.keys({ fileId: Joi.string().max(128).required() })
    });

    if (this.options.albumRetentionDays > 0) {
      this.sweepTimer = setInterval(() => {
        this.sweepExpired().catch((error) => s.log.error(`Album sweep failed: ${error.message}`));
      }, SWEEP_EVERY_MS).unref();
    }
  }

  stop() {
    clearInterval(this.sweepTimer);
  }

  /**
   * May `user` see `channelId`'s albums? Its role in the chat if so, else
   * null. A group: a current member. A 1:1: one of its two (`peer` the
   * other), connected, no block either way.
   */
  async chatRole(user, channelId, peer) {
    const { channelDb } = this.service.context;
    if (!DM_ID.test(channelId)) {
      const channel = await channelDb.getChannelInfo(channelId, user);
      return channel?.members.find((m) => m.user_id === user)?.role || null;
    }
    if (!peer || peer === user || dmChannelId(user, peer) !== channelId) return null;
    const pair = await channelDb.pair(user, peer);
    return pair.connected && !pair.aBlockedB && !pair.bBlockedA ? 'member' : null;
  }

  /**
   * The album the route names and the caller's role in its chat, or the
   * response refusing them: `not_found` for no such album in that chat
   * (or one past its keep date), `forbidden` for no access to the chat.
   */
  async open(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId, albumId } = req.params;
    const album = await this.db.getAlbum(albumId);
    if (!album || album.channelId !== channelId || (album.keptUntil && album.keptUntil <= new Date())) {
      return { refused: notFound(res) };
    }
    const peer = album.members?.find((m) => m !== user);
    const role = !album.members || album.members.includes(user)
      ? await this.chatRole(user, channelId, peer)
      : null;
    if (!role) return { refused: forbidden(res) };
    return { user, album, role };
  }

  /** Spend `units` of a per-user budget; true once it is gone. */
  async overBudget(key, units, limit, windowSec) {
    return (await this.service.memCache.incr(key, windowSec, units)) > limit;
  }

  /** `GET /{channelId}/albums[?peer=]`: the chat's albums, newest first. */
  async list(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId } = req.params;
    if (!(await this.chatRole(user, channelId, req.query.peer))) return forbidden(res);
    const albums = await this.db.listAlbums(channelId, new Date());
    return { albums: albums.map(albumView) };
  }

  /** `POST /{channelId}/albums {albumId, title, date?, peer?}`; a retry answers the album. */
  async create(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId } = req.params;
    const { albumId, title, date, peer } = req.payload;
    if (!(await this.chatRole(user, channelId, peer))) return forbidden(res);
    const existing = await this.db.getAlbum(albumId);
    if (existing) {
      if (existing.creator !== user || existing.channelId !== channelId) {
        return res.response(errorEnvelope('album_exists', 'That album id is taken')).code(409);
      }
      return albumView(existing);
    }
    if (await this.db.countAlbums(channelId) >= MAX_ALBUMS) {
      return res.response(errorEnvelope('album_limit', `A chat keeps at most ${MAX_ALBUMS} albums`))
        .code(409);
    }
    if (await this.overBudget(`album:create:${user}:h`, 1, CREATE_HOUR, 3600)
      || await this.overBudget(`album:create:${user}:d`, 1, CREATE_DAY, 86400)) {
      return rateLimited(res);
    }
    const now = Date.now();
    const days = this.options.albumRetentionDays;
    const album = {
      albumId,
      channelId,
      members: DM_ID.test(channelId) ? [user, peer].sort() : null,
      creator: user,
      title,
      date: date || null,
      createdAt: new Date(now),
      keptUntil: days > 0 ? new Date(now + days * DAY_MS) : null,
      photos: []
    };
    // two retries racing: the loser answers what the winner stored
    if (!(await this.db.insertAlbum(album))) return albumView(await this.db.getAlbum(albumId));
    return res.response(albumView(album)).code(201);
  }

  /**
   * `GET /{channelId}/albums/{albumId}?order=&cursor=&limit=`: the album
   * and a page of its photos, newest or oldest first; `next` is the
   * `cursor` of the page after, null on the last.
   */
  async get(req, res) {
    const { album, refused } = await this.open(req, res);
    if (refused) return refused;
    const { order, cursor, limit } = req.query;
    const sign = order === 'newest' ? -1 : 1;
    const compare = (a, b) => sign * (a.addedAt - b.addedAt || a.fileId.localeCompare(b.fileId));
    let photos = [...album.photos].sort(compare);
    if (cursor) {
      const [, ms, fileId] = cursor.match(CURSOR);
      const from = { addedAt: Number(ms), fileId };
      photos = photos.filter((p) => compare(p, from) > 0);
    }
    const pageOf = photos.slice(0, limit);
    const last = pageOf[pageOf.length - 1];
    return {
      album: albumView(album),
      photos: pageOf.map(photoView),
      next: photos.length > limit ? `${last.addedAt}_${last.fileId}` : null
    };
  }

  /** `PATCH {title?, date?}`: the creator, or a group's owner or admin. */
  async edit(req, res) {
    const { user, album, role, refused } = await this.open(req, res);
    if (refused) return refused;
    if (album.creator !== user && !isAdmin(role)) return forbidden(res);
    const changes = {};
    if (req.payload.title !== undefined) changes.title = req.payload.title;
    if (req.payload.date !== undefined) changes.date = req.payload.date;
    return albumView(await this.db.updateAlbum(album.albumId, changes));
  }

  /** `DELETE`: the album and its photos, for everyone. Same people as rename. */
  async remove(req, res) {
    const { user, album, role, refused } = await this.open(req, res);
    if (refused) return refused;
    if (album.creator !== user && !isAdmin(role)) return forbidden(res);
    const gone = await this.db.deleteAlbum(album.albumId);
    await this.deletePhotos(gone ? gone.photos : []);
    return res.response().code(204);
  }

  /**
   * `POST .../photos {photos}`: uploaded first through media-ms (category
   * `album`, not encrypted). A photo already in the album is skipped, so a
   * retry adds nothing twice.
   */
  async addPhotos(req, res) {
    const { user, album, refused } = await this.open(req, res);
    if (refused) return refused;
    const seen = new Set(album.photos.map((p) => p.fileId));
    const fresh = [];
    req.payload.photos.forEach((p) => {
      if (seen.has(p.fileId)) return;
      seen.add(p.fileId);
      fresh.push(p);
    });
    if (!fresh.length) return { album: albumView(album), photos: [] };
    const full = () => res.response(
      errorEnvelope('album_full', `An album holds at most ${MAX_PHOTOS} photos`)
    ).code(409);
    if (album.photos.length + fresh.length > MAX_PHOTOS) return full();
    if (await this.overBudget(`album:photos:${user}:h`, fresh.length, PHOTOS_HOUR, 3600)
      || await this.overBudget(`album:photos:${user}:d`, fresh.length, PHOTOS_DAY, 86400)) {
      return rateLimited(res);
    }
    const addedAt = Date.now();
    const photos = fresh.map((p) => ({ ...p, uploader: user, addedAt }));
    if (!(await this.db.addPhotos(album.albumId, photos, MAX_PHOTOS))) return full();
    return {
      album: albumView({ ...album, photos: [...album.photos, ...photos] }),
      photos: photos.map(photoView)
    };
  }

  /** `DELETE .../photos/{fileId}`: its uploader, the album's creator, or a group admin. */
  async removePhoto(req, res) {
    const { user, album, role, refused } = await this.open(req, res);
    if (refused) return refused;
    const photo = album.photos.find((p) => p.fileId === req.params.fileId);
    if (!photo) return notFound(res);
    if (photo.uploader !== user && album.creator !== user && !isAdmin(role)) {
      return forbidden(res);
    }
    await this.db.removePhoto(album.albumId, photo.fileId);
    await this.deletePhotos([photo]);
    return res.response().code(204);
  }

  /** Albums past their keep date go, photos with them. */
  async sweepExpired(now = Date.now()) {
    const batch = await this.db.takeExpired(new Date(now), SWEEP_BATCH);
    await this.deletePhotos(batch.flatMap((a) => a.photos));
    if (batch.length === SWEEP_BATCH) await this.sweepExpired(now);
  }

  /** A deleted group's albums go with it. Best effort: the rest expires. */
  async dropChat(channelId) {
    try {
      await this.deletePhotos((await this.db.takeChat(channelId)).flatMap((a) => a.photos));
    } catch (error) {
      this.service.log.error(`Album delete failed for ${channelId}: ${error.message}`);
    }
  }

  /**
   * AUTH_CONTRACT 8.2: a deleted account's photos go from every album,
   * and its 1:1 albums whole. Best effort, like its other side stores.
   */
  async eraseUser(userId) {
    try {
      const dms = await this.db.takeMember(userId);
      const own = await this.db.takePhotosBy(userId);
      await this.deletePhotos([...dms.flatMap((a) => a.photos), ...own]);
    } catch (error) {
      this.service.log.error(`Album erase failed for ${userId}: ${error.message}`);
    }
  }

  /** media-ms deletes a file only for its uploader. Best effort, logged. */
  async deletePhotos(photos) {
    await Promise.all(photos.map(({ fileId, uploader }) =>
      this.service.mediaClient
        .post('/_internal/files/delete', { fileId, owner: uploader })
        .catch((error) => this.service.log.error(`Album photo delete failed: ${error.message}`))));
  }
}

module.exports = { Albums, addAlbumOptions };
