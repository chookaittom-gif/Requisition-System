-- 0010_partial_approval.sql — Support partial item-level approval
ALTER TABLE requests ADD COLUMN is_partial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_items ADD COLUMN approved_qty REAL;
