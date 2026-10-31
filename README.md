# PARSCLOUD Subscription Server

Cloudflare Worker + D1 API for managing PARSCLOUD app subscriptions.

## Features in this starter
- Create subscriptions with a customer label, expiry date, and configurable concurrent-connection limit (1–100).
- Enforce simultaneous connections with server-side 90-second renewable leases; the Android tunnel renews every 30 seconds.
- Validate a subscription key from the app.
- Renew or revoke subscriptions through an admin-only API.
- Store only a SHA-256 hash of each subscription key in D1.
- Keep runtime data and secrets out of Git.

> This is the first deployable foundation, not a guarantee of uninterrupted service. Configure Cloudflare, apply the D1 migration, and test the Android app integration before relying on it for customers.

## 1. Cloudflare setup
1. In Cloudflare, create a **D1 database** named `parscloud-subscriptions`.
2. Copy its database ID into `wrangler.toml` in place of `REPLACE_WITH_YOUR_D1_DATABASE_ID`.
3. Install Node.js and npm on a computer, then run:
   ```sh
   npm install
   npx wrangler login
   # Choose exactly ONE schema command:
   # Fresh D1 database:
   # npx wrangler d1 execute parscloud-subscriptions --remote --file=./schema.sql
   # Existing D1 database:
   # npx wrangler d1 execute parscloud-subscriptions --remote --file=./migrations/0002_connection_limits.sql
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put V2RAY_SOURCE_URL
   npx wrangler secret put AETHER_SOURCE_URL
   npx wrangler secret put EMERGENCY_SOURCE_URL
   npm run deploy
   ```
4. When prompted for `ADMIN_TOKEN`, enter a long random secret. Never commit it to GitHub or put it in the Android app.
5. Configure `V2RAY_SOURCE_URL` and `AETHER_SOURCE_URL` as Cloudflare Worker secrets, using the complete HTTPS subscription URLs for the two primary feeds. Configure `EMERGENCY_SOURCE_URL` with the complete HTTPS emergency paid-panel subscription URL. These are secrets: never commit them to Git or place them in Android source code.
6. Note the deployed `workers.dev` URL. The Worker URL is public; the upstream panel/feed URLs and the admin token are not.

For local development, copy `.dev.vars.example` to `.dev.vars`, set a private `ADMIN_TOKEN`, then run `npm run dev`. Do not commit `.dev.vars`.

## 2. Cloudflare Git deployment
The repository is connected to the `parscloud-subscription-server` Worker with `main` as the production branch. Cloudflare Builds uses `npm run deploy` as the deploy command, so commits pushed to `main` can trigger a deployment. Keep the `DB` D1 binding and `ADMIN_TOKEN` secret configured in the Worker settings; neither belongs in Git.

## 3. API
API control responses use JSON; successful feed-proxy responses use plain text. The API currently allows cross-origin requests for compatibility with mobile clients; admin routes still require the secret bearer token.

- `GET /health` — health check.
- `GET /v1/primary-feed/v2ray` — authenticated V2Ray primary-feed proxy. Requires `Authorization: Bearer pc_...` with an active customer subscription key; upstream URL is read only from `V2RAY_SOURCE_URL`.
- `GET /v1/primary-feed/aether` — authenticated Aether primary-feed proxy. Requires the same active customer subscription key; upstream URL is read only from `AETHER_SOURCE_URL`.
- `GET /v1/fallback-config` — authenticated emergency-feed proxy. The app should call it only after both primary feeds independently have no fresh usable configs. The upstream URL is stored only in the Worker secret `EMERGENCY_SOURCE_URL`.
- `POST /v1/validate` — public subscription validation. Body: `{"subscriptionKey":"pc_..."}`. The response includes `maxConnections`.
- `POST /v1/session/acquire` — atomically reserve one of the subscription's simultaneous-connection slots. Requires the customer bearer key and body `{"sessionId":"<installation-uuid>"}`.
- `POST /v1/session/heartbeat` — renew the same connection lease; the lease expires after 90 seconds without renewal.
- `POST /v1/session/release` — release the installation's slot on normal tunnel shutdown.
- `POST /admin/subscriptions` — create a subscription. Admin bearer token required. Body: `{"customerLabel":"Customer","durationDays":30,"maxConnections":2}` or `{"customerLabel":"Customer","expiresAt":"2026-12-01T00:00:00Z","maxConnections":2}`. `maxConnections` is optional (defaults to 1) and must be an integer from 1 to 100. The raw subscription key is returned only at creation; save it securely and deliver it to the customer.
- `GET /admin/subscriptions?limit=50` — list subscriptions with each connection limit and current unexpired lease count (key itself is never returned).
- `POST /admin/subscriptions/:id/renew` — renew from the later of now or the current expiry. Body: `{"durationDays":30}`.
- `POST /admin/subscriptions/:id/revoke` — revoke a subscription.

Admin requests must include `Authorization: Bearer YOUR_ADMIN_TOKEN`.

## 4. Important app integration notes
- The Android app must call `POST /v1/validate` before enabling VPN connection and must also stop an active connection when the server confirms expiry or revocation.
- Do not embed `ADMIN_TOKEN` in the APK. Only the customer subscription key belongs on the client.
- Treat network errors differently from an explicit `expired` or `revoked` result. A temporary outage must not rewrite the stored expiry or permanently lock a valid user. If you choose a short offline grace period, design it explicitly and test it; do not treat arbitrary failures as valid forever.
- Client-side checks alone can be modified by a determined user. The server is the source of truth, but a fully tamper-resistant client requires additional app-side protections.
- Back up the D1 data regularly and keep this Git repository private. Git stores source code, not a backup of the live database.

## 5. Database migration
The initial schema is in `schema.sql`. For future schema changes, add numbered SQL migrations and apply them to the remote D1 database before deploying code that depends on them.


### Feed proxy outcome contract

- The two primary routes return HTTP 200 with the upstream text body only when the upstream returns HTTP 200 or 204, including a zero-byte body. This lets the app distinguish an intentional empty primary feed from an upstream/transport failure.
- A primary upstream HTTP error, partial-content response, transport error, invalid HTTPS configuration, or oversized response becomes a non-2xx Worker response. The app must preserve that source's last-known-good profiles.
- The emergency route rejects an empty response and returns an error instead; it is a recovery input, not an instruction to clear either primary group.
- All three feed routes require an active customer subscription key in the Authorization bearer header. `ADMIN_TOKEN` is only for the admin API and must never be included in the APK.
- The Worker never returns the upstream URLs to the client. The app should store only the customer's subscription key and use the public Worker endpoint.


## 6. Concurrent connection limits

The limit is the number of simultaneous tunnel installations, not the number of devices on which a customer may install the app. The default is one connection; administrators may set any integer from 1 to 100 when creating a subscription.

The Worker allocates a unique slot per subscription and installation session. D1's unique slot constraint prevents two different sessions from taking the same slot concurrently. A lease lasts 90 seconds and is renewed by the app every 30 seconds while the tunnel service is alive. A normal stop releases the slot; a crash or force-stop leaves a lease that becomes reusable after it expires. The app stops its tunnel if the Worker explicitly denies renewal, or if it cannot renew before the lease safety deadline. As with all mobile background work, Android process termination and network loss mean this is lease-based enforcement, not a promise of instantaneous global disconnection.

Apply `migrations/0002_connection_limits.sql` to an existing D1 database before deploying the Worker code in this branch. Existing subscriptions are migrated with a default limit of one. Do not apply `schema.sql` to an existing populated database; it is the complete schema for a fresh database.
