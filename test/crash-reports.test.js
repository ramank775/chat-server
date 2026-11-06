const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startProfileMs, signupWithUsername, bearer } = require('./helpers/profile-ms');

/**
 * Decision 214's replacement for Sentry: an opt-in report from the app is
 * stored without who sent it, checked for size, limited per account, and
 * swept after the retention.
 */
describe('crash reports', () => {
  /** @type {Awaited<ReturnType<typeof startProfileMs>>} */
  let app;
  let asha;

  before(async () => {
    app = await startProfileMs('profile_ms_test_crash');
    asha = await signupWithUsername(app, { phone: '+919300000101', username: 'cr_asha' });
  });

  after(async () => {
    await app.stop();
  });

  const report = {
    at: Date.now(),
    kind: 'dart',
    build: '3.0.0+90',
    android: '7.0 (API 24)',
    model: 'Xiaomi Redmi 4',
    trace: '_TypeError\n#0      ChatScreen.build (package:vartalap/screens/chat/chat.dart:120)'
  };
  const send = (payload, headers = bearer(asha.accesskey)) =>
    app.inject({ method: 'POST', url: '/crash-reports', headers, payload });
  const stored = async () => {
    const { db } = app.server.crashReports;
    return db.reports
      ? db.reports.find({}).toArray()
      : (await db.pool.query('SELECT * FROM crash_reports')).rows;
  };

  test('a report is kept without its sender, checked, limited and swept', async () => {
    assert.equal((await send(report)).statusCode, 204);
    const [row] = await stored();
    assert.equal(row.trace, report.trace);
    assert.equal(row.model, report.model);
    assert.ok(!JSON.stringify(row).includes(asha.user_id), 'not who sent it');

    assert.equal((await send(report, {})).statusCode, 401);
    assert.equal((await send({ ...report, trace: 'x'.repeat(16001) })).statusCode, 400);
    assert.equal((await send({ ...report, body: 'hello' })).statusCode, 400, 'nothing else');

    const codes = [];
    for (let i = 1; i < 21; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      codes.push((await send(report)).statusCode);
    }
    assert.deepEqual(codes.slice(-2), [204, 429], '20 a day per account');

    await app.server.crashReports.sweep(Date.now() + 29 * 24 * 60 * 60 * 1000);
    assert.equal((await stored()).length, 20);
    await app.server.crashReports.sweep(Date.now() + 31 * 24 * 60 * 60 * 1000);
    assert.deepEqual(await stored(), []);
  });
});
