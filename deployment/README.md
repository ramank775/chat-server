# Chat server deployment

**Production (3.0) is `docker-compose.prod.yml`**: the monolith (every service in
one process) and Postgres, behind a TLS proxy: the host's own nginx
(`config/nginx/vartalap-host.conf`), or the bundled Caddy on a server where
nothing else owns ports 80 and 443. Photos, voice notes and files
live in a Cloudflare R2 bucket: the server only signs upload and download links,
and phones talk to R2 directly. Postgres is the only state on the server.

`docker-compose.monolith.yml` (with `.env.tmpl`) is the local development stack. The
microservice layout (`docker-compose.infra.yml` plus `docker-compose.yml`, and
`helm/`) stays supported (decision 191); see "Microservice layout" below.
Deploy 3.0 as the monolith.

## What you need

- A Linux server with Docker and the compose plugin, ports 80 and 443 open.
  2 vCPU and 4 GB RAM is plenty to start.
- A DNS record (A, and AAAA if the server has IPv6) for the API hostname
  pointing at the server. Release builds of the app use
  `vartalapapp.one9x.com` (`https://` for the API, `wss://…/wss` for the
  socket), proxied by Cloudflare (orange cloud) with the Cloudflare origin
  certificate on the server. The nginx site file takes the client's
  address from `CF-Connecting-IP`, for the per-IP OTP limits.
