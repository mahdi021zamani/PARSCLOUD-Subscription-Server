# PARSCLOUD Subscription Server

Cloudflare Worker + D1 API for managing PARSCLOUD app subscriptions.

## Features in this starter
- Create subscriptions with a customer label, expiry date, and finite app-device limit (1–100).
- Register each app installation using a non-exportable Android Keystore signing key.
- Enforce per-subscription device limits without limiting simultaneous tunnels or imported configurations.
- List and revoke registered devices from the admin panel; adjust capacity without deleting existing devices.
- Validate subscription keys and device ownership from the app.
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
   # For a brand-new database only, initialize it with schema.sql.
   npx wrangler d1 execute parscloud-subscriptions --remote --file=./schema.sql
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put V2RAY_SOURCE_URL
   npx wrangler secret put AETHER_SOURCE_URL
   npx wrangler secret put AETHER_GITHUB_TOKEN
   npm run deploy
   ```
4. When prompted for `ADMIN_TOKEN`, enter a long random secret. Never commit it to GitHub or put it in the Android app.
5. Configure `V2RAY_SOURCE_URL` only if you still use the legacy private V2Ray proxy route. For the private Aether proxy route, set `AETHER_SOURCE_URL` to `https://api.github.com/repos/mahdi021zamani/parscloud-sub/contents/Aether?ref=main` and `AETHER_GITHUB_TOKEN` to a fine-grained token restricted to this repository with **Contents: Read-only**. The current Android app imports its V2Ray, Aether, combined, and Services feeds directly from GitHub Raw; these feeds are not part of app-device validation. Never put the GitHub token in a URL, Git, Android source code, or chat.
6. Note the deployed `workers.dev` URL. The Worker URL is public; the upstream panel/feed URLs and the admin token are not.

For local development, copy `.dev.vars.example` to `.dev.vars`, set a private `ADMIN_TOKEN`, then run `npm run dev`. Do not commit `.dev.vars`.

## 2. Cloudflare Git deployment
The repository is connected to the `parscloud-subscription-server` Worker with `main` as the production branch. Cloudflare Builds uses `npm run deploy` as the deploy command, so commits pushed to `main` can trigger a deployment. Keep the `DB` D1 binding and `ADMIN_TOKEN` secret configured in the Worker settings; neither belongs in Git.

## 3. API
API control responses use JSON; successful feed-proxy responses use plain text. The API currently allows cross-origin requests for compatibility with mobile clients; admin routes still require the secret bearer token.

- `GET /health` — health check.
- `GET /v1/primary-feed/v2ray` — authenticated V2Ray primary-feed proxy. Requires `Authorization: Bearer pc_...` with an active customer subscription key; upstream URL is read only from `V2RAY_SOURCE_URL`.
- `GET /v1/primary-feed/aether` — authenticated Aether primary-feed proxy. Requires the same active customer subscription key; reads the private `Aether` file from the pinned GitHub Contents API URL in `AETHER_SOURCE_URL`, using `AETHER_GITHUB_TOKEN` server-side. The GitHub credential is never returned to the app and redirects are not followed.
- `POST /v1/device-challenge` — creates a short-lived one-time challenge for an Android Keystore installation key. Body: `{"subscriptionKey":"pc_...","devicePublicKey":"base64-SPKI"}`.
- `POST /v1/validate` — validates the subscription and, when supplied, the signed device challenge. New clients send `subscriptionKey`, `devicePublicKey`, `challengeId`, and `signature`. During staged rollout, key-only requests remain accepted until `DEVICE_LIMITS_ENFORCED=true`.
- `POST /admin/subscriptions` — create a subscription. Admin bearer token required. Body: `{"customerLabel":"Customer","durationDays":30,"maxDevices":2}` or `{"customerLabel":"Customer","expiresAt":"2026-12-01T00:00:00Z","maxDevices":2}`. `maxDevices` is required and must be 1–100. The raw subscription key is returned only at creation; save it securely and deliver it to the customer.
- `GET /admin/subscriptions?limit=50` — list subscriptions, device counts, and capacities (key itself is never returned).
- `GET /admin/subscriptions/:id/devices` — list registered and revoked devices.
- `DELETE /admin/subscriptions/:id/devices/:deviceId` — revoke one installation and free its slot. A revoked installation cannot silently re-register.
- `POST /admin/subscriptions/:id/device-limit` — set `{"maxDevices":5}`. Lowering the limit never removes existing devices; existing installations remain valid, and new installations are denied until usage is below the new limit.
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
The full fresh-install schema is in `schema.sql`. Existing production databases must use the additive migration in `migrations/0001_device_registration.sql`; it adds `max_devices` with a finite default of 5 for existing subscriptions and creates the device/challenge tables without deleting subscription data. Apply migrations to a test database first. Do not run the remote migration or deploy to production until the updated Android build has been tested and rollout is approved. Use `npx wrangler d1 migrations apply parscloud-subscriptions --local` for local testing; the remote command is `npx wrangler d1 migrations apply parscloud-subscriptions --remote` and must be run only during the approved production rollout.


### Feed proxy outcome contract

- The two primary routes return HTTP 200 with the upstream text body only when the upstream returns HTTP 200 or 204, including a zero-byte body. This lets the app distinguish an intentional empty primary feed from an upstream/transport failure.
- A primary upstream HTTP error, partial-content response, transport error, invalid HTTPS configuration, or oversized response becomes a non-2xx Worker response. The app must preserve that source's last-known-good profiles.
- The emergency fallback route has been removed. Customers use their own separately purchased tunnel traffic/configuration.
- The legacy Worker proxy routes `/v1/primary-feed/v2ray` and `/v1/primary-feed/aether` remain separate from the app's direct GitHub Raw feeds. No device-registration limit is applied to config-feed retrieval. `ADMIN_TOKEN` is only for the admin API and must never be included in the APK.
- Existing installations receive a finite capacity of five devices during migration. New subscriptions require an explicit 1–100 limit. The Android client identifies an installation with an EC P-256 signing key generated in Android Keystore; the private key is non-exportable. Device registration persists while the app is offline.
- The Worker never returns the upstream URLs to the client. The app should store only the customer's subscription key and use the public Worker endpoint.
