const { initDefaultOptions, initDefaultResources, addStandardHttpOptions, resolveEnvVariables } = require('../../libs/service-base'),
  { HttpServiceBase } = require('../../libs/http-service-base'),
  { addMongodbOptions, initMongoClient } = require('../../libs/mongo-utils'),
  { uuidv4, extractInfoFromRequest } = require('../../helper'),
  { formatMessage } = require('../../libs/message-utils'),
  kafka = require('../../libs/kafka-utils'),
  asMain = require.main === module;

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addStandardHttpOptions(cmd);
  cmd = addMongodbOptions(cmd);
  cmd = kafka.addStandardKafkaOptions(cmd);
  cmd = kafka.addKafkaSSLOptions(cmd);
  cmd = cmd.option('--kafka-new-group-message-topic <new-group-message-topic>', 'Used by consumer to consume new group message for each new incoming message');
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options).then(initMongoClient).then(kafka.initEventProducer);
}

class GroupMs extends HttpServiceBase {

  constructor(context) {
    super(context);
    this.mongoClient = context.mongoClient;
    this.groupCollection = context.mongodbClient.collection('groups');
    this.publisher = this.context.publisher;
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
        addedOn: new Date().toUTCString()
      };
      if (members.indexOf(user) == -1) {
        members.push(user);
      }
      members.forEach((member) => {
        payload.members.push({ username: member, role: member === user ? 'admin' : 'user' });
      });
      await this.groupCollection.insertOne(payload);
      this.sendNotification({
        sender: user,
        receivers: members,
        groupId: payload.groupId,
        module: 'group',
        action: 'add'
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
      if (!members) {
        return {
          status: true
        };
      }
      const newMembers = members.map((member) => ({ username: member, role: 'user' }));
      await this.groupCollection.updateOne({ _id: group._id }, { $addToSet: { members: { $each: newMembers } } });
      this.sendNotification({
        sender: user,
        receivers: members,
        groupId: groupId,
        module: 'group',
        action: 'add'
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
            await this.groupCollection.updateOne({ _id: group._id, 'members.username': nextAdmin.username }, { $set: { 'members.$.role': 'admin' } });
          }
        }
      }
      this.sendNotification({
        sender: user,
        receivers: group.members.map((u) => u.username),
        groupId: groupId,
        module: 'group',
        action: 'remove'
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

  sendNotification(notification) {
    const { kafkaNewGroupMessageTopic } = this.options;
    const { sender, receivers, groupId, ...body } = notification;
    const type = 'group';
    body.from = sender;
    body.to = groupId;
    body.type = 'notification';
    body.text = ''; // Added just to make app works fine TODO: remove this when current version of app is killed
    const payload = {
      META: {
        to: groupId,
        users: receivers,
        from: sender,
        category: 'notification',
        chatType: type
      },
      payload: JSON.stringify(body)
    };
    const message = formatMessage(payload);
    this.publisher.send(kafkaNewGroupMessageTopic, message, sender);
  }
  async shutdown() {
    await super.shutdown();
    await this.context.mongoClient.close();
    await this.publisher.disconnect();
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
      console.error('Failed to initialized Group MS', error);
      process.exit(1);
    });
}