- A Cloudflare R2 bucket and an API token for it.
- An [sms-gate.app](https://sms-gate.app) account: an Android phone with a SIM
  running the SMS Gateway app in cloud mode. It sends the OTP texts. For
  testing without a SIM, see "Testing without a SIM".
- The release image on Docker Hub (see Releasing).

## First deploy

1. Get this directory onto the server, e.g. a sparse checkout:
   ```bash
   git clone --depth 1 --filter=blob:none --sparse -b v3.0 https://github.com/ramank775/chat-server
   cd chat-server && git sparse-checkout set deployment && cd deployment
   ```
2. **R2.**
   - In the Cloudflare dashboard, R2 › Create bucket (e.g. `vartalap`). Leave public access off.
   - R2 › Manage API tokens › Create: permission "Object Read & Write", scoped to that bucket. Note the access key id and secret.
   - The endpoint is `https://<account-id>.r2.cloudflarestorage.com` (account id on the R2 overview page).
   - No CORS rule is needed: the phones are not browsers.
3. **Settings.** `cp .env.prod.tmpl .env` and fill in every value. Compose
   refuses to start while a required one is empty.
   - `PG_PASSWORD`: `openssl rand -hex 24`.
   - `OTP_ENCRYPTION_KEY`: `openssl rand -hex 32`. Keep this outside the database,
     stable across restarts and shared by profile-service instances. It encrypts
     the OTP copy used by Resend; verification still checks the hash. Changing
     it prevents resending pending codes for up to 10 minutes; their original
     codes can still verify. This fresh release expects a new database schema.
   - `PHONE_PEPPER`: `openssl rand -hex 32`, generated on the server, never
     committed. See "Phone pepper" below before you ever touch it again.
   - VAPID keys: generate once and keep them. A new pair silences push on every installed phone until it re-registers.
     ```bash
     docker run --rm --entrypoint npx ramank775/chatserver:<tag> web-push generate-vapid-keys
     ```
   - `VAPID_SUBJECT`: `mailto:` plus an address push services can reach you at.
   - `FCM_SERVICE_ACCOUNT_KEY`: push for the Play Store build (decision 209).
     Firebase console › Project settings › Service accounts › Generate new
     private key, then `base64 -w0 <file>.json` into `.env` and delete the
     file. Empty means Play installs get no push. Push apps (UnifiedPush)
     use the VAPID keys above.
4. **Start.** `docker compose -f docker-compose.prod.yml up -d`. The app
   listens on `127.0.0.1:8000` only (`APP_PORT`).
   - **Host nginx** (the certificate at `/etc/nginx/cert/one9x.crt`): first
     remove any other site with the same `server_name`, then
     ```bash
     sudo cp config/nginx/vartalap-host.conf /etc/nginx/sites-available/vartalap
     sudo ln -s /etc/nginx/sites-available/vartalap /etc/nginx/sites-enabled/
     sudo nginx -t && sudo systemctl reload nginx
     ```
   - **Or Caddy**, when nothing else owns 80/443: `COMPOSE_PROFILES=caddy`
     in `.env` before `up -d`. It gets and renews the certificate itself.
5. **Check.**
   - `curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/v3.0/users/me` prints `401`: TLS works and the app answers.
   - Then, on a release build:
     - sign up with a real number (the OTP SMS arrives);
     - send a photo to a second phone and see it arrive (R2 upload and download);
     - kill the app on the second phone and message it again (push wake).

## Testing without a SIM

`SMS_SENDER=telegram` sends every OTP code to your own Telegram chat
instead of an SMS (decision 203). You pass it on to the tester. Nothing is
texted, and the server never logs codes.

1. In Telegram, message @BotFather, send `/newbot`, and keep the token it
   gives you.
2. Send any message to your new bot, then open
   `https://api.telegram.org/bot<token>/getUpdates` and note
   `"chat":{"id":…}`.
3. In `.env`: `SMS_SENDER=telegram`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
   The `SMS_GATE_*` values can stay empty.
4. `docker compose -f docker-compose.prod.yml up -d`. Each sign-in now posts
   `+91…: 123456` to that chat.

Before launch set `SMS_SENDER=sms-gate-app` with the `SMS_GATE_*` values
and run `up -d` again.

## Upgrading

Set `CHAT_SERVER_TAG` in `.env` to the new release, then:

```bash
docker compose -f docker-compose.prod.yml pull app
docker compose -f docker-compose.prod.yml up -d
```

Phones reconnect by themselves. Nothing is lost while the server is down: senders keep messages
queued, and what the server already acknowledged is in Postgres.

## Phone pepper

The server never stores a phone number (decision 223). It keeps
HMAC-SHA256(`PHONE_PEPPER`, SHA-256 of the number): login, contact lookup
and the "who can find me" lists all match on that, and the first start of a
release with it rewrites older rows the same way and drops the plain number.
Take a dump first (Backups): an older image cannot run on the rewritten
database, so going back means restoring that dump.

- Generate it once on the server (`openssl rand -hex 32`) into `.env`.
  Never commit it, never paste it anywhere else. Back it up with the
  database: a restored dump is useless without the pepper it was keyed with.
- **Rotation is not supported.** With the numbers gone, the server cannot
  re-key them: a new pepper would make every existing account unfindable
  and sign each returning user up as a new account. The database records a
  fingerprint of the pepper, and the app refuses to start with another one
  ("PHONE_PEPPER differs from the one this database was keyed with").
  If the pepper leaks, it alone reveals nothing; with a copy of the
  database it lets someone test numbers against the stored keys. A real
  rotation would need every user to log in again with an OTP, which hands
  the server the number to re-key; it is not built.

## Forcing an app update

Two `.env` values steer old apps (decision 192). Both are Android
versionCodes, the number after `+` in the app's `pubspec.yaml` version
(3.0.0+80 is 80). 0 turns each off.

- `LATEST_APP_BUILD`: apps below it show a dismissible "New version
  available" bar above the chat list.
- `MIN_APP_BUILD`: apps below it are refused (HTTP 426) and show only a
  "no longer supported" screen with an Update button. Raise it only once
  the new build is live on Play and on GitHub, or those users are stuck.
  At least 85, the first build on the byte wire (decision 218): an older
  build cannot talk to this server.

The Update button opens Play for Play installs and the GitHub release
otherwise. After editing `.env`, `docker compose -f docker-compose.prod.yml up -d`.

## Deleting an account by email

People who can't use the app ask at vartalap@one9x.org (decision 197). Do
it within 30 days of the email:

1. The email must give the @username and the phone number with its
   country code.
2. Text a 6-digit code (`shuf -i 100000-999999 -n 1`) to that number from
   the sms-gate phone's messaging app.
3. Go on only when the reply carries that code. Someone who no longer has
   the number must get it back from their carrier first.
4. Run this with the number and username from the email (`null`, unquoted,
   for an account that never picked a username). The server matches the
   number by its keyed hash; it has no plain numbers to search:

```bash
docker compose -f docker-compose.prod.yml exec app wget -qO- \
  --header 'content-type: application/json' \
  --post-data '{"phone":"+919876543210","username":"asha_k"}' \
  http://127.0.0.1:8000/_internal/users/delete
```

`{"status":true,"user_id":"..."}` means it's done, exactly like the in-app
delete. `server returned error: HTTP/1.1 404` means no account has that
number and username: check both against the email. Then reply that it's
done. The `/_internal` routes answer only inside the container.

## Reports

People report a user from Chat info in the app (decision 219), with the
chat's last 5 messages if they chose to send them (the server cannot read
chats, so this is all there is). There is no admin screen: read them from
Postgres, newest first. Each is kept 90 days, then deleted.

```bash
docker compose -f docker-compose.prod.yml exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d chat -c "SELECT id, created_at, reporter, reported,
     jsonb_pretty(messages) FROM reports ORDER BY created_at DESC LIMIT 20"'
```

`reporter` and `reported` are user ids; `GET /v3.0/users/{id}` (or the
`users` table) gives the username. Every message is `author`, `body`,
`content_type` and `sent_at` (ms). On the Mongo dev stack it is the
`reports` collection.

## Backups

