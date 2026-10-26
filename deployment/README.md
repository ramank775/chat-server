# Chat server deployment

**Production (3.0) is `docker-compose.prod.yml`**: the monolith (every service in
one process), MongoDB, and Caddy in front for TLS. Photos, voice notes and files
live in a Cloudflare R2 bucket: the server only signs upload and download links,
and phones talk to R2 directly. Mongo is the only state on the server.

`docker-compose.monolith.yml` (with `.env.tmpl`) is the local development stack. The
microservice layout (`docker-compose.infra.yml` plus `docker-compose.yml`, and
`helm/`) stays supported but has not caught up with 3.0 yet: the compose stack
gives profile-ms no `OTP_ENCRYPTION_KEY`, and the helm chart is still v2 and does
not render. Deploy 3.0 as the monolith.

## What you need

- A Linux server with Docker and the compose plugin, ports 80 and 443 open.
  2 vCPU and 4 GB RAM is plenty to start.
- A DNS record (A, and AAAA if the server has IPv6) for the API hostname
  pointing at the server. Release builds of the app use
  `vartalapapp.one9x.org` (`https://` for the API, `wss://…/wss` for the
  socket). Caddy gets and renews the certificate once DNS resolves.
- A Cloudflare R2 bucket and an API token for it.
- An [sms-gate.app](https://sms-gate.app) account: an Android phone with a SIM
  running the SMS Gateway app in cloud mode. It sends the OTP texts.
- The release image on Docker Hub (see Releasing).

## First deploy

1. Get this directory onto the server, e.g. a sparse checkout:
   ```bash
   git clone --depth 1 --filter=blob:none --sparse -b v3.0 https://github.com/ramank775/chat-server
   cd chat-server && git sparse-checkout set deployment && cd deployment
   ```
2. **R2.**
   - In the Cloudflare dashboard, R2 › Create bucket (e.g. `vartalap-media`). Leave public access off.
   - R2 › Manage API tokens › Create: permission "Object Read & Write", scoped to that bucket. Note the access key id and secret.
   - The endpoint is `https://<account-id>.r2.cloudflarestorage.com` (account id on the R2 overview page).
   - No CORS rule is needed: the phones are not browsers.
3. **Settings.** `cp .env.prod.tmpl .env` and fill in every value. Compose
   refuses to start while a required one is empty.
   - `MONGO_PASSWORD`: `openssl rand -hex 24`.
   - `OTP_ENCRYPTION_KEY`: `openssl rand -hex 32`. Keep this outside Mongo,
     stable across restarts and shared by profile-service instances. It encrypts
     the OTP copy used by Resend; verification still checks the hash. Changing
     it prevents resending pending codes for up to 10 minutes; their original
     codes can still verify. This fresh release expects a new database schema.
   - VAPID keys: generate once and keep them. A new pair silences push on every installed phone until it re-registers.
     ```bash
     docker run --rm --entrypoint npx ramank775/chatserver:<tag> web-push generate-vapid-keys
     ```
   - `VAPID_SUBJECT`: `mailto:` plus an address push services can reach you at.
4. **Start.** `docker compose -f docker-compose.prod.yml up -d`
5. **Check.**
   - `curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/v3.0/users/me` prints `401`: TLS works and the app answers.
   - Then, on a release build:
     - sign up with a real number (the OTP SMS arrives);
     - send a photo to a second phone and see it arrive (R2 upload and download);
     - kill the app on the second phone and message it again (push wake).

## Upgrading

Set `CHAT_SERVER_TAG` in `.env` to the new release, then:

```bash
docker compose -f docker-compose.prod.yml pull app
docker compose -f docker-compose.prod.yml up -d
```

Phones reconnect by themselves. Nothing is lost while the server is down: senders keep messages
queued, and what the server already acknowledged is in Mongo.

## Forcing an app update

Two `.env` values steer old apps (decision 192). Both are Android
versionCodes, the number after `+` in the app's `pubspec.yaml` version
(3.0.0+80 is 80). 0 turns each off.

- `LATEST_APP_BUILD`: apps below it show a dismissible "New version
  available" bar above the chat list.
- `MIN_APP_BUILD`: apps below it are refused (HTTP 426) and show only a
  "no longer supported" screen with an Update button. Raise it only once
  the new build is live on Play and on GitHub, or those users are stuck.

The Update button opens Play for Play installs and the GitHub release
otherwise. After editing `.env`, `docker compose -f docker-compose.prod.yml up -d`.

## Backups

Media is in R2: the server deletes a message file 30 days after it was
last sent; profile and group photos stay until replaced or the account is
deleted. Everything else (accounts, groups, the 30-day message timeline) is
in Mongo. Dump it daily, e.g. from cron in this directory, and keep 7 days:

```bash
docker compose -f docker-compose.prod.yml exec -T mongo sh -c \
  'mongodump -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db chat --archive --gzip' \
  > backups/chat-$(date +%F).archive.gz
find backups -name 'chat-*.archive.gz' -mtime +7 -delete
```

Keep copies off the server too, with `sync` so old dumps go there as well
(e.g. `rclone sync backups r2:vartalap-backups`, a second bucket). The
privacy policy promises 7 days: deleted accounts live on in a dump until it
ages out. Restore into a running stack with:

```bash
docker compose -f docker-compose.prod.yml exec -T mongo sh -c \
  'mongorestore -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --drop' \
  < backups/chat-<date>.archive.gz
```

## Logs

`docker compose -f docker-compose.prod.yml logs -f app` (or `caddy`, `mongo`).
Each container keeps at most 5 × 50 MB.

## Never in production

- The dev flags `--expose-dev-otp`, `PROFILE_DEV_FLAGS` and
  `--push-allow-private-endpoints`. The production compose file has none of
  them; don't add them.
- A published app port. The per-IP OTP limits trust the last
  `X-Forwarded-For` hop, which only Caddy may set.
- `-dev` image tags.

## Releasing

There is no image-publishing CI yet. From a clean checkout of the release
commit:

```bash
docker build -t ramank775/chatserver:v3.0.0 .
docker push ramank775/chatserver:v3.0.0
```

## Local development

```bash
CHAT_SERVER_TAG=<tag> docker compose --env-file .env.tmpl -f docker-compose.monolith.yml up -d
```

This has a dev OTP endpoint (`GET /v3.0/auth/dev/otp?phone=`) and MinIO for
media. MinIO stopped publishing images in late 2025, so this only works where
`minio/minio:latest` is already pulled.
