const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const { extractInfoFromRequest, schemas, errorEnvelope } = require('../../helper');
const { HttpClient } = require('../../libs/http-client');
const eventStore = require('../../libs/event-store');
const MemCache = require('../../libs/cache');
const {
  ENVELOPE_FLAG, FRAME_CLASS, classFlags, dmChannelId, opIdUserBits
} = require('../../libs/v3-envelope');
const { addDatabaseOptions, initializeDatabase } = require('./database');
const { REPORT_RETENTION_SEC } = require('./database/channel-db');
const { channelServerEvent } = require('./server-event');

const asMain = require.main === module;

/**
 * Same window as the gateway (SYNC_PROTOCOL.md §19 decision 3 / §16). Repeated
 * rather than imported so channel-ms does not depend on another service's
 * module; the cache keys below are what actually ties the two together.
 */
const DEDUP_MAX_ENTRIES = 10000;
const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;

/** §19 — a group is capped; `precondition_failed` once it is hit. */
const MAX_MEMBERS = 100;

const USER_ID = Joi.string().pattern(/^[0-9a-f]{9}$/);

/** A derived DM id (TRIM_4_12_CONTRACT §1); a group's is a dashed UUID. */
const DM_ID = /^d[0-9a-f]{31}$/;

/**
 * Decision 220: group keys, resend requests and group receipts travel 1:1
 * between co-members of a group, who need not be connected.
 */
const GROUP_PAIR_CLASSES = [FRAME_CLASS.KEY, FRAME_CLASS.RECEIPT, FRAME_CLASS.RESEND];

/** Decision 219: the invite event that brings an invite wakes the phone; the rest do not. */
const INVITE_WAKES = classFlags(FRAME_CLASS.INVITE);
const INVITE_QUIET = INVITE_WAKES + ENVELOPE_FLAG.SILENT;

/** How often the 90-day report retention runs on a store with no TTL of its own. */
const REPORT_PURGE_MS = 24 * 60 * 60 * 1000;

/**
 * Reports one user may file in a day, counted from their first: enough for
 * anyone reporting the people bothering them, not for flooding the operator.
 */
const REPORTS_PER_DAY = 10;

/** What a reporter's phone may attach: the chat's last 5 messages, as it shows them. */
const REPORTED_MESSAGE = Joi.object({
  author: USER_ID.required(),
  body: Joi.string().allow('').max(4096).required(),
  content_type: Joi.string().max(100),
  sent_at: Joi.number().integer()
});

/** SYNC_PROTOCOL.md §11.2 — every REST write carries these. */
const OP_FIELDS = {
  op_id: Joi.string().uuid().required(),
  // Retired (DECISIONS row 127): accepted from older clients and ignored.
  resource_seq: Joi.any(),
  client_timestamp_ms: Joi.number().integer()
};

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = addDatabaseOptions(cmd);
  cmd = MemCache.addMemCacheOptions(cmd);
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd = cmd
    .option(
      '--new-message-topic <new-message-topic>',
      'Used by producer to publish the §10.2 server events for REST channel writes'
    )
    .option(
      '--invite-pending-max <count>',
      'Pending 1:1 invites one user may have out at a time (decision 219)',
      (value) => Number(value),
      30
    )
    .option('--media-ms-endpoint <media-ms-endpoint>', 'Base url for media service');
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options)
    .then(initHttpResource)
    .then(initializeDatabase)
    .then(MemCache.initMemCache)
    .then(eventStore.initializeEventStore({ producer: true }));
}

/** The member row a create/add writes. */
function memberRow(userId, role) {
  return { user_id: userId, role, joinedAt: Date.now(), removedAt: null };
}

function roleOf(channel, userId) {
  const member = channel.members.find((m) => m.user_id === userId);
  return member ? member.role : null;
}

function memberIds(channel) {
  return channel.members.map((m) => m.user_id);
}

/**
 * DECISIONS row 9 — who inherits a channel when the owner leaves: the
 * longest-standing admin, else the longest-standing remaining member. Ties on
 * `joinedAt` break lexically so every replica picks the same heir.
 */
function successor(members) {
  const admins = members.filter((m) => m.role === 'admin');
  return [...(admins.length ? admins : members)]
    .sort((a, b) => a.joinedAt - b.joinedAt || a.user_id.localeCompare(b.user_id))[0];
}

/** The shape a channel takes in a REST response; `invited` are its pending invitees. */
function channelView(channel, invited = []) {
  return {
    channel_id: channel.channelId,
    kind: channel.kind,
    name: channel.name,
    avatar_url: channel.avatarUrl,
    members: memberIds(channel),
    // additive (DECISIONS row 150): lets a member added later, or a
    // reinstalled client, rebuild the roster with its owner and admins
    roles: Object.fromEntries(channel.members.map((m) => [m.user_id, m.role])),
    // decision 221: invited, not yet members
    invited,
    created_at: channel.createdAt
  };
}

