-- 0011_personnel.sql — Personnel directory table for requisition auto-fill
CREATE TABLE IF NOT EXISTS personnel (
  code        TEXT PRIMARY KEY,
  full_name   TEXT NOT NULL,
  position    TEXT NOT NULL DEFAULT '',
  department  TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personnel_active ON personnel(active);
