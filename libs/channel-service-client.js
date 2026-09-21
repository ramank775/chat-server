const { HttpClient } = require('./http-client');

/** ponytail: flat Map + flush-when-full. Swap for an LRU if the flush ever shows up in latency. */
const MEMBERSHIP_CACHE_MAX = 10000;

class ChannelServiceClient {
  /** @type {Map<string, {members: Set<string>, expiry: number}>} */
  _membership = new Map();

  constructor(options) {
    this._client = new HttpClient(options.channelMsEndpoint)
    this._membershipTtlMs = (options.channelMembershipCacheSec || 30) * 1000;
  }

  async getChannelInfo(channelId) {
    try {
      const channel = await this._client.get(`/_internal/${channelId}`);
      return channel;
    } catch (e) {
      if (e.code === 'ERR_BAD_REQUEST') {
        return null;
      }
      throw new Error(e.message || e);
    }
  }

  /**
   * SYNC_PROTOCOL.md §10.3 step 1 — every member of `channelId`, the fanout
   * set message-delivery works from. Covers one_to_one and group channels
   * alike; both are channel-ms rows. Cached briefly because every inbound
   * envelope asks.
   * @param {string} channelId
   * @returns {Promise<Set<string>>} empty when the channel is gone
   */
  async members(channelId) {
    const cached = this._membership.get(channelId);
    if (cached && cached.expiry > Date.now()) {
      return cached.members;
    }
    const channel = await this.getChannelInfo(channelId);
    // ponytail: channel-ms still stores members as `{username}`; v3 step 3.4
    // renames that field to user_id, hence the fallback chain.
    const members = new Set(
      (channel?.members || []).map((member) => member.user_id ?? member.username ?? member)
    );
    if (this._membership.size >= MEMBERSHIP_CACHE_MAX) this._membership.clear();
    this._membership.set(channelId, { members, expiry: Date.now() + this._membershipTtlMs });
    return members;
  }

  /**
   * SYNC_PROTOCOL.md §6a.3 step 3 — is `userId` a member of `channelId`?
   * @param {string} channelId
   * @param {string} userId
   */
  async isMember(channelId, userId) {
    return (await this.members(channelId)).has(userId);
  }

  /** Drop the cached membership for a channel (channel-ms fanout tells us it changed). */
  invalidate(channelId) {
    this._membership.delete(channelId);
  }
}

function addChannelServiceClientOptions(cmd) {
  cmd = cmd
    .option('--channel-ms-endpoint <channel-ms-endpoint>', 'Base url for channel service')
    .option(
      '--channel-membership-cache-sec <channel-membership-cache-sec>',
      'How long a channel membership lookup stays cached',
      (value) => Number(value),
      30
    )
  return cmd
}

async function initChannelServiceClient(context) {
  const { options } = context;
  context.channelServiceClient = new ChannelServiceClient(options);
  return context;
}

module.exports = {
  ChannelServiceClient,
  addOptions: addChannelServiceClientOptions,
  init: initChannelServiceClient,
}
