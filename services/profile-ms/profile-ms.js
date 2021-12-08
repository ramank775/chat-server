const {
    initDefaultOptions,
    initDefaultResources,
    addStandardHttpOptions,
    resolveEnvVariables
  } = require('../../libs/service-base'),
  { HttpServiceBase } = require('../../libs/http-service-base'),
  { addMongodbOptions, initMongoClient } = require('../../libs/mongo-utils'),
  kafka = require('../../libs/kafka-utils'),
  { uuidv4, extractInfoFromRequest } = require('../../helper'),
  admin = require('firebase-admin'),
  asMain = require.main === module;

function firebaseProjectOptions(cmd) {
  return cmd.option('--firebase-project-id <firebaseProjectId>', 'Firebase Project Id');
}

async function initFirebaseAdmin(context) {
  const { options } = context;
  const app = admin.initializeApp({
    projectId: options.firebaseProjectId
  });
  context.firebaseApp = app;
  context.firebaseAuth = app.auth();
  return context;
}

async function initAccessKeyCache(context) {
  const authCollection = context.mongodbClient.collection('session_auth');
  const cache = {};
  cache.get = async (username) => {
    const accesskey = cache[username];
    if (!accesskey) {
      const auth = await authCollection.findOne(
        { username },
        { projection: { _id: 0, username: 1, accesskey: 1 } }
      );
      if (auth) {
        cache[username] = auth.accesskey;
      }
    }
    return cache[username];
  };
  cache.create = async (username) => {
    const newAccessKey = uuidv4();
    const newAuthDoc = {
      username,
      accesskey: newAccessKey,
      updatedOn: new Date()
    };
    await authCollection.updateOne(
      { username },
      {
        $set: newAuthDoc,
        $setOnInsert: {
          addedOn: new Date()
        }
      },
      {
        upsert: true
      }
    );
    cache[username] = newAccessKey;
    return newAccessKey;
  };
  context.accessKeyProvider = cache;
  return context;
}

function parseOptions(argv) {
  let cmd = initDefaultOptions();
  cmd = addStandardHttpOptions(cmd);
  cmd = addMongodbOptions(cmd);
  cmd = firebaseProjectOptions(cmd);
  cmd = kafka.addStandardKafkaOptions(cmd);
  cmd = kafka.addKafkaSSLOptions(cmd);
  cmd.option('--new-login-topic <new-login-topic>', 'New login topic used to produce new login events');
  return cmd.parse(argv).opts();
}

async function initResource(options) {
  return await initDefaultResources(options)
    .then(initMongoClient)
    .then(initFirebaseAdmin)
    .then(kafka.initEventProducer)
    .then(initAccessKeyCache);
}

class ProfileMs extends HttpServiceBase {
  constructor(context) {
    super(context);
    this.mongoClient = context.mongoClient;
    this.profileCollection = context.mongodbClient.collection('profile');
    this.firebaseAuth = context.firebaseAuth;
    this.newLoginTopic = this.options.newLoginTopic;
    this.publisher = context.publisher;
    this.accessKeyProvider = context.accessKeyProvider;
  }

  async init() {
    await super.init();

    this.addRoute('/auth', ['GET', 'POST'], async (req, res) => {
      const username = extractInfoFromRequest(req, 'user');
      const accesskey = extractInfoFromRequest(req, 'accesskey');
      const token = extractInfoFromRequest(req, 'token');
      const accessKeyDb = await this.accessKeyProvider.get(username);
      if (accesskey != accessKeyDb) {
        return res.response({}).code(401);
      }
      try {
        await this.verify(token);
      } catch (error) {
        this.log.error(`Error while authentication : ${error}`);
        return res.response({}).code(401);
      }
      return res.response({}).code(200);
    });

    this.addRoute('/login', 'POST', async (req, res) => {
      const { payload } = req;
      const { username } = payload;
      const token = extractInfoFromRequest(req, 'token');
      let isNew = false;
      let result;
      try {
        result = await this.verify(token);
      } catch (error) {
        this.log.error(`Error while authentication : ${error}`);
        return res.response({}).code(401);
      }
      const isExist = await this.isExists(username);
      if (!isExist) {
        isNew = true;
        const profile = {
          username,
          uid: result.uid,
          addedOn: new Date(),
          isActive: true
        };
        await this.profileCollection.insertOne(profile);
      }
      const accesskey = await this.accessKeyProvider.create(username);
      this.publisher.send(this.newLoginTopic, payload, username);
      return {
        status: true,
        username,
        accesskey,
        isNew
      };
    });

    this.addRoute('/get', 'GET', async (req) => {
      const username = extractInfoFromRequest(req);
      if (!username) {
        return {};
      }
      let user = await this.profileCollection.findOne(
        { username, isActive: true },
        { projection: { _id: 0, name: 1, username: 1 } }
      );
      return user || {};
    });

    this.addRoute('/user/sync', 'POST', async (req) => {
      const username = extractInfoFromRequest(req);
      const { users = [] } = req.payload;
      const availableUsers = await this.profileCollection
        .find({ username: { $in: users }, isActive: true }, { projection: { _id: 0, username: 1 } })
        .toArray();
      const result = {};
      availableUsers.forEach((u) => {
        result[u.username] = true;
      });
      await this.profileCollection.updateOne(
        { username: username },
        { $set: { syncAt: new Date() } }
      );
      return result || {};
    });
  }

  async isExists(username) {
    const count = await this.profileCollection.countDocuments({ username });
    return count > 0;
  }

  async verify(accesskey) {
    if (this.options.debug && accesskey == 'test') {
      return { uid: uuidv4() };
    }
    const decodedToken = await this.firebaseAuth.verifyIdToken(accesskey);
    return decodedToken;
  }

  async shutdown() {
    await super.shutdown();
    await this.context.mongoClient.close();
  }
}

if (asMain) {
  const argv = resolveEnvVariables(process.argv);
  const options = parseOptions(argv);
  initResource(options)
    .then(async (context) => {
      await new ProfileMs(context).run();
    })
    .catch(async (error) => {
      console.error('Failed to initialized Profile MS', error);
      process.exit(1);
    });
}
