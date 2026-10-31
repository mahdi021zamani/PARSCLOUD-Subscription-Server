ALTER TABLE subscriptions
ADD COLUMN max_connections INTEGER NOT NULL DEFAULT 1
CHECK (max_connections BETWEEN 1 AND 100);

CREATE TABLE IF NOT EXISTS connection_sessions (
  subscription_id TEXT NOT NULL,
  slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 100),
  session_id TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, slot_number),
  UNIQUE (subscription_id, session_id),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_connection_sessions_expiry
ON connection_sessions(subscription_id, lease_expires_at);
