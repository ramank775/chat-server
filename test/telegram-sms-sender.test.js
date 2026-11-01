const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Implementation: TelegramSender } = require('../services/profile-ms/auth-provider/sms-sender/telegram-sms-sender');
const { SmsGatewayError } = require('../services/profile-ms/auth-provider/sms-sender/sms-sender');

test('telegram sender posts phone and code to the chat, and never logs the code', async () => {
  const requests = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(status, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const logs = [];
  const log = { warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const options = {
    telegramApiUrl: `http://127.0.0.1:${server.address().port}`,
    telegramBotToken: '123:abc',
    telegramChatId: '42'
  };
  try {
    const sender = new TelegramSender({ options, log });
    await sender.init();
    await sender.send({ phone: '+919000000001', code: '493817' });
    assert.deepEqual(requests, [{
      url: '/bot123:abc/sendMessage',
      body: { chat_id: '42', text: '+919000000001: 493817' }
    }]);

    status = 400;
    await assert.rejects(sender.send({ phone: '+919000000001', code: '493817' }), SmsGatewayError);
    assert.ok(logs.length >= 2);
    assert.ok(logs.every((m) => !m.includes('493817') && !m.includes('123:abc')));

    assert.throws(() => new TelegramSender({ options: { ...options, telegramChatId: '' }, log }), /TELEGRAM_CHAT_ID/);
  } finally {
    server.close();
  }
});
