CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  vault_id TEXT NOT NULL,
  id TEXT NOT NULL,
  signing_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(vault_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS devices_global_id_idx ON devices(id);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS packages_expiry_idx ON packages(expires_at);

CREATE TABLE IF NOT EXISTS deliveries (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  acknowledged_at TEXT,
  UNIQUE(package_id, device_id)
);

CREATE INDEX IF NOT EXISTS deliveries_inbox_idx ON deliveries(vault_id, device_id, acknowledged_at, cursor);

CREATE TABLE IF NOT EXISTS pairing_sessions (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  host_device_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open', 'claimed', 'complete', 'expired')),
  guest_device_id TEXT,
  guest_signing_key TEXT,
  guest_agreement_key TEXT,
  guest_display_name TEXT,
  sealed_payload_key TEXT
);
