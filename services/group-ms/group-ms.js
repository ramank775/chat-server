const {
  initDefaultOptions,
  initDefaultResources,
  resolveEnvVariables
} = require('../../libs/service-base');
const { addHttpOptions, initHttpResource, HttpServiceBase } = require('../../libs/http-service-base');
const { shortuuid, extractInfoFromRequest } = require('../../helper');
const { formatMessage } = require('../../libs/message-utils');
const eventStore = require('../../libs/event-store');
const { addDatabaseOptions, initializeDatabase } = require('./database');

const asMain = require.main === module;

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addHttpOptions(cmd);
  cmd = addDatabaseOptions(cmd);
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd = cmd.option(
    '--new-group-message-topic <new-group-message-topic>',
    'Used by consumer to consume new group message for each new incoming message'
  );
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options)
    .then(initHttpResource)
    .then(initializeDatabase)
    .then(eventStore.initializeEventStore({ producer: true }));
}

class GroupMs extends HttpServiceBase {
  constructor(context) {
    super(context);
    /** @type {import('./database/group-db').IGroupDB} */
    this.db = context.groupDb;
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
    this.addRoute('/get', 'GET', this.getGroups.bind(this));

    /**
     * @deprecated
     * Route is deprecated in favour of new route `POST - /`
     * This will be removed in next major release @version v3.x
     */
    this.addRoute('/create', 'POST', this.createGroup.bind(this));

    this.addRoute('/', 'GET', this.getGroups.bind(this));

    this.addRoute('/', 'POST', this.createGroup.bind(this));

    this.addRoute('/{groupId}', 'GET', this.getGroupInfo.bind(this));

    /**
     * @deprecated
     * Route in depreceated in favour for new route `POST /:group_id/members`
     * This will be removed in next major release @version v3.x
     */
    this.addRoute('/{groupId}/add', 'POST', this.addMembers.bind(this));

    /**
     * @deprecated
     * Route in depreceated in favour for new route `DELETE /:group_id/members`
     * This will be removed in next major release @version v3.x
     */
    this.addRoute('/{groupId}/remove', 'POST', this.removeMembers.bind(this));

    this.addRoute('/{groupId}/members', 'POST', this.addMembers.bind(this));
    this.addRoute('/{groupId}/members', 'DELETE', this.removeMembers.bind(this));
  }

  async getGroups(req) {
    const user = extractInfoFromRequest(req, 'user');
    const groups = await this.db.getMemberGroups(user)
    return groups || [];
  }

  async getGroupInfo(req, res) {
    const user = extractInfoFromRequest(req, 'user');
    const { groupId } = req.params;
    const group = await this.db.getGroupInfo(groupId, user);
    if (!group) {
      return res.response({ status: false }).code(404);
    }
    return group;
  }

  async createGroup(req) {
    const { name, members, profilePic } = req.payload;
    const user = extractInfoFromRequest(req, 'user');
    const payload = {
      name,
      members: [],
      profilePic,
    };
    if (!members.includes(user)) {
      members.push(user);
    }
    members.forEach((member) => {
      payload.members.push({ username: member, role: member === user ? 'admin' : 'user' });
    });
    const groupId = await this.db.create(payload)
    this.sendNotification({
      from: user,
      to: members,
      groupId,
      action: 'add',
      body: {
        added: payload.members
      }
    });
    return {
      groupId
    };
  }

  async addMembers(req, res) {
    const user = extractInfoFromRequest(req, 'user');
    const { groupId } = req.params;
    const group = await this.db.getGroupInfo(groupId, user);
    if (!group) {
      return res.response({ status: false }).code(404);
    }
    const { members } = req.payload;
    if (!members || !members.length) {
      return {
        status: true
      };
    }
    const newMembers = members.map((member) => ({ username: member, role: 'user' }));
    await this.db.addMember(groupId, user, newMembers);
    const existingMembers = group.members.map((member) => member.username);
    const receivers = [...new Set(existingMembers.concat(members))];
    this.sendNotification({
      from: user,
      to: receivers,
      groupId,
      action: 'add',
      body: {
        added: newMembers
      }
    });
    return { status: true };
  }

  async removeMembers(req, res) {
    const user = extractInfoFromRequest(req, 'user');
    const { member } = req.payload;
    const { groupId } = req.params;
    const group = await this.db.getGroupInfo(groupId, user)
    if (!group) {
      return res.response({ status: false }).code(404);
    }
    const isSelf = user === member;
    const self = group.members.find((x) => x.username === user);
    if (!isSelf && self.role !== 'admin') {
      return {
        status: false
      };
    }

    await this.db.removeMember(groupId, user, [member]);

    if (isSelf && self.role === 'admin') {
      const admin = group.members.find((x) => x.username !== user && x.role === 'admin');
      if (!admin) {
        const nextAdmin = group.members.find((x) => x.username !== user);
        if (nextAdmin) {
          nextAdmin.role = 'admin';
          await this.db.updateMemberRole(groupId, nextAdmin.username, nextAdmin.role);
        }
      }
    }
    this.sendNotification({
      from: user,
      to: group.members.map((u) => u.username),
      groupId,
      action: 'remove',
      body: {
        removed: [member]
      }
    });
    return {
      status: true
    };
  }

  /**
   * Send Group action update to all group members
   * @param {{from: string, to: string[], groupId: string, action: string; body: unknown}} notification
   */
  sendNotification(notification) {
    const { newGroupMessageTopic } = this.options;
    const payload = JSON.stringify({
      _v: 2.0,
      id: shortuuid(),
      meta: {
        createdAt: Date.now()
      },
      head: {
        type: 'group',
        to: notification.groupId,
        from: notification.from,
        chatId: notification.groupId,
        contentType: 'notification',
        action: notification.action
      },
      body: notification.body
    });
    const msg = {
      META: {
        from: notification.from,
        users: notification.to,
        rts: Date.now(),
        sid: shortuuid()
      },
      payload
    };
    const message = formatMessage(msg);
    this.eventStore.emit(newGroupMessageTopic, message, notification.from);
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
      await new GroupMs(context).run();
    })
    .catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialized Group MS', error);
      process.exit(1);
    });
}