/** One pending invite as `GET /connections` lists it. */
function inviteView({ channelId, from, to, createdAt }, name = null) {
  return { channel_id: channelId, from, to, name, created_at: createdAt };
}

/**
 * v3 channel service (SYNC_PROTOCOL.md §11.3 writes, §10.2 fanout).
 *
 * Every write shares the client's outbound queue with WS envelopes, so it runs
 * the same preamble: `op_id` prefix binding (§3) and dedup replay with the
 * stored outcome (§7.1). The dedup keys are the gateway's, so REST and WS share
 * one window per user. No ordering is kept here (DECISIONS row 127).
 */
class ChannelMs extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('./database/channel-db').IChannelDB} */
    this.db = context.channelDb;
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
    this.memCache = context.memCache;
    this.mediaClient = new HttpClient(this.options.mediaMsEndpoint);
  }

  async init() {
    await super.init();
    // §8.2 spells this service's error codes lowercase, unknown route included
    this.notFoundCode = 'not_found';

    const channelParam = Joi.object({ channelId: Joi.string().required() });

    this.addRoute('/', 'GET', this.getChannels.bind(this), {
      validate: { headers: schemas.authHeaders }
    });

    this.addRoute('/', 'POST', this.createChannel.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        payload: Joi.object({
          ...OP_FIELDS,
          channel_id: Joi.string().uuid().required(),
          // trim 4: groups are the only channel with a row. A DM id is
          // derived from the pair and never created (TRIM_4_12_CONTRACT §4).
          kind: Joi.string().valid('group').required(),
          name: Joi.string().allow(null, ''),
          avatar_url: Joi.string().allow(null, ''),
          members: Joi.array().items(USER_ID).min(1).max(MAX_MEMBERS).required()
        })
      }
    });

    // ---- connecting (decisions 219-221) ----------------------------------
    const userParam = Joi.object({ userId: USER_ID.required() });

    this.addRoute('/connections', 'GET', this.getConnections.bind(this), {
      validate: { headers: schemas.authHeaders }
    });

    this.addRoute('/invites', 'POST', this.invite.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        payload: Joi.object({ user_id: USER_ID.required() })
      }
    });

    this.addRoute('/{channelId}/invite/accept', 'POST', this.acceptInvite.bind(this), {
      validate: { headers: schemas.authHeaders, params: channelParam }
    });

    this.addRoute('/{channelId}/invite/decline', 'POST', this.declineInvite.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        params: channelParam,
        payload: Joi.object({ block: Joi.boolean() }).allow(null)
      }
    });

    this.addRoute('/{channelId}/invites/{userId}', 'DELETE', this.cancelInvite.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        params: Joi.object({ channelId: Joi.string().required(), userId: USER_ID.required() })
      }
    });

    this.addRoute('/blocks', 'POST', this.block.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        payload: Joi.object({ user_id: USER_ID.required() })
      }
    });

    this.addRoute('/blocks/{userId}', 'DELETE', this.unblock.bind(this), {
      validate: { headers: schemas.authHeaders, params: userParam }
    });

    this.addRoute('/reports', 'POST', this.report.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        payload: Joi.object({
          user_id: USER_ID.required(),
          messages: Joi.array().items(REPORTED_MESSAGE).max(5).default([])
        })
      }
    });

    // the gateway asks before it relays a 1:1 frame
    this.addInternalRoute('/gate/{from}/{to}', 'GET', this.gate.bind(this), {
      validate: {
        params: Joi.object({ from: USER_ID.required(), to: USER_ID.required() }),
        query: Joi.object({ class: Joi.number().integer().min(0).max(15).default(0) })
      }
    });

    this.addRoute('/{channelId}', 'GET', this.getChannelInfo.bind(this), {
      validate: { headers: schemas.authHeaders, params: channelParam }
    });

    this.addRoute('/{channelId}', 'PATCH', this.editChannel.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        params: channelParam,
        payload: Joi.object({
          ...OP_FIELDS,
          name: Joi.string(),
          avatar_url: Joi.string().allow(null, '')
        }).or('name', 'avatar_url')
      }
    });

    this.addRoute('/{channelId}', 'DELETE', this.deleteChannel.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        params: channelParam,
        payload: Joi.object(OP_FIELDS)
      }
    });

    this.addRoute('/{channelId}/members', 'POST', this.addMembers.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        params: channelParam,
        payload: Joi.object({
          ...OP_FIELDS,
          members: Joi.array().items(USER_ID).min(1).max(MAX_MEMBERS).required()
        })
      }
    });

    this.addRoute('/{channelId}/members/{userId}', 'DELETE', this.removeMember.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        params: Joi.object({
          channelId: Joi.string().required(),
          userId: USER_ID.required()
        }),
        payload: Joi.object(OP_FIELDS)
      }
    });

    this.addRoute('/{channelId}/members/{userId}', 'PATCH', this.setMemberRole.bind(this), {
      validate: {
        headers: schemas.authHeaders,
        params: Joi.object({
          channelId: Joi.string().required(),
          userId: USER_ID.required()
        }),
        payload: Joi.object({
          ...OP_FIELDS,
          role: Joi.string().valid('admin', 'member').required()
        })
      }
    });

    this.addInternalRoute('/{channelId}', 'GET', this.getChannelInfo.bind(this), {
      validate: { params: channelParam }
    });

    // Same list, off the authenticated prefix: profile-ms reads it for the
    // §10.2 fanout on behalf of a user, which is not a request that user made.
    this.addInternalRoute('/', 'GET', this.getChannels.bind(this), {
      validate: { headers: schemas.authHeaders }
    });

    // profile-ms: who a timeline post may go to, who sees one's presence,
    // who hears of a profile edit (no `users`: all of `user_id`'s connections)
    this.addInternalRoute('/connections/pairs', 'POST', this.pairs.bind(this), {
      validate: {
        payload: Joi.object({
          user_id: USER_ID.required(),
          users: Joi.array().items(USER_ID).max(1000)
        })
      }
    });

    this.addInternalRoute('/members/remove', 'POST', this.removeEverywhere.bind(this), {
      validate: { payload: Joi.object({ user_id: USER_ID.required() }) }
    });

    await this.seedConnections();
    // the 90-day report retention; mongo's TTL index does it too
    this.reportTimer = setInterval(() => this.purgeReports(), REPORT_PURGE_MS);
    this.reportTimer.unref();
    await this.purgeReports();
  }

  async purgeReports() {
    try {
      await this.db.purgeReports(new Date(Date.now() - REPORT_RETENTION_SEC * 1000));
    } catch (error) {
      this.log.error(`Report purge failed: ${error.message}`);
    }
  }

  /**
   * Decision 219, migration: before the gate, a 1:1 chat needed no invite.
   * Every pair that still has a 1:1 message or edit on the timeline counts as
   * connected, once, while no pair is connected at all. Only where the
   * timeline is at hand (the monolith shares it).
   * ponytail: the timeline keeps 30 days, so a pair silent for longer
   * invites again; their phones hold the rest, which the server never sees.
   */
  async seedConnections() {
    const queue = this.context.undeliveredQueue;
    if (!queue || await this.db.anyConnection()) return;
    const pairs = await queue.dmPairs();
    const now = Date.now();
    await Promise.all(pairs.map(([a, b]) => this.db.connect(a, b, now)));
    if (pairs.length) this.log.info(`Connected ${pairs.length} pair(s) from existing 1:1 chats`);
  }

  /**
   * AUTH_CONTRACT 8.2 step 5 — profile-ms, on a deleted account: it leaves
   * every group as if it had left itself, so members rotate the group key.
   */
  async removeEverywhere(req) {
    const { user_id: userId } = req.payload;
    const channels = await this.db.getMemberChannels(userId);
    await Promise.all(channels.map((channel) => this.leave(channel, userId, userId)));
    // decision 219: their invites, connections and blocks go with them
    await this.db.forget(userId);
    return { removed: channels.length };
  }

  // ---- §11.2 preamble ---------------------------------------------------

  /**
   * §3 prefix binding + §7.1 dedup replay. Returns the response to send when
   * the op must not be applied, else null.
   */
  async replayed(res, user, opId) {
    const stored = await this.memCache.dedupGet(`dedup:${user}`, opId);
    if (stored) {
      const { status, body } = JSON.parse(stored);
      return res.response(body).code(status);
    }
    if (opIdUserBits(opId) !== parseInt(user, 16)) {
      return this.reject(res, user, opId, 400, 'prefix_mismatch', 'op_id is not bound to this user');
    }
    return null;
  }

  /**
   * Remember an outcome so a replay of `op_id` repeats it verbatim (§7.1).
   * Best effort: the window lives in the cache and may be lost on a restart,
   * which is harmless because clients dedupe inbound envelopes by op_id.
   */
  async store(user, opId, status, body) {
    await this.memCache.dedupPut(
      `dedup:${user}`,
      opId,
      JSON.stringify({ status, body }),
      DEDUP_MAX_ENTRIES,
      DEDUP_TTL_SEC
    );
  }

  async reject(res, user, opId, status, code, message) {
    const body = errorEnvelope(code, message);
    await this.store(user, opId, status, body);
    return res.response(body).code(status);
  }

  async accept(res, user, opId, status, body) {
    await this.store(user, opId, status, body);
    return res.response(body).code(status);
  }

  // ---- writes ------------------------------------------------------------

  async createChannel(req, res) {
    const user = extractInfoFromRequest(req);
    const {
      op_id: opId,
      channel_id: channelId,
      kind,
      name,
      avatar_url: avatarUrl,
      members
    } = req.payload;

    const replay = await this.replayed(res, user, opId);
    if (replay) return replay;

    if (!members.includes(user)) {
      return this.reject(res, user, opId, 403, 'forbidden', 'creator must be in members');
    }
    // decision 221: everyone but the creator is invited, and only people the
    // creator is connected with may be
    const invitees = [...new Set(members)].filter((id) => id !== user);
    const strangers = await this.strangers(user, invitees);
    if (strangers.length) {
      return this.reject(res, user, opId, 403, 'not_connected', `not connected: ${strangers}`);
    }

    const channel = {
      channelId,
      kind,
      name: name || null,
      avatarUrl: avatarUrl || null,
      avatarBy: avatarUrl ? user : null,
      owner: user,
      members: [memberRow(user, 'owner')],
      createdAt: Date.now()
    };

    let created;
    try {
      created = await this.db.create(channel);
    } catch (error) {
      if (error.code === 'CHANNEL_EXISTS') {
        // The id is never reassigned, so this is terminal for that op_id.
        return this.reject(res, user, opId, 409, 'resource_id_taken', 'channel_id already exists');
      }
      throw error;
    }

    await this.fanout('CHANNEL_CREATED', created, user, memberIds(created), {
      channelId,
      kind,
      name: created.name || '',
      members: memberIds(created),
      creator: user,
      createdAtMs: created.createdAt
    });
    await this.inviteToGroup(created, user, invitees);

    return this.accept(res, user, opId, 201, channelView(created, invitees));
  }

  async addMembers(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId } = req.params;
    const { op_id: opId, members } = req.payload;

    const replay = await this.replayed(res, user, opId);
    if (replay) return replay;

    const channel = await this.db.getChannelInfo(channelId);
    const denied = this.requireRole(channel, user, ['owner', 'admin']);
    if (denied) return this.reject(res, user, opId, denied.status, denied.code, denied.message);

    // decision 221: an add is an invite; the invitee is a member once they accept
    const existing = memberIds(channel);
    const pending = await this.invitedTo(channelId);
    const added = [...new Set(members)]
      .filter((id) => !existing.includes(id) && !pending.includes(id));
    if (existing.length + pending.length + added.length > MAX_MEMBERS) {
      return this.reject(res, user, opId, 412, 'precondition_failed', 'group member cap exceeded');
    }
    const strangers = await this.strangers(user, added);
    if (strangers.length) {
      return this.reject(res, user, opId, 403, 'not_connected', `not connected: ${strangers}`);
    }

    await this.inviteToGroup(channel, user, added);
    return this.accept(res, user, opId, 200, {
      member_count: existing.length, invited: [...pending, ...added]
    });
  }

  async removeMember(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId, userId } = req.params;
    const { op_id: opId } = req.payload;

    const replay = await this.replayed(res, user, opId);
    if (replay) return replay;

    const channel = await this.db.getChannelInfo(channelId);
    // anyone may leave; removing someone else needs owner/admin
    const denied = this.requireRole(
      channel, user, userId === user ? ['owner', 'admin', 'member'] : ['owner', 'admin']
    );
    if (denied) return this.reject(res, user, opId, denied.status, denied.code, denied.message);
    if (!roleOf(channel, userId)) {
      return this.reject(res, user, opId, 404, 'not_found', 'not a member of this channel');
    }

    await this.leave(channel, user, userId);
    return this.accept(res, user, opId, 200, { member_count: channel.members.length - 1 });
  }

  /**
   * DECISIONS row 80 — owner and admins promote a member to admin or demote an
   * admin back. The owner's role and the caller's own are off limits here: the
   * owner hands over by leaving (row 9).
   */
  async setMemberRole(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId, userId } = req.params;
    const { op_id: opId, role } = req.payload;

    const replay = await this.replayed(res, user, opId);
    if (replay) return replay;

    const channel = await this.db.getChannelInfo(channelId);
    const denied = this.requireRole(channel, user, ['owner', 'admin']);
    if (denied) return this.reject(res, user, opId, denied.status, denied.code, denied.message);

    const current = roleOf(channel, userId);
    if (!current) {
      return this.reject(res, user, opId, 404, 'not_found', 'not a member of this channel');
    }
    if (userId === user || current === 'owner') {
      return this.reject(
        res, user, opId, 403, 'forbidden', 'the owner role and your own cannot be changed'
      );
    }

    await this.db.setMemberRole(channelId, userId, role);
    await this.announceRole(channel, user, userId, role, memberIds(channel));
    return this.accept(res, user, opId, 200, { user_id: userId, role });
  }

  async editChannel(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId } = req.params;
    const { op_id: opId, name, avatar_url: avatarUrl } = req.payload;

    const replay = await this.replayed(res, user, opId);
    if (replay) return replay;

    const channel = await this.db.getChannelInfo(channelId);
    const denied = this.requireRole(channel, user, ['owner', 'admin']);
    if (denied) return this.reject(res, user, opId, denied.status, denied.code, denied.message);

    const updates = {};
    const event = { channelId, editedAtMs: Date.now() };
    if (name !== undefined) {
      updates.name = name;
      event.name = name;
    }
    if (avatarUrl !== undefined) {
      updates.avatarUrl = avatarUrl;
      updates.avatarBy = avatarUrl ? user : null;
      event.avatarUrl = avatarUrl || '';
    }
    const updated = await this.db.updateChannel(channelId, updates);
    if (channel.avatarUrl !== updated.avatarUrl) await this.deleteGroupPhoto(channel);
    await this.fanout('CHANNEL_EDITED', channel, user, memberIds(channel), event);
    return this.accept(res, user, opId, 200, channelView(updated));
  }

  /**
   * DECISIONS row 9 — the owner's DELETE is a hard delete with `ChannelDeleted`
   * fanout; anyone else's is a leave with `ChannelMemberRemoved`.
   */
  async deleteChannel(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId } = req.params;
    const { op_id: opId } = req.payload;

    const replay = await this.replayed(res, user, opId);
    if (replay) return replay;

    const channel = await this.db.getChannelInfo(channelId);
    const denied = this.requireRole(channel, user, ['owner', 'admin', 'member']);
    if (denied) return this.reject(res, user, opId, denied.status, denied.code, denied.message);

    if (roleOf(channel, user) !== 'owner') {
      await this.leave(channel, user, user);
      return this.accept(res, user, opId, 200, { member_count: channel.members.length - 1 });
    }

    const invited = await this.invitedTo(channelId);
    await this.db.deleteChannel(channelId);
    await this.deleteGroupPhoto(channel);
    // its invitees too, so their pending invite goes (decision 221)
    await this.fanout('CHANNEL_DELETED', channel, user, [...memberIds(channel), ...invited], {
      channelId,
      deletedAtMs: Date.now()
    });
    return this.accept(res, user, opId, 204, null);
  }

  // ---- reads -------------------------------------------------------------

  /** trim 4: groups are the only channel with a row, so that is the whole list. */
  async getChannels(req) {
    const user = extractInfoFromRequest(req);
    const channels = await this.db.getMemberChannels(user);
    const invites = await this.db.findInvites(null, channels.map((c) => c.channelId));
    return channels.map((channel) => channelView(
      channel, invites.filter((i) => i.channelId === channel.channelId).map((i) => i.to)
    ));
  }

  async getChannelInfo(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId } = req.params;
    // the internal route has no authenticated user: the gateway asks about a
    // channel to find out who is in it.
    const channel = await this.db.getChannelInfo(channelId, req.internal ? null : user);
    if (!channel) {
      return res.response(errorEnvelope('not_found', 'unknown channel')).code(404);
    }
    return req.internal ? channel : channelView(channel, await this.invitedTo(channelId));
  }

  // ---- connecting (decisions 219-221, SYNC_PROTOCOL §23) ------------------

  /** Who has a pending invite to `channelId`. */
  async invitedTo(channelId) {
    return (await this.db.findInvites(null, [channelId])).map((invite) => invite.to);
  }

  /** Of `users`, those `user` is not connected with: an admin invites only connections. */
  async strangers(user, users) {
    if (!users.length) return [];
    const connections = await this.db.connectionsOf(user);
    return users.filter((id) => !connections.includes(id));
  }

  /**
   * `GET /connections` — what the caller's phone mirrors: who they are
   * connected with, who they blocked, and every pending invite they can
   * see: to them (less those from someone they blocked), from them, and in
   * the groups they are in. A group invite carries the group's name.
   */
  async getConnections(req) {
    const user = extractInfoFromRequest(req);
    const [connections, blocked, groups] = await Promise.all([
      this.db.connectionsOf(user),
      this.db.blockedBy(user),
      this.db.getMemberChannels(user)
    ]);
    const names = new Map(groups.map((group) => [group.channelId, group.name]));
    const invites = (await this.db.findInvites(user, [...names.keys()]))
      .filter((invite) => !(invite.to === user && blocked.includes(invite.from)));
    const views = await Promise.all(invites.map(async (invite) => {
      if (DM_ID.test(invite.channelId)) return inviteView(invite);
      // an invitee is not in the group yet
      if (!names.has(invite.channelId)) {
        names.set(invite.channelId, (await this.db.getChannelInfo(invite.channelId))?.name);
      }
      return inviteView(invite, names.get(invite.channelId) || null);
    }));
    return { connections, blocked, invites: views };
  }

  /**
   * `POST /invites {user_id}` — invite someone to a 1:1 chat. Inviting
   * someone who invited you accepts theirs. Answers the pair's state:
   * `sent` or `connected`.
   */
  async invite(req, res) {
    const user = extractInfoFromRequest(req);
    const { user_id: to } = req.payload;
    if (to === user) {
      return res.response(errorEnvelope('validation_failed', 'cannot invite yourself')).code(400);
    }
    const channelId = dmChannelId(user, to);
    const pair = await this.db.pair(user, to);
    if (pair.connected) return { state: 'connected' };
    const theirs = await this.db.getInvite(channelId, user);
    if (theirs) return this.acceptDm(theirs, user);
    if (await this.db.getInvite(channelId, to)) return { state: 'sent' };

    const pending = (await this.db.findInvites(user))
      .filter((invite) => invite.from === user && DM_ID.test(invite.channelId));
    if (pending.length >= this.options.invitePendingMax) {
      return res.response(errorEnvelope(
        'invite_limit',
        `at most ${this.options.invitePendingMax} invites may wait for an answer`
      )).code(429);
    }
    const now = Date.now();
    await this.db.addInvite({ channelId, to, from: user, createdAt: now });
    // decision 219: from someone they blocked, it is kept but never reaches them
    if (!pair.bBlockedA) {
      await this.fanout('INVITE_SENT', { channelId }, user, [to], {
        users: [to], atMs: now
      }, { peer: to, flags: INVITE_WAKES });
    }
    return { state: 'sent' };
  }

  /** Connect the pair of a 1:1 invite and tell the inviter. */
  async acceptDm(invite, user) {
    const now = Date.now();
    await this.db.connect(invite.from, user, now);
    await this.db.deleteInvite(invite.channelId, user);
    await this.fanout('INVITE_ANSWERED', { channelId: invite.channelId }, user, [invite.from], {
      user, answer: 'INVITE_ACCEPTED', atMs: now
    }, { peer: invite.from, flags: INVITE_QUIET });
    return { state: 'connected' };
  }

  /**
   * `POST /{channelId}/invite/accept` — the caller accepts their invite:
   * a 1:1 one (`channelId` the pair's DM id) connects the two; a group's
   * makes them a member, announced as ChannelMemberAdded with the newcomer
   * as actor, and answers the group as `GET /{channelId}` does. Accepting
   * again after it went through answers the same.
   */
  async acceptInvite(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId } = req.params;
    const invite = await this.db.getInvite(channelId, user);
    const dm = DM_ID.test(channelId);
    if (dm && invite) return this.acceptDm(invite, user);
    const channel = dm ? null : await this.db.getChannelInfo(channelId);
    if (!invite) {
      if (channel && roleOf(channel, user)) return channelView(channel, await this.invitedTo(channelId));
      return res.response(errorEnvelope('not_found', 'no pending invite')).code(404);
    }
    if (!channel) {
      await this.db.deleteInvite(channelId, user);
      return res.response(errorEnvelope('not_found', 'unknown channel')).code(404);
    }
    if (channel.members.length >= MAX_MEMBERS) {
      return res.response(errorEnvelope('precondition_failed', 'group member cap exceeded'))
        .code(412);
    }
    const now = Date.now();
    await this.db.addMembers(channelId, [memberRow(user, 'member')]);
    await this.db.deleteInvite(channelId, user);
    await this.fanout('CHANNEL_MEMBER_ADDED', channel, user, [...memberIds(channel), user], {
      channelId, members: [user], role: 'member', addedAtMs: now
    });
    return channelView(await this.db.getChannelInfo(channelId), await this.invitedTo(channelId));
  }

  /**
   * `POST /{channelId}/invite/decline {block?}` — the caller declines their
   * invite; `block` also blocks whoever sent it (Decline & Block). The
   * inviter (and a group's members) hear of it, SILENT. Idempotent.
   */
  async declineInvite(req) {
    const user = extractInfoFromRequest(req);
    const { channelId } = req.params;
    const invite = await this.db.getInvite(channelId, user);
    if (!invite) return { state: 'none' };
    await this.db.deleteInvite(channelId, user);
    if (req.payload?.block) await this.db.setBlocked(user, invite.from, true);
    await this.answered(invite, user, 'INVITE_DECLINED', [invite.from]);
    return { state: 'none' };
  }

  /**
   * `DELETE /{channelId}/invites/{userId}` — take back an invite: its
   * sender may, and for a group so may its owner and admins. The invitee
   * (and a group's members) hear of it, SILENT. Idempotent.
   */
  async cancelInvite(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId, userId } = req.params;
    const invite = await this.db.getInvite(channelId, userId);
    if (!invite) return { state: 'none' };
    if (invite.from !== user) {
      const channel = DM_ID.test(channelId) ? null : await this.db.getChannelInfo(channelId);
      if (!channel || !['owner', 'admin'].includes(roleOf(channel, user))) {
        return res.response(errorEnvelope('forbidden', 'not your invite')).code(403);
      }
    }
    await this.db.deleteInvite(channelId, userId);
    await this.answered(invite, user, 'INVITE_CANCELED', [userId]);
    return { state: 'none' };
  }

  /**
   * An invite that ended without a member: to `recipients`, and for a group
   * to its members as well. A 1:1 one goes to the one recipient as its peer.
   */
  async answered(invite, actor, answer, recipients) {
    const dm = DM_ID.test(invite.channelId);
    const body = { user: invite.to, answer, atMs: Date.now() };
    if (dm) {
      await this.fanout('INVITE_ANSWERED', invite, actor, recipients, body, {
        peer: recipients[0], flags: INVITE_QUIET
      });
      return;
    }
    const channel = await this.db.getChannelInfo(invite.channelId);
    const members = channel ? memberIds(channel) : [];
    await this.fanout('INVITE_ANSWERED', invite, actor, [...new Set([...members, ...recipients])], {
      ...body, channelId: invite.channelId
    }, { flags: INVITE_QUIET });
  }

  /**
   * Invite `users` to a group: the invitee hears of it (it wakes their
   * phone), the members too, SILENT, for their member list. Someone who
   * blocked `actor` is invited but never told (decision 219).
   */
  async inviteToGroup(channel, actor, users) {
    const now = Date.now();
    const { channelId } = channel;
    const added = await Promise.all(users.map((to) => this.db.addInvite({
      channelId, to, from: actor, createdAt: now
    })));
    const fresh = users.filter((_, i) => added[i]);
    if (!fresh.length) return;
    const pairs = await Promise.all(fresh.map((to) => this.db.pair(actor, to)));
    const reach = fresh.filter((_, i) => !pairs[i].bBlockedA);
    const body = { channelId, users: fresh, name: channel.name || '', atMs: now };
    if (reach.length) {
      await this.fanout('INVITE_SENT', channel, actor, reach, body, { flags: INVITE_WAKES });
    }
    await this.fanout('INVITE_SENT', channel, actor, memberIds(channel), body, {
      flags: INVITE_QUIET
    });
  }

  /** `POST /blocks {user_id}`: the server refuses their 1:1 frames and invites to the caller. */
  async block(req) {
    const user = extractInfoFromRequest(req);
    const { user_id: blocked } = req.payload;
    await this.db.setBlocked(user, blocked, true);
    return { user_id: blocked, blocked: true };
  }

  /** `DELETE /blocks/{userId}`. */
  async unblock(req) {
    const user = extractInfoFromRequest(req);
    const { userId } = req.params;
    await this.db.setBlocked(user, userId, false);
    return { user_id: userId, blocked: false };
  }

  /**
   * `POST /reports {user_id, messages}` — kept 90 days for the operator
   * (deployment README "Reports"). `messages` is what the reporter's phone
   * chose to send: up to the chat's last 5, decrypted there.
   */
  async report(req, res) {
    const user = extractInfoFromRequest(req);
    const { user_id: reported, messages } = req.payload;
    if (await this.memCache.incr(`report:rate:${user}:d`, 86400) > REPORTS_PER_DAY) {
      return res.response(errorEnvelope(
        'rate_limited', `at most ${REPORTS_PER_DAY} reports a day`, { retry_after_sec: 86400 }
      )).code(429);
    }
    await this.db.addReport({ reporter: user, reported, messages });
    return res.response({ reported }).code(201);
  }

  /**
   * `POST /_internal/connections/pairs {user_id, users?}` — of `users`, who
   * `user_id` is connected to with no block either way (`connected`: whom a
   * timeline post may reach, who are "contacts" for presence), and who has a
   * block with them either way (`blocked`: never shown their presence).
   * Without `users`, of all their connections (whom a profile edit reaches).
   * ponytail: one pair lookup per user; a join on connections and blocks if
   * people ever count their connections in thousands.
   */
  async pairs(req) {
    const { user_id: user } = req.payload;
    const users = req.payload.users || await this.db.connectionsOf(user);
    const pairs = await Promise.all(users.map((other) => this.db.pair(user, other)));
    const blocked = (p) => p.aBlockedB || p.bBlockedA;
    return {
      connected: users.filter((_, i) => pairs[i].connected && !blocked(pairs[i])),
      blocked: users.filter((_, i) => blocked(pairs[i]))
    };
  }

  /**
   * `GET /_internal/gate/{from}/{to}?class=` — may `from`'s 1:1 frame of
   * that class reach `to` (decisions 219, 220)? `ok`; `blocked`, which the
   * gateway acks and drops so the sender cannot tell; or `not_connected`.
   */
  async gate(req) {
    const { from, to } = req.params;
    if (from === to) return { verdict: 'ok' };
    const pair = await this.db.pair(from, to);
    if (pair.shareGroup && GROUP_PAIR_CLASSES.includes(req.query.class)) return { verdict: 'ok' };
    if (pair.bBlockedA) return { verdict: 'blocked' };
    return { verdict: pair.connected ? 'ok' : 'not_connected' };
  }

  // ---- shared ------------------------------------------------------------

  /**
   * §8.2 — `not_found` for an unknown channel, `forbidden` when the caller
   * lacks the role. Returns null when the caller may proceed.
   */
  // eslint-disable-next-line class-methods-use-this
  requireRole(channel, user, roles) {
    if (!channel) return { status: 404, code: 'not_found', message: 'unknown channel' };
    const role = roleOf(channel, user);
    if (!role) return { status: 403, code: 'forbidden', message: 'not a member of this channel' };
    if (!roles.includes(role)) {
      return { status: 403, code: 'forbidden', message: `requires one of ${roles.join('/')}` };
    }
    return null;
  }

  /**
   * Tombstone a member and tell the channel (remaining members + the removed
   * one). DECISIONS row 9: the last member out takes the channel with them,
   * and a leaving owner hands the channel to `successor`.
   */
  async leave(channel, actor, userId) {
    const removedAtMs = Date.now();
    await this.db.removeMember(channel.channelId, userId, removedAtMs);
    const remaining = channel.members.filter((m) => m.user_id !== userId);
    if (!remaining.length) {
      await this.db.deleteChannel(channel.channelId);
      await this.deleteGroupPhoto(channel);
      await this.fanout('CHANNEL_DELETED', channel, actor, [userId], {
        channelId: channel.channelId,
        deletedAtMs: removedAtMs
      });
      return;
    }
    await this.fanout('CHANNEL_MEMBER_REMOVED', channel, actor, memberIds(channel), {
      channelId: channel.channelId,
      member: userId,
      removedAtMs
    });
    if (roleOf(channel, userId) === 'owner') {
      const heir = successor(remaining);
      await this.db.setMemberRole(channel.channelId, heir.user_id, 'owner');
      await this.announceRole(
        channel, actor, heir.user_id, 'owner', remaining.map((m) => m.user_id)
      );
    }
  }

  /**
   * A replaced or deleted group's photo goes from storage, as a profile photo
   * does (decision 195). media-ms deletes it only if whoever set it uploaded
   * it, so an admin cannot name someone else's file and have it deleted. A
   * row from before `avatarBy` was kept falls back to the group's owner.
   * Best effort: the edit or delete has already happened.
   */
  async deleteGroupPhoto({ channelId, avatarUrl, avatarBy, owner }) {
    if (!avatarUrl) return;
    try {
      await this.mediaClient.post('/_internal/files/delete', {
        fileId: avatarUrl.split('#')[0],
        owner: avatarBy || owner
      });
    } catch (error) {
      this.log.error(`Group photo delete failed for ${channelId}: ${error.message}`);
    }
  }

  /**
   * DECISIONS row 80 — a role change or a succession re-announces the affected
   * member as `ChannelMemberAdded{role}`; clients upsert the role.
   */
  async announceRole(channel, actor, userId, role, recipients) {
    await this.fanout('CHANNEL_MEMBER_ADDED', channel, actor, recipients, {
      channelId: channel.channelId,
      members: [userId],
      role,
      addedAtMs: Date.now()
    });
  }

  /**
   * §10.2 — publish the server event to the new-message topic, exactly as the
   * gateway publishes chat envelopes. Recipients are all affected members
   * including the actor; the delivery path is what keeps the actor's own
   * device from seeing it (§10.3 step 4).
   */
  async fanout(type, channel, actor, recipients, body, extra = {}) {
    const { newMessageTopic } = this.options;
    const channelId = channel.channelId || body.channelId;
    const event = channelServerEvent(type, body, { channelId, actor, recipients, ...extra });
    await this.eventStore.emit(newMessageTopic, event, channelId);
  }

  async shutdown() {
    clearInterval(this.reportTimer);
    await super.shutdown();
    await this.db.dispose();
    await this.memCache.dispose();
    await this.eventStore.dispose();
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResource(options)
    .then(async (context) => {
      await new ChannelMs(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Channel MS', error);
      process.exit(1);
    });
}

module.exports = {
  ChannelMs,
  parseOptions,
  initResource
};
