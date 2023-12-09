const { HttpClient } = require('./http-client');

class ChannelServiceClient {
  constructor(options) {
    this._client = new HttpClient(options.channelMsEndpoint)
  }

  async getChannelInfo(channelId) {
    const { members } = await this._client.get(`/${channelId}`);
    return members;
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
