const Joi = require('joi');
const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const { extractInfoFromRequest, schemas } = require('../../helper');
const eventStore = require('../../libs/event-store');
const { addDatabaseOptions, initializeDatabase } = require('./database');
const { ChannelEvent } = require('./channel-event');

const asMain = require.main === module;

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = addDatabaseOptions(cmd);
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd = cmd.option(
    '--new-message-topic <new-message-topic>',
    'Used by producer to produce new message for system message'
  )
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options)
    .then(initHttpResource)
    .then(initializeDatabase)
    .then(eventStore.initializeEventStore({ producer: true }));
}

class ChannelMs extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('./database/channel-db').IChannelDB} */
    this.db = context.channelDb;
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
  }

  async init() {
    await super.init();

    /**
     * @deprecated
     * Route is deprecated in favour of new route `GET - /`
     * This will be removed in next major release @version v3.x
     */
    this.addRoute(
      '/get',
      'GET',
      this.getChannels.bind(this)
    );

    /**
     * @deprecated
     * Route is deprecated in favour of new route `POST - /`
     * This will be removed in next major release @version v3.x
     */
    this.addRoute(
      '/create',
      'POST',
      this.createChannel.bind(this)
    );

    /**
     * @deprecated
     * Route in depreceated in favour for new route `POST /:chanenl_id/members`
     * This will be removed in next major release @version v3.x
     */
    this.addRoute(
      '/{channelId}/add',
      'POST',
      this.addMembers.bind(this)
    );

    /**
     * @deprecated
     * Route in depreceated in favour for new route `DELETE /:channel_id/members`
     * This will be removed in next major release @version v3.x
     */
    this.addRoute(
      '/{channelId}/remove',
      'POST',
      this.removeMembers.bind(this)
    );

    this.addRoute(
      '/',
      'GET',
      this.getChannels.bind(this),
      {
        validate: {
          headers: schemas.authHeaders
        }
      }
    );

    this.addRoute(
      '/',
      'POST',
      this.createChannel.bind(this),
      {
        validate: {
          headers: schemas.authHeaders,
          payload: Joi.object({
            name: Joi.string().required(),
            type: Joi.string().required(),
            members: Joi.array().items(Joi.string()).max(100).required(),
            profilePic: Joi.string().allow(null)
          })
        }
      }
    );

    this.addRoute(
      '/{channelId}',
      'GET',
      this.getChannelInfo.bind(this),
      {
        validate: {
          headers: schemas.authHeaders,
          params: Joi.object({
            channelId: Joi.string().required()
          })
        }
      }
    );

    this.addRoute(
      '/{channelId}/members',
      'POST',
      this.addMembers.bind(this),
      {
        validate: {
          headers: schemas.authHeaders,
          params: Joi.object({
            channelId: Joi.string().required()
          }),
          payload: Joi.object({
            members: Joi.array().items(Joi.string()).max(50)
          })
        }
      }
    );

    this.addRoute(
      '/{channelId}/members',
      'DELETE',
      this.removeMembers.bind(this),
      {
        validate: {
          headers: schemas.authHeaders,
          params: Joi.object({
            channelId: Joi.string().required()
          }),
          payload: Joi.object({
            member: Joi.string()
          })
        }
      }
    );

    this.addInternalRoute(
      '/{channelId}',
      'GET',
      this.getChannelInfo.bind(this),
      {
        validate: {
          params: Joi.object({
            channelId: Joi.string().required(),
          })
        }
      }
    )
  }

  async getChannels(req) {
    const user = extractInfoFromRequest(req, 'user');
    const { type } = req.query;
    const channels = await this.db.getMemberChannels(user, type || 'group')
    return channels || [];
  }

  async getChannelInfo(req, res) {
    const user = extractInfoFromRequest(req, 'user');
    const { channelId } = req.params;
    const channel = await this.db.getChannelInfo(channelId, user);
    if (!channel) {
      return res.response({ status: false }).code(404);
    }
    return channel;
  }

  async createChannel(req) {
    const { name, type, members, profilePic } = req.payload;
    const user = extractInfoFromRequest(req, 'user');
    const payload = {
      name,
      type: type || 'group',
      members: [],
      profilePic,
    };
    if (!members.includes(user)) {
      members.push(user);
    }
    members.forEach((member) => {
      payload.members.push({
        username: member,
        role: member === user ? 'admin' : 'user',
        since: Date.now()
      });
    });
    const channelId = await this.db.create(payload)
    const event = new ChannelEvent(channelId, 'add', user)
    event.newMembers(payload.members)
    this.sendNotification(event, members);
    return {
      groupId: channelId,
      channelId
    };
  }

  async addMembers(req, res) {
    const user = extractInfoFromRequest(req, 'user');
    const { channelId } = req.params;
    const channel = await this.db.getChannelInfo(channelId, user);
    if (!channel) {
      return res.response({ status: false }).code(404);
    }
    const { members } = req.payload;
    if (!members || !members.length) {
      return {
        status: true
      };
    }
    const newMembers = members.map((member) => ({
      username: member,
      role: 'user',
      since: Date.now()
    }));
    await this.db.addMember(channelId, newMembers);
    const existingMembers = channel.members.map((member) => member.username);
    const receivers = [...new Set(existingMembers.concat(members))];
    const event = new ChannelEvent(channelId, 'add', user);
    event.newMembers(newMembers)
    event.set_recipients(receivers)
    this.sendNotification(event);
    return { status: true };
  }

  async removeMembers(req, res) {
    const user = extractInfoFromRequest(req, 'user');
    const { member } = req.payload;
    const { channelId } = req.params;
    const channel = await this.db.getChannelInfo(channelId, user)
    if (!channel) {
      return res.response({ status: false }).code(404);
    }
    const isSelf = user === member;
    const self = channel.members.find((x) => x.username === user);
    if (!isSelf && self.role !== 'admin') {
      return {
        status: false
      };
    }

    await this.db.removeMember(channelId, [member]);

    if (isSelf && self.role === 'admin') {
      const admin = channel.members.find((x) => x.username !== user && x.role === 'admin');
      if (!admin) {
        const nextAdmin = channel.members.find((x) => x.username !== user);
        if (nextAdmin) {
          nextAdmin.role = 'admin';
          await this.db.updateMemberRole(channelId, nextAdmin.username, nextAdmin.role);
        }
      }
    }
    const event = new ChannelEvent(channelId, 'remove', user);
    event.removedMembers([member]);
    event.set_recipients(channel.members.map((u) => u.username));
    this.sendNotification(event);
    return {
      status: true
    };
  }

  /**
   * Send Channel action update to all channel members
   * @param {ChannelEvent} notification
   * @param {string[]} receivers
   */
  async sendNotification(notification) {
    const { newMessageTopic } = this.options;
    await this.eventStore.emit(newMessageTopic, notification, notification.id);
  }

  async shutdown() {
    await super.shutdown();
    await this.db.dispose();
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
