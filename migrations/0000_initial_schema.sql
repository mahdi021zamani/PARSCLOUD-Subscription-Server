-- Initial PARSCLOUD subscription schema.
-- IF NOT EXISTS makes this a safe no-op for databases initialized before migrations existed.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  customer_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_at
  ON subscriptions(expires_at);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON subscriptions(status);
