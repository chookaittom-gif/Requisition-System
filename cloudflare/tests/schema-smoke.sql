-- Positive smoke test: valid rows insert, re-import is idempotent, cascades work.
-- Runs against a freshly migrated local DB; cleans up after itself.

INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at)
VALUES ('U-TEST0001', 'smoke_user', 'sha256$00', 'Smoke User', 'officer', '2026-10-12 09:00:00', '2026-10-12 09:00:00');

INSERT INTO materials (id, code, name, unit, unit_price, stock_qty, min_qty, opening_qty, category, created_at, updated_at)
VALUES ('M-TEST0001', 'SMOKE-001', 'กระดาษ A4', 'รีม', 125, 10, 2, 10, 'วัสดุสำนักงาน', '2026-10-12 09:00:00', '2026-10-12 09:00:00');

-- Re-import of the same id must update, not duplicate.
INSERT INTO materials (id, code, name, unit, unit_price, stock_qty, min_qty, opening_qty, category, created_at, updated_at)
VALUES ('M-TEST0001', 'SMOKE-001', 'กระดาษ A4 80g', 'รีม', 125, 10, 2, 10, 'วัสดุสำนักงาน', '2026-10-12 09:00:00', '2026-10-12 09:05:00')
ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;

INSERT INTO requests (id, doc_no, request_date, user_id, full_name, status, total_amount, item_count, created_at, updated_at)
VALUES ('R-TEST0001', 'REQ-20261012-9001', '2026-10-12', 'U-TEST0001', 'Smoke User', 'PENDING', 250, 1, '2026-10-12 09:10:00', '2026-10-12 09:10:00');

-- Guest request: user_id NULL (legacy 'GUEST').
INSERT INTO requests (id, doc_no, request_date, user_id, full_name, status, created_at, updated_at)
VALUES ('R-TEST0002', 'REQ-20261012-9002', '2026-10-12', NULL, 'Guest', 'PENDING', '2026-10-12 09:11:00', '2026-10-12 09:11:00');

INSERT INTO request_items (id, request_id, material_id, code, name, unit, qty, unit_price, total_price)
VALUES ('RI-TEST0001', 'R-TEST0001', 'M-TEST0001', 'SMOKE-001', 'กระดาษ A4', 'รีม', 2, 125, 250);

INSERT INTO opening_balances (id, material_id, fiscal_year, opening_qty, set_by, created_at, updated_at)
VALUES ('OB-TEST0001', 'M-TEST0001', 2569, 10, 'smoke_user', '2026-10-12 09:00:00', '2026-10-12 09:00:00');

INSERT INTO settings (id, school_name, notify_on_new_request, updated_at)
VALUES (1, 'Smoke', 'YES', '2026-10-12 09:00:00');

-- Atomic DocNo counter.
INSERT INTO doc_counters (day, seq) VALUES ('20261012', 0)
ON CONFLICT (day) DO NOTHING;
UPDATE doc_counters SET seq = seq + 1 WHERE day = '20261012' RETURNING seq;

-- Expect: materials=1, name updated, request_items=1.
SELECT
  (SELECT COUNT(*) FROM materials WHERE id = 'M-TEST0001') AS materials_rows,
  (SELECT name FROM materials WHERE id = 'M-TEST0001') AS material_name,
  (SELECT COUNT(*) FROM request_items WHERE request_id = 'R-TEST0001') AS items_before_delete;

-- Cascade: deleting the request removes its items.
DELETE FROM requests WHERE id = 'R-TEST0001';
SELECT (SELECT COUNT(*) FROM request_items WHERE id = 'RI-TEST0001') AS items_after_delete;

-- SET NULL: deleting a material keeps history rows. Opening balances cascade.
DELETE FROM materials WHERE id = 'M-TEST0001';
SELECT (SELECT COUNT(*) FROM opening_balances WHERE id = 'OB-TEST0001') AS opening_after_material_delete;

PRAGMA foreign_key_check;

-- Cleanup.
DELETE FROM requests WHERE id = 'R-TEST0002';
DELETE FROM users WHERE id = 'U-TEST0001';
DELETE FROM settings WHERE id = 1;
DELETE FROM doc_counters WHERE day = '20261012';
