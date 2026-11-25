# Device-limit local test (safe / no production access)

This branch is experimental. The production Worker and its D1 database must not be deployed, migrated, or changed during these tests.

## Safety
- Use `wrangler.test.toml` only for local development.
- Its Worker name and D1 database name are distinct; its database ID is intentionally a dummy UUID.
- Never run `wrangler deploy` or any `--remote` migration from this guide.
- Never use production `ADMIN_TOKEN` or production subscription keys. Create a temporary local key.

## Prepare
1. Install Node.js (LTS), then in this repository run `npm install`.
2. Create `.dev.vars` (ignored by Git) containing a random local-only admin token of at least 32 characters:
   `ADMIN_TOKEN=local-test-only-change-me-0123456789abcdef`
3. Apply migrations to Wrangler's local D1:
   `npx wrangler --config wrangler.test.toml d1 migrations apply parscloud-device-limits-local-test --local`
4. Start the local Worker:
   `npx wrangler --config wrangler.test.toml dev`
5. Open `http://127.0.0.1:8787/health`; expect JSON with `ok: true`. The local admin UI is at `http://127.0.0.1:8787/admin`.

## Functional tests
The Android app currently points to the deployed Worker URL, so do not use the real app/key for this local test unless its Worker URL is changed in a separate disposable test build.

Test API manually using a local HTTP client:
- Create a test subscription with `POST /admin/subscriptions`, JSON `{ "customerLabel": "LOCAL TEST", "durationDays": 1, "maxDevices": 1 }`, and the local admin bearer token.
- Check `GET /admin/subscriptions` shows 0/1 devices.
- Run the automated API/device proof test using the local-only token: `LOCAL_ADMIN_TOKEN='your-local-token' node tests/device_limits_local_integration.mjs`. It creates temporary one-day local subscriptions and exercises registration, repeat validation, cap denial, admin revocation, slot reuse, and lowering the cap below current usage.\n- This harness uses generated P-256 keys and must only target the local Worker.
- Check the admin device-list, revoke, and capacity endpoints with seeded test records only.
- Confirm the public GitHub feeds remain outside device-registration validation; app imports them directly from GitHub, not through this Worker.

## Expected behavior matrix
| Scenario | Expected |
|---|---|
| Device A registers, cap=1 | accepted, 1/1 |
| Device A validates again | still 1/1 |
| Device B tries, cap=1 | rejected: device_limit |
| Admin revokes Device A | active count becomes 0/1 |
| Device B registers after slot freed | accepted |
| Cap lowered below active count | existing device remains accepted; new registrations denied |
| Device is revoked | revoked installation cannot re-register |
| Expired/revoked subscription | challenge and validation denied |
| Empty/invalid challenge, expired or reused challenge | rejected |

No production Cloudflare resources are touched by these steps.
