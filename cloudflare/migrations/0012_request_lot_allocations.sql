-- 0012_request_lot_allocations.sql — remember which FIFO lots an approved request consumed,
-- so cancelling the request returns stock to the same lots at the same prices.
-- Additive only: no existing table or row is changed. Legacy approvals simply have no rows here.
CREATE TABLE request_lot_allocations (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  lot_id      TEXT NOT NULL REFERENCES material_lots (id) ON DELETE CASCADE,
  qty         REAL NOT NULL CHECK (qty > 0),
  unit_price  REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_request_lot_allocations_request ON request_lot_allocations (request_id);
