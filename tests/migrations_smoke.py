#!/usr/bin/env python3
"""Smoke-test the additive D1 migration chain using SQLite."""
import pathlib
import sqlite3
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"

def run_case(legacy: bool):
    with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
        db = sqlite3.connect(tmp.name)
        db.execute("PRAGMA foreign_keys=ON")
        if legacy:
            db.executescript("""
                CREATE TABLE subscriptions (
                  id TEXT PRIMARY KEY,
                  key_hash TEXT NOT NULL UNIQUE,
                  key_prefix TEXT NOT NULL,
                  customer_label TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  expires_at INTEGER NOT NULL
                );
                INSERT INTO subscriptions VALUES
                  ('existing','hash','pc_test','Existing customer','active',1,1,9999999999999);
            """)
        for path in sorted(MIGRATIONS.glob("*.sql")):
            db.executescript(path.read_text(encoding="utf-8"))
        columns = {row[1] for row in db.execute("PRAGMA table_info(subscriptions)")}
        assert "max_devices" in columns
        if legacy:
            assert db.execute("SELECT max_devices FROM subscriptions WHERE id='existing'").fetchone()[0] == 5
        db.execute("""
          INSERT INTO subscriptions
          (id,key_hash,key_prefix,customer_label,status,created_at,updated_at,expires_at,max_devices)
          VALUES ('new','newhash','pc_new','New','active',2,2,9999999999999,1)
        """)
        db.execute("""
          INSERT INTO subscription_devices
          (id,subscription_id,public_key_hash,public_key,created_at,last_seen_at)
          VALUES ('device','new','pubhash','pubkey',3,3)
        """)
        assert db.execute("SELECT COUNT(*) FROM subscription_devices WHERE subscription_id='new'").fetchone()[0] == 1
        db.execute("""
          INSERT INTO device_challenges
          (id,subscription_id,public_key_hash,challenge,created_at,expires_at)
          VALUES ('challenge','new','pubhash','nonce',3,9999999999999)
        """)
        assert db.execute("SELECT COUNT(*) FROM device_challenges").fetchone()[0] == 1
        db.close()

run_case(False)  # Fresh D1
run_case(True)   # Existing subscriptions table without migration history
print("Migration smoke tests passed (fresh + legacy database).")
