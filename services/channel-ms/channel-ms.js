const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const { extractInfoFromRequest, schemas, verifySecret, errorEnvelope } = require('../../helper');
const eventStore = require('../../libs/event-store');
const MemCache = require('../../libs/cache');
const { opIdUserBits } = require('../../libs/v3-envelope');
const { addDatabaseOptions, initializeDatabase } = require('./database');
const { channelServerEvent } = require('./server-event');

const asMain = require.main === module;

/**
 * Same window as the gateway (SYNC_PROTOCOL.md §19 decision 3 / §16). Repeated
 * rather than imported so channel-ms does not depend on another service's
 * module; the cache keys below are what actually ties the two together.
 */
const DEDUP_MAX_ENTRIES = 10000;
const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;
const SEQ_TTL_SEC = DEDUP_TTL_SEC;

/** §19 — a group is capped; `precondition_failed` once it is hit. */
const MAX_MEMBERS = 100;

const USER_ID = Joi.string().pattern(/^[0-9a-f]{9}$/);

/** SYNC_PROTOCOL.md §11.2 — every REST write carries these. */
const OP_FIELDS = {
  op_id: Joi.string().uuid().required(),
  resource_seq: Joi.number().integer().min(1).required(),
  client_timestamp_ms: Joi.number().integer()
};

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = addDatabaseOptions(cmd);
  cmd = MemCache.addMemCacheOptions(cmd);
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd = cmd.option(
    '--new-message-topic <new-message-topic>',
    'Used by producer to publish the §10.2 server events for REST channel writes'
  );
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

/** The shape a channel takes in a REST response. */
function channelView(channel) {
  return {
    channel_id: channel.channelId,
    kind: channel.kind,
    name: channel.name,
    avatar_url: channel.avatarUrl,
    members: memberIds(channel),
    created_at: channel.createdAt
  };
}

/**
 * v3 channel service (SYNC_PROTOCOL.md §11.3 writes, §10.2 fanout).
 *
 * Every write shares the client's outbound queue with WS envelopes, so it runs
 * the same preamble: `op_id` prefix binding (§3), dedup replay with the stored
 * outcome (§7.1) and a per-(user, resource) `resource_seq` compare-and-set
 * (§6). The cache keys are the gateway's, so REST and WS share one sequence
 * space per resource.
 */
