-- Migration: Create shops table
CREATE TABLE shops (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  tax_id     TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_shops_name ON shops (name);

-- Seed distinct shops from materials
INSERT OR IGNORE INTO shops (id, name, tax_id, address, phone, note, created_at, updated_at)
SELECT
  'SHP-' || substr(hex(randomblob(4)), 1, 8),
  trim(shop_name),
  trim(shop_tax_id),
  trim(shop_address),
  trim(shop_phone),
  '',
  datetime('now', '+7 hours'),
  datetime('now', '+7 hours')
FROM materials
WHERE trim(shop_name) != ''
GROUP BY trim(shop_name);
