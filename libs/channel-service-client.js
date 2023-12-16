const { HttpClient } = require('./http-client');

class ChannelServiceClient {
  constructor(options) {
    this._client = new HttpClient(options.channelMsEndpoint)
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
}

function addChannelServiceClientOptions(cmd) {
  cmd = cmd.option('--channel-ms-endpoint <channel-ms-endpoint>', 'Base url for channel service')
  return cmd;
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
