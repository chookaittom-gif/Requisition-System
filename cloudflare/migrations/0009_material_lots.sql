-- 0009_material_lots.sql — FIFO Lot Tracking for materials
CREATE TABLE material_lots (
  id            TEXT PRIMARY KEY,
  material_id   TEXT NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  purchase_id   TEXT REFERENCES purchases (id) ON DELETE SET NULL,
  unit_price    REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  initial_qty   REAL NOT NULL DEFAULT 0 CHECK (initial_qty >= 0),
  remaining_qty REAL NOT NULL DEFAULT 0 CHECK (remaining_qty >= 0),
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEPLETED')),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_material_lots_active ON material_lots (material_id, status, created_at);

-- Backfill initial lot for existing materials with positive stock
INSERT INTO material_lots (id, material_id, purchase_id, unit_price, initial_qty, remaining_qty, status, created_at)
SELECT 
  'LOT-' || id,
  id,
  NULL,
  unit_price,
  stock_qty,
  stock_qty,
  'ACTIVE',
  datetime('now', '+7 hours')
FROM materials
WHERE stock_qty > 0;
