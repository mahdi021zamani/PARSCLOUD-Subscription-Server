# PARSCLOUD Subscription Server

Cloudflare Worker + D1 API for managing PARSCLOUD app subscriptions.

## Features in this starter
- Create subscriptions with a customer label and expiry date.
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
   npx wrangler d1 execute parscloud-subscriptions --remote --file=./schema.sql
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put EMERGENCY_SOURCE_URL
   npm run deploy
   ```
4. When prompted for `ADMIN_TOKEN`, enter a long random secret. Never commit it to GitHub or put it in the Android app.
5. When prompted for `EMERGENCY_SOURCE_URL`, paste the complete emergency paid-panel subscription URL. This is a Cloudflare secret: it must never be committed to Git or placed in Android source code. The app retrieves the feed through `/v1/fallback-config` only when both primary feeds have no fresh usable configs.
6. Note the deployed `workers.dev` URL.

For local development, copy `.dev.vars.example` to `.dev.vars`, set a private `ADMIN_TOKEN`, then run `npm run dev`. Do not commit `.dev.vars`.

## 2. Cloudflare Git deployment
The repository is connected to the `parscloud-subscription-server` Worker with `main` as the production branch. Cloudflare Builds uses `npm run deploy` as the deploy command, so commits pushed to `main` can trigger a deployment. Keep the `DB` D1 binding and `ADMIN_TOKEN` secret configured in the Worker settings; neither belongs in Git.

## 3. API
All request and response bodies are JSON. The API currently allows cross-origin requests for compatibility with mobile clients; admin routes still require the secret bearer token.

- `GET /health` — health check.
- `GET /v1/fallback-config` — read-only emergency-feed proxy. The upstream credential-bearing URL is stored only in the Worker secret `EMERGENCY_SOURCE_URL`; the URL itself is never returned to the app.
- `POST /v1/validate` — public subscription validation. Body: `{"subscriptionKey":"pc_..."}`
- `POST /admin/subscriptions` — create a subscription. Admin bearer token required. Body: `{"customerLabel":"Customer","durationDays":30}` or `{"customerLabel":"Customer","expiresAt":"2026-12-01T00:00:00Z"}`. The raw subscription key is returned only at creation; save it securely and deliver it to the customer.
- `GET /admin/subscriptions?limit=50` — list subscriptions (key itself is never returned).
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
