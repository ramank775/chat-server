const axios = require('axios');
const {
  ISmsSender,
  SmsGatewayError,
  SmsGatewayUnavailableError
} = require('./sms-sender');

/**
 * Testing only (decision 203): each code goes to the operator's Telegram chat
 * through a bot instead of an SMS, and the operator passes it on. No SIM
 * needed. Launch runs sms-gate-app. Never logs the code.
 * https://core.telegram.org/bots/api#sendmessage
 */
class TelegramSmsSender extends ISmsSender {
  #client;

  #chatId;

  #log;

  constructor(context) {
    super();
    const { telegramApiUrl, telegramBotToken, telegramChatId } = context.options;
    if (!telegramBotToken || !telegramChatId) {
      throw new Error('telegram needs --telegram-bot-token and --telegram-chat-id (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)');
    }
    this.#chatId = telegramChatId;
    this.#log = context.log;
    this.#client = axios.create({
      baseURL: `${telegramApiUrl}/bot${telegramBotToken}`,
      timeout: 10000
    });
  }

  async init() {
    this.#log.warn('--sms-sender=telegram: OTP codes go to the Telegram chat, not by SMS. Testing only.');
  }

  async send({ phone, code }) {
    try {
      await this.#client.post('/sendMessage', { chat_id: this.#chatId, text: `${phone}: ${code}` });
    } catch (error) {
      const status = error.response && error.response.status;
      // the message only: error.config carries the bot token
      this.#log.error(`telegram send failed (status ${status}): ${error.message}`);
      if (status && status >= 400 && status < 500) {
        throw new SmsGatewayError(`telegram rejected the message (${status})`);
      }
      throw new SmsGatewayUnavailableError(`telegram unreachable: ${error.message}`);
    }
  }
}

function addOptions(cmd) {
  return cmd
    .option('--telegram-api-url <url>', 'Telegram Bot API base url', 'https://api.telegram.org')
    .option('--telegram-bot-token <token>', 'bot token from @BotFather')
    .option('--telegram-chat-id <id>', 'chat the codes go to');
}

module.exports = {
  code: 'telegram',
  addOptions,
  Implementation: TelegramSmsSender
};
