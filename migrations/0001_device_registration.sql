-- Add finite per-subscription app-device capacity and a persistent device registry.
-- Existing subscriptions receive a conservative finite default of five devices.
ALTER TABLE subscriptions
  ADD COLUMN max_devices INTEGER NOT NULL DEFAULT 5 CHECK (max_devices BETWEEN 1 AND 100);

CREATE TABLE IF NOT EXISTS subscription_devices (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  public_key_hash TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (subscription_id, public_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_subscription_devices_subscription
  ON subscription_devices(subscription_id, revoked_at);

CREATE TABLE IF NOT EXISTS device_challenges (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  public_key_hash TEXT NOT NULL,
  challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_device_challenges_expiry
  ON device_challenges(expires_at);
