# Cloudflare staging setup — device limits

**Staging only. Do not use the Production Worker or its D1 database.**

## 1. Create an isolated D1 database
In Cloudflare Dashboard, open Workers & Pages → D1 → Create database. Name it `parscloud-device-limits-staging`. Do not reuse `parscloud-subscriptions`. Copy the new database ID.

## 2. Prepare staging config
Copy `wrangler.staging.template.toml` to `wrangler.staging.toml` locally. Replace only `database_id` with the new staging D1 ID. Confirm Worker name `parscloud-device-limits-staging` and DB name/ID point to the new database.

## 3. Configure staging Worker
Create a separate Worker named `parscloud-device-limits-staging` or deploy reviewed branch using staging config. Set a new random `ADMIN_TOKEN` secret (32+ chars) for staging only. Do not copy Production ADMIN_TOKEN. Do not add V2RAY_SOURCE_URL, AETHER_SOURCE_URL, AETHER_GITHUB_TOKEN or production secrets.

Set `DEVICE_LIMITS_ENFORCED=true`. Only test subscriptions should be present.

## 4. Before deployment
Review final config and target Worker/D1 in Cloudflare UI. Deployment and remote migrations are intentionally not included; they require explicit approval. Never run remote migration against production.

## 5. Test APK
Use Android repo GitHub Actions `workflow_dispatch` and set `test_worker_url` to the staging Worker HTTPS base URL (no trailing slash/path). Leave blank only if registration should be disabled. Test branch APK defaults to a nonfunctional `.invalid` endpoint so it cannot silently use Production.

## Safety checklist
- [ ] Worker name is staging, not Production.
- [ ] D1 is newly created staging DB; its ID is not Production's.
- [ ] ADMIN_TOKEN is staging-only.
- [ ] No production feed secrets or subscription keys copied.
- [ ] APK build explicitly points at staging.
- [ ] Production Worker, D1, customer records, and Build 137 unchanged.
