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
   * SYNC_PROTOCOL.md §6a.3 step 3 — is `userId` a member of `channelId`?
   * Covers one_to_one and group channels alike; both are channel-ms rows.
   * Cached briefly because every inbound envelope asks.
   * @param {string} channelId
   * @param {string} userId
   */
  async isMember(channelId, userId) {
    const cached = this._membership.get(channelId);
    if (cached && cached.expiry > Date.now()) {
      return cached.members.has(userId);
    }
    const channel = await this.getChannelInfo(channelId);
    // channel-ms returns only the active roster (removed members are
    // tombstoned, not listed). The fallback chain tolerates a v2 row.
    const members = new Set(
      (channel?.members || []).map((member) => member.user_id ?? member.username ?? member)
    );
    if (this._membership.size >= MEMBERSHIP_CACHE_MAX) this._membership.clear();
    this._membership.set(channelId, { members, expiry: Date.now() + this._membershipTtlMs });
    return members.has(userId);
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
