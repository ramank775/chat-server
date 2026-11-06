const Joi = require('joi');
const { initMongoClient } = require('../../libs/mongo-utils');
const { initPgPool, ensureSchema } = require('../../libs/pg-utils');

/**
 * The app's own crash reports, in place of Sentry (decision 214). Opt-in on
 * the phone; a report is the app build, Android version, device model, what
 * failed (its type and stack frames, never its message text) and when. Not
 * who sent it: the account is used for the rate limit only. Kept
 * `--crash-report-days`, then swept. Operators read them with psql or
 * mongosh (deployment/README.md, "Crash reports").
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const PER_USER_DAY = 20;

const reportSchema = Joi.object({
  at: Joi.number().integer().min(0).required(),
  kind: Joi.string().valid('dart', 'android').required(),
  build: Joi.string().max(40).required(),
  android: Joi.string().max(40).required(),
  model: Joi.string().max(80).required(),
  trace: Joi.string().max(16000).required()
}).required();

function addCrashReportOptions(cmd) {
  return cmd.option(
    '--crash-report-days <days>',
    'Delete a crash report this many days after it came in',
    (c) => Number(c),
    30
  );
}

/** Mongo collection `crash_reports`, as `reports`. */
function mongoStore(context) {
  const client = initMongoClient(context);
  return {
    async init() {
      await client.connect();
      this.reports = client.db().collection('crash_reports');
      await this.reports.createIndex({ receivedAt: 1 });
    },
    async insert(report) {
      await this.reports.insertOne({ ...report });
    },
    async deleteBefore(cutoff) {
      await this.reports.deleteMany({ receivedAt: { $lt: cutoff } });
    }
  };
}

function pgStore(context) {
  const pool = initPgPool(context);
  return {
    pool,
    init: () => ensureSchema(pool, `
      CREATE TABLE IF NOT EXISTS crash_reports (
        received_at timestamptz NOT NULL,
        at timestamptz NOT NULL,
        kind text NOT NULL,
        build text NOT NULL,
        android text NOT NULL,
        model text NOT NULL,
        trace text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS crash_reports_received ON crash_reports (received_at);
    `),
    async insert({ receivedAt, at, kind, build, android, model, trace }) {
      await pool.query(
        `INSERT INTO crash_reports (received_at, at, kind, build, android, model, trace)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [receivedAt, at, kind, build, android, model, trace]
      );
    },
    async deleteBefore(cutoff) {
      await pool.query('DELETE FROM crash_reports WHERE received_at < $1', [cutoff]);
    }
  };
}

class CrashReports {
  /** @param {import('./profile-ms').ProfileMs} service */
  constructor(service) {
    this.service = service;
    this.options = service.options;
  }

  /** On the backend `--profile-db` picks, sharing its client. */
  async addRoutes() {
    const s = this.service;
    this.db = (this.options.profileDb === 'pg' ? pgStore : mongoStore)(s.context);
    await this.db.init();
    // ungated: a crash before the username is picked is reported too
    s.addRoute('/crash-reports', 'POST', s.guard(this.report.bind(this)), {
      pre: [s.authPre(false)],
      validate: { payload: reportSchema }
    });
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((error) => s.log.error(`Crash report sweep failed: ${error.message}`));
    }, SWEEP_EVERY_MS).unref();
  }

  stop() {
    clearInterval(this.sweepTimer);
  }

  async report(req, res) {
    const { user } = req.pre.auth;
    await this.service.rateLimit(`crash:${user.user_id}`, PER_USER_DAY, 86400, 'user');
    await this.db.insert({ ...req.payload, at: new Date(req.payload.at), receivedAt: new Date() });
    return res.response().code(204);
  }

  sweep(now = Date.now()) {
    return this.db.deleteBefore(new Date(now - this.options.crashReportDays * DAY_MS));
  }
}

module.exports = { CrashReports, addCrashReportOptions };