class ChannelMs extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('./database/channel-db').IChannelDB} */
    this.db = context.channelDb;
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
    this.memCache = context.memCache;
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
          kind: Joi.string().valid('one_to_one', 'group').required(),
          name: Joi.string().allow(null, ''),
          avatar_url: Joi.string().allow(null, ''),
          members: Joi.array().items(USER_ID).min(1).max(MAX_MEMBERS).required(),
          // AUTH_CONTRACT §2.5 — one_to_one only, gates the username key.
          initiatedVia: Joi.string().valid('phone', 'username'),
          usernameKey: Joi.string().pattern(/^\d{4}$/)
        })
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

  /** §6 — `resource_seq` must be exactly last + 1 for (user_id, resource). */
  async inOrder(user, resourceId, seq) {
    return this.memCache.casNext(`seq:${user}:${resourceId}`, seq, SEQ_TTL_SEC);
  }

  /** Remember an outcome so a replay of `op_id` repeats it verbatim (§7.1). */
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
      resource_seq: seq,
      channel_id: channelId,
      kind,
      name,
      avatar_url: avatarUrl,
      members,
      initiatedVia,
      usernameKey
    } = req.payload;

    const replay = await this.replayed(res, user, opId);
    if (replay) return replay;

    const roster = [...new Set([user, ...members])];
    if (!members.includes(user)) {
      return this.reject(res, user, opId, 403, 'forbidden', 'creator must be in members');
    }

    if (kind === 'one_to_one') {
      if (roster.length !== 2) {
        return this.reject(
          res, user, opId, 400, 'validation_failed', 'one_to_one needs exactly 2 members'
        );
      }
      const peer = roster.find((id) => id !== user);
      const gate = await this.usernameKeyGate(peer, initiatedVia, usernameKey);
      if (gate) {
        return this.reject(res, user, opId, 403, gate, 'target requires a matching username key');
      }
      // §11.3 — a DM that already exists is the same DM, not a collision.
      const existing = await this.db.findOneToOne(roster);
      if (existing) return this.accept(res, user, opId, 200, channelView(existing));
    }

    if (!(await this.inOrder(user, channelId, seq))) {
      return this.reject(res, user, opId, 400, 'out_of_order', 'resource_seq skipped');
    }

    const channel = {
      channelId,
      kind,
      name: kind === 'one_to_one' ? null : name || null,
      avatarUrl: avatarUrl || null,
      owner: user,
      initiatedVia: kind === 'one_to_one' ? initiatedVia || 'phone' : null,
      members: roster.map((id) => memberRow(id, id === user ? 'owner' : 'member')),
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

    return this.accept(res, user, opId, 201, channelView(created));
  }

  async addMembers(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId } = req.params;
    const { op_id: opId, resource_seq: seq, members } = req.payload;

    const replay = await this.replayed(res, user, opId);
    if (replay) return replay;

    const channel = await this.db.getChannelInfo(channelId);
    const denied = this.requireRole(channel, user, ['owner', 'admin']);
    if (denied) return this.reject(res, user, opId, denied.status, denied.code, denied.message);
    if (channel.kind === 'one_to_one') {
      return this.reject(res, user, opId, 403, 'forbidden', 'one_to_one membership is fixed');
    }

    const existing = memberIds(channel);
    const added = members.filter((id) => !existing.includes(id));
    if (existing.length + added.length > MAX_MEMBERS) {
      return this.reject(res, user, opId, 412, 'precondition_failed', 'group member cap exceeded');
    }

    if (!(await this.inOrder(user, channelId, seq))) {
      return this.reject(res, user, opId, 400, 'out_of_order', 'resource_seq skipped');
    }

    if (added.length) {
      await this.db.addMembers(channelId, added.map((id) => memberRow(id, 'member')));
      await this.fanout('CHANNEL_MEMBER_ADDED', channel, user, [...existing, ...added], {
        channelId,
        members: added,
        role: 'member',
        addedAtMs: Date.now()
      });
    }
    return this.accept(res, user, opId, 200, { member_count: existing.length + added.length });
  }

  async removeMember(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId, userId } = req.params;
    const { op_id: opId, resource_seq: seq } = req.payload;

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

    if (!(await this.inOrder(user, channelId, seq))) {
      return this.reject(res, user, opId, 400, 'out_of_order', 'resource_seq skipped');
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
    const { op_id: opId, resource_seq: seq, role } = req.payload;

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

    if (!(await this.inOrder(user, channelId, seq))) {
      return this.reject(res, user, opId, 400, 'out_of_order', 'resource_seq skipped');
    }

    await this.db.setMemberRole(channelId, userId, role);
    await this.announceRole(channel, user, userId, role, memberIds(channel));
    return this.accept(res, user, opId, 200, { user_id: userId, role });
  }

  async editChannel(req, res) {
    const user = extractInfoFromRequest(req);
    const { channelId } = req.params;
    const { op_id: opId, resource_seq: seq, name, avatar_url: avatarUrl } = req.payload;

    const replay = await this.replayed(res, user, opId);
    if (replay) return replay;

    const channel = await this.db.getChannelInfo(channelId);
    const denied = this.requireRole(channel, user, ['owner', 'admin']);
    if (denied) return this.reject(res, user, opId, denied.status, denied.code, denied.message);

    if (!(await this.inOrder(user, channelId, seq))) {
      return this.reject(res, user, opId, 400, 'out_of_order', 'resource_seq skipped');
    }

    const updates = {};
    const event = { channelId, editedAtMs: Date.now() };
    if (name !== undefined) {
      updates.name = name;
      event.name = name;
    }
    if (avatarUrl !== undefined) {
      updates.avatarUrl = avatarUrl;
      event.avatarUrl = avatarUrl || '';
    }
    const updated = await this.db.updateChannel(channelId, updates);
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
    const { op_id: opId, resource_seq: seq } = req.payload;

    const replay = await this.replayed(res, user, opId);
    if (replay) return replay;

    const channel = await this.db.getChannelInfo(channelId);
    const denied = this.requireRole(channel, user, ['owner', 'admin', 'member']);
    if (denied) return this.reject(res, user, opId, denied.status, denied.code, denied.message);

    if (!(await this.inOrder(user, channelId, seq))) {
      return this.reject(res, user, opId, 400, 'out_of_order', 'resource_seq skipped');
    }

    if (roleOf(channel, user) !== 'owner') {
      await this.leave(channel, user, user);
      return this.accept(res, user, opId, 200, { member_count: channel.members.length - 1 });
    }

    await this.db.deleteChannel(channelId);
    await this.fanout('CHANNEL_DELETED', channel, user, memberIds(channel), {
      channelId,
      deletedAtMs: Date.now()
    });
    return this.accept(res, user, opId, 204, null);
  }

  // ---- reads -------------------------------------------------------------

  async getChannels(req) {
    const user = extractInfoFromRequest(req);
    const channels = await this.db.getMemberChannels(user, req.query.kind || null);
    return channels.map(channelView);
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
    return req.internal ? channel : channelView(channel);
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
   * AUTH_CONTRACT.md §2.5 / §7.6 — a username-initiated DM against a keyed
   * user must present the matching key. Phone-matched contacts bypass it.
   * @returns {Promise<string|null>} the error code, or null when allowed
   */
  async usernameKeyGate(peer, initiatedVia, usernameKey) {
    if (initiatedVia !== 'username') return null;
    const hash = await this.db.usernameKeyHash(peer);
    if (!hash) return null;
    if (!usernameKey || !(await verifySecret(usernameKey, hash))) {
      return 'USERNAME_KEY_REQUIRED';
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
  async fanout(type, channel, actor, recipients, body) {
    const { newMessageTopic } = this.options;
    const channelId = channel.channelId || body.channelId;
    const deliverySequence = await this.memCache.incr(`dseq:${channelId}`);
    const event = channelServerEvent(type, body, {
      channelId,
      actor,
      recipients,
      deliverySequence
    });
    await this.eventStore.emit(newMessageTopic, event, channelId);
  }

  async shutdown() {
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
