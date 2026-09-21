const axios = require('axios');
const { IPushNotificationService } = require("./pn-service");

/** Static wake payload (SYNC_PROTOCOL §12.1), never carries message content. */
const WAKE_TITLE = 'Vartalap';
const WAKE_BODY = 'New activity';

/**
 * Is the topic url served by the configured self hosted ntfy instance.
 * Guards against the server POSTing to an arbitrary host.
 * @param {string} topicUrl
 * @param {string} baseUrl
 * @returns {boolean}
 */
function isAllowedTopicUrl(topicUrl, baseUrl) {
  if (!topicUrl || !baseUrl) return false;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return topicUrl.startsWith(base) && topicUrl.length > base.length;
}

class NtfyPushNotificationService extends IPushNotificationService {

  #baseUrl;

  #logger;

  /** @type {import('axios').AxiosInstance} */
  #client;

  /**
   * ntfy push notification service
   * @param {*} context
   */
  constructor(context) {
    super(context);
    this.#baseUrl = context.options.ntfyBaseUrl;
    this.#logger = context.log;
    this.#client = context.ntfyClient || axios.create({ timeout: 5000 });
  }

  /**
   * Publish a wake notification on the recipient topic.
   * No message content is sent, the client drains the undelivered queue over WS.
   * @param {string} topicUrl
   */
  async push(topicUrl) {
    if (!isAllowedTopicUrl(topicUrl, this.#baseUrl)) {
      this.#logger.error(`Refusing to publish on an out of base url ntfy topic ${topicUrl}`);
      return;
    }
    await this.#client.post(topicUrl, WAKE_BODY, {
      headers: {
        Title: WAKE_TITLE,
        Priority: 'high'
      }
    });
  }
}

function addOptions(cmd) {
  cmd.option(
    '--ntfy-base-url <ntfy-base-url>',
    'Base url of the self hosted ntfy instance, a topic url must start with it'
  );
  return cmd;
}

module.exports = {
  code: 'ntfy',
  addOptions,
  isAllowedTopicUrl,
  Implementation: NtfyPushNotificationService,
  WAKE_TITLE,
  WAKE_BODY
}
