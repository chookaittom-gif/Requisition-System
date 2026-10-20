-- 0001_init.sql — D1 schema for ระบบเบิกจ่ายพัสดุ
-- Source of truth for columns: HEADERS in Code/code.gs:29-53.
-- Primary keys keep the legacy GAS ids (genId_: '<PREFIX>-XXXXXXXX'), so imports are idempotent.
-- Dates: TEXT 'YYYY-MM-DD HH:MM:SS' in Asia/Bangkok, no offset (matches cellVal_ in code.gs:168).
-- Day-only dates (request_date, purchase_date): 'YYYY-MM-DD'.
-- D1 enforces foreign keys by default, so no PRAGMA is needed here.

-- Users (code.gs:34). Role 'staff' is legacy and ranks equal to 'officer' (code.gs:104).
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                 -- 'sha256$<hex>' (legacy) or 'pbkdf2$...' (new)
  full_name     TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'officer' CHECK (role IN ('admin', 'officer', 'staff')),
  position      TEXT NOT NULL DEFAULT '',
  department    TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Categories (code.gs:52).
CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Materials (code.gs:35-39). category stores the category name, not an id, like the legacy sheet.
CREATE TABLE materials (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  unit             TEXT NOT NULL DEFAULT '',
  unit_price       REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  stock_qty        REAL NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  min_qty          REAL NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  opening_qty      REAL NOT NULL DEFAULT 0 CHECK (opening_qty >= 0),
  category         TEXT NOT NULL DEFAULT '',
  material_type    TEXT NOT NULL DEFAULT '',
  size_spec        TEXT NOT NULL DEFAULT '',
  storage_location TEXT NOT NULL DEFAULT '',
  image_url        TEXT NOT NULL DEFAULT '',
  file_url         TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_materials_category ON materials (category);
CREATE INDEX idx_materials_name ON materials (name);

-- Requests (code.gs:40-44). user_id NULL = guest request (legacy UserID 'GUEST').
-- stock_applied guards against double stock deduction (legacy re-applied on every APPROVED toggle).
CREATE TABLE requests (
  id            TEXT PRIMARY KEY,
  doc_no        TEXT NOT NULL UNIQUE,         -- 'REQ-yyyyMMdd-NNNN'
  request_date  TEXT NOT NULL,
  user_id       TEXT REFERENCES users (id) ON DELETE SET NULL,
  full_name     TEXT NOT NULL DEFAULT '',
  position      TEXT NOT NULL DEFAULT '',
  department    TEXT NOT NULL DEFAULT '',
  purpose       TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  attach_url    TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reject_reason TEXT NOT NULL DEFAULT '',
  approved_date TEXT NOT NULL DEFAULT '',
  approved_by   TEXT NOT NULL DEFAULT '',
  total_amount  REAL NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  item_count    INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  stock_applied INTEGER NOT NULL DEFAULT 0 CHECK (stock_applied IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (stock_applied = 0 OR status = 'APPROVED')
);
CREATE INDEX idx_requests_status_date ON requests (status, request_date);
CREATE INDEX idx_requests_user ON requests (user_id);
CREATE INDEX idx_requests_request_date ON requests (request_date);

-- RequestItems (code.gs:45). code/name/unit/unit_price are snapshots taken at request time.
CREATE TABLE request_items (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  material_id TEXT REFERENCES materials (id) ON DELETE SET NULL,
  code        TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  unit        TEXT NOT NULL DEFAULT '',
  qty         REAL NOT NULL CHECK (qty > 0),
  unit_price  REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  total_price REAL NOT NULL DEFAULT 0 CHECK (total_price >= 0),
  remark      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_request_items_request ON request_items (request_id);
CREATE INDEX idx_request_items_material ON request_items (material_id);

-- Purchases (code.gs:46).
CREATE TABLE purchases (
  id            TEXT PRIMARY KEY,
  material_id   TEXT REFERENCES materials (id) ON DELETE SET NULL,
  code          TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  qty           REAL NOT NULL CHECK (qty > 0),
  unit_price    REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  amount        REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
  purchase_date TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_purchases_material_date ON purchases (material_id, purchase_date);
CREATE INDEX idx_purchases_date ON purchases (purchase_date);

-- StockMovements (code.gs:47-50). ADJUST qty is |diff|; after_qty is authoritative for ADJUST.
CREATE TABLE stock_movements (
  id          TEXT PRIMARY KEY,
  material_id TEXT REFERENCES materials (id) ON DELETE SET NULL,
  code        TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL CHECK (type IN ('IN', 'OUT', 'ADJUST')),
  qty         REAL NOT NULL CHECK (qty >= 0),
  before_qty  REAL NOT NULL DEFAULT 0,
  after_qty   REAL NOT NULL DEFAULT 0,
  ref_doc     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  actor       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_stock_movements_material_date ON stock_movements (material_id, created_at);
CREATE INDEX idx_stock_movements_date ON stock_movements (created_at);
CREATE INDEX idx_stock_movements_ref ON stock_movements (ref_doc);

-- OpeningBalances (code.gs:53). fiscal_year is Buddhist Era (e.g. 2569).
CREATE TABLE opening_balances (
  id          TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2500 AND 2700),
  opening_qty REAL NOT NULL DEFAULT 0 CHECK (opening_qty >= 0),
  set_by      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (material_id, fiscal_year)
);

-- AuditLog (code.gs:51). Append-only.
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_log_date ON audit_log (created_at);
CREATE INDEX idx_audit_log_entity ON audit_log (entity, entity_id);

-- Settings (code.gs:29-33), single row. TelegramBotToken is intentionally absent:
-- it moves to the Worker secret TELEGRAM_BOT_TOKEN (see docs/data-mapping.md).
CREATE TABLE settings (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  school_name             TEXT NOT NULL DEFAULT '',
  affiliation             TEXT NOT NULL DEFAULT '',
  logo_url                TEXT NOT NULL DEFAULT '',
  address                 TEXT NOT NULL DEFAULT '',
  phone                   TEXT NOT NULL DEFAULT '',
  notify_email            TEXT NOT NULL DEFAULT '',
  telegram_chat_id        TEXT NOT NULL DEFAULT '',
  notify_on_new_request   TEXT NOT NULL DEFAULT 'NO' CHECK (notify_on_new_request IN ('YES', 'NO')),
  notify_on_status_change TEXT NOT NULL DEFAULT 'NO' CHECK (notify_on_status_change IN ('YES', 'NO')),
  notify_low_stock        TEXT NOT NULL DEFAULT 'NO' CHECK (notify_low_stock IN ('YES', 'NO')),
  banner_url              TEXT NOT NULL DEFAULT '',
  updated_at              TEXT NOT NULL
);

-- Server-side sessions (new). Only the SHA-256 of the bearer token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'officer', 'staff')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Atomic DocNo sequence per day (replaces count-based genDocNo_, code.gs:295).
CREATE TABLE doc_counters (
  day TEXT PRIMARY KEY,                       -- 'yyyyMMdd'
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0)
);

-- Google Drive file metadata (new). Binary content never goes into D1.
CREATE TABLE drive_files (
  id            TEXT PRIMARY KEY,
  drive_file_id TEXT NOT NULL UNIQUE,
  entity        TEXT NOT NULL,                 -- 'material_image' | 'material_file' | 'request_attachment' | 'logo' | 'banner'
  entity_id     TEXT NOT NULL DEFAULT '',
  folder        TEXT NOT NULL DEFAULT '',      -- legacy subfolder name, e.g. 'MaterialImages'
  file_name     TEXT NOT NULL DEFAULT '',
  mime_type     TEXT NOT NULL DEFAULT '',
  size_bytes    INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  url           TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_drive_files_entity ON drive_files (entity, entity_id);

-- Import bookkeeping (new): row counts before/after each sheet import.
CREATE TABLE import_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,                  -- e.g. spreadsheet id or file name
  sheet        TEXT NOT NULL,
  rows_read    INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'OK', 'FAILED')),
  message      TEXT NOT NULL DEFAULT '',
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL DEFAULT ''
);
