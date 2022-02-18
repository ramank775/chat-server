const {
  initDefaultOptions,
  initDefaultResources,
  addStandardHttpOptions,
  resolveEnvVariables
} = require('../../libs/service-base');
const { HttpServiceBase } = require('../../libs/http-service-base');
const { addMongodbOptions, initMongoClient } = require('../../libs/mongo-utils');
const { uuidv4, shortuuid, extractInfoFromRequest } = require('../../helper');
const { formatMessage } = require('../../libs/message-utils');
const eventStore = require('../../libs/event-store');

const asMain = require.main === module;

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addStandardHttpOptions(cmd);
  cmd = addMongodbOptions(cmd);
  cmd = eventStore.addEventStoreOptions(cmd);
  cmd = cmd.option(
    '--new-group-message-topic <new-group-message-topic>',
    'Used by consumer to consume new group message for each new incoming message'
  );
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options)
    .then(initMongoClient)
    .then(eventStore.initializeEventStore({ producer: true }));
}

class GroupMs extends HttpServiceBase {
  constructor(context) {
    super(context);
    this.mongoClient = context.mongoClient;
    this.groupCollection = context.mongodbClient.collection('groups');
    /** @type {import('../../libs/event-store/iEventStore').IEventStore} */
    this.eventStore = this.context.eventStore;
  }

  async init() {
    await super.init();
    this.addRoute('/create', 'POST', async (req, _) => {
      const { name, members, profilePic } = req.payload;
      const user = extractInfoFromRequest(req, 'user');
      const payload = {
        groupId: uuidv4(),
        name,
        members: [],
        profilePic,
        addedOn: new Date()
      };
      if (!members.includes(user)) {
        members.push(user);
      }
      members.forEach((member) => {
        payload.members.push({ username: member, role: member === user ? 'admin' : 'user' });
      });
      await this.groupCollection.insertOne(payload);
      this.sendNotification({
        from: user,
        to: members,
        groupId: payload.groupId,
        action: 'add',
        body: {
          added: payload.members
        }
      });
      return {
        groupId: payload.groupId
      };
    });

    this.addRoute('/{groupId}/add', 'POST', async (req, res) => {
      const user = extractInfoFromRequest(req, 'user');
      const { groupId } = req.params;
      const group = await this.groupCollection.findOne({ groupId, 'members.username': user });
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
      await this.groupCollection.updateOne(
        { _id: group._id },
        { $addToSet: { members: { $each: newMembers } } }
      );
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
    });

    this.addRoute('/{groupId}/remove', 'POST', async (req, res) => {
      const user = extractInfoFromRequest(req, 'user');
      const { member } = req.payload;
      const { groupId } = req.params;
      const group = await this.groupCollection.findOne({ groupId, 'members.username': user });
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
      const query = {
        $pull: { members: { username: member } }
      };

      await this.groupCollection.updateOne({ _id: group._id }, query);

      if (isSelf && self.role === 'admin') {
        const admin = group.members.find((x) => x.username !== user && x.role === 'admin');
        if (!admin) {
          const nextAdmin = group.members.find((x) => x.username !== user);
          if (nextAdmin) {
            nextAdmin.role = 'admin';
            await this.groupCollection.updateOne(
              { _id: group._id, 'members.username': nextAdmin.username },
              { $set: { 'members.$.role': 'admin' } }
            );
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
    });

    this.addRoute('/{groupId}', 'GET', async (req, res) => {
      const user = extractInfoFromRequest(req, 'user');
      const { groupId } = req.params;
      const group = await this.groupCollection.findOne(
        {
          groupId,
          'members.username': user
        },
        {
          projection: { _id: 0, groupId: 1, name: 1, members: 1, profilePic: 1 }
        }
      );
      if (!group) {
        return res.response({ status: false }).code(404);
      }
      return group;
    });

    this.addRoute('/get', 'GET', async (req) => {
      const user = extractInfoFromRequest(req, 'user');
      const groups = await this.groupCollection
        .find(
          { 'members.username': user },
          {
            projection: { _id: 0, groupId: 1, name: 1, members: 1, profilePic: 1 }
          }
        )
        .toArray();
      return groups || [];
    });
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
    await this.context.mongoClient.close();
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
