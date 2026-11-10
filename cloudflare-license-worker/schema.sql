-- 1. 卡密主表
CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_key TEXT UNIQUE NOT NULL,
    tier TEXT NOT NULL CHECK(tier IN ('lifetime', 'monthly', 'yearly')),
    duration_days INTEGER NOT NULL DEFAULT 0,
    max_devices INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'unused' CHECK(status IN ('unused', 'active', 'expired', 'banned')),
    first_activated_at INTEGER,
    expires_at INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL
);

-- 2. 设备绑定表
CREATE TABLE IF NOT EXISTS activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_key TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    device_name TEXT,
    platform TEXT,
    activated_at INTEGER NOT NULL,
    last_verified_at INTEGER NOT NULL,
    FOREIGN KEY(card_key) REFERENCES licenses(card_key) ON DELETE CASCADE,
    UNIQUE(card_key, machine_id)
);

CREATE INDEX IF NOT EXISTS idx_licenses_card_key ON licenses(card_key);
CREATE INDEX IF NOT EXISTS idx_activations_card_key ON activations(card_key);