Media is in R2: the server deletes a message file 30 days after it was
last sent; profile and group photos stay until replaced or the account is
deleted. Everything else (accounts, groups, the 30-day message timeline) is
in Postgres. Dump it daily, e.g. from cron in this directory, and keep 7 days:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d chat -Fc' \
  > backups/chat-$(date +%F).dump
find backups -name 'chat-*.dump' -mtime +7 -delete
```

Keep copies off the server too, with `sync` so old dumps go there as well
(e.g. `rclone sync backups r2:vartalap-backups`, a second bucket). The
privacy policy promises 7 days: deleted accounts live on in a dump until it
ages out. Restore into a running stack with:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d chat --clean --if-exists' \
  < backups/chat-<date>.dump
```

## Logs

`docker compose -f docker-compose.prod.yml logs -f app` (or `caddy`, `postgres`).
Each container keeps at most 5 × 50 MB.

## Crash reports

Phones send them only when their user agrees: a prompt after the app
closed unexpectedly or hit an error, or Settings › Privacy › Send crash
reports automatically. A report has the app build, Android version,
device model, the error's type and stack frames (no message text) and
when; not who sent it. They are kept 30 days (`--crash-report-days`), at
most 20 a day per account. The newest:

```bash
docker compose -f docker-compose.prod.yml exec postgres sh -c \
  'psql -U "$POSTGRES_USER" -d chat -c "SELECT at, kind, build, android, model,
     split_part(trace, chr(10), 1) AS error FROM crash_reports
     ORDER BY at DESC LIMIT 20"'
```

One in full: `... -x -c "SELECT * FROM crash_reports ORDER BY at DESC LIMIT 1"`.
How often each error comes, newest build first: `SELECT build,
split_part(trace, chr(10), 1), count(*) FROM crash_reports GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC`. On a Mongo stack:
`db.crash_reports.find().sort({ at: -1 }).limit(20)` in `mongosh`.

An `android` trace from a release build has R8's short class names: read
it with that build's `mapping.txt` (kept in the app's release artifact)
and `retrace mapping.txt trace.txt` from the Android SDK's cmdline-tools.

## Never in production

- The dev flags `--expose-dev-otp`, `PROFILE_DEV_FLAGS` and
  `--push-allow-private-endpoints`. The production compose file has none of
  them; don't add them.
- `SMS_SENDER=telegram` once real users sign up: their codes would go to
  your chat instead of their phones.
- The app port published beyond `127.0.0.1`, or a proxy that passes the
  client's own `X-Forwarded-For` through. The per-IP OTP limits trust the
  last hop, which only nginx (`$remote_addr`) or Caddy may set.
- `-dev` image tags.

## Releasing

Push a `v*` tag and CI publishes `ramank775/chatserver:<tag>` to Docker Hub
(amd64 and arm64) once lint and tests pass:

```bash
git tag v3.0.0 && git push origin v3.0.0
```

## Microservice layout

One container per service behind nginx (`config/nginx/nginx.docker.conf`),
which runs the `/auth` check the monolith does in process. The event bus is
NATS, or Kafka (`EVENT_STORE=kafka`, `BROKER_LIST=kafka:9092` and
`--profile kafka`); the database mongo, or Postgres (`DB_BACKEND=pg` and
`--profile pg`). It needs an image newer than `v3.0.0-rc.4`.

```bash
CHAT_SERVER_TAG=<tag> docker compose -p vartalap-ms --env-file .env.tmpl \
  -f docker-compose.infra.yml -f docker-compose.yml up -d
CONFORMANCE_BASE_URL=http://localhost:8085 npm run test:conformance   # from the repo root
```

- `.env.tmpl` is a dev setup (mock SMS, dev OTP endpoint, MinIO). Anywhere
  real, set `OTP_ENCRYPTION_KEY` and `PHONE_PEPPER` exactly as for the
  monolith (above), the same values for every profile instance, and empty
  `PROFILE_DEV_FLAGS` and `S3_INTERNAL_ENDPOINT`.
- **Keep one `ws-gateway`.** Presence (who is online, decision 223) lives
  in the gateway process: with two, a user sees only the people on their
  own gateway. Message delivery itself works across gateways (redis).
- Host ports: `NGINX_PORT`, `MONGO_PORT`, `REDIS_PORT`, `MINIO_PORT`,
  `PG_PORT`. Always pass `-p <name>`: without it compose names the project
  after this directory.
- The helm chart (`helm/`) runs the same services: `helm template` it with
  your values; it brings no database, bus, redis or object store.

## Local development

```bash
CHAT_SERVER_TAG=<tag> docker compose --env-file .env.tmpl -f docker-compose.monolith.yml up -d
```

This has a dev OTP endpoint (`GET /v3.0/auth/dev/otp?phone=`) and MinIO for
media. MinIO stopped publishing images in late 2025, so this only works where
`minio/minio:latest` is already pulled.
