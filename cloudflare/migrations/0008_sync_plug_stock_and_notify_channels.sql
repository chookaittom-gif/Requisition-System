-- Migration: Add notify_telegram & notify_line to settings and sync plug 5m stock
ALTER TABLE settings ADD COLUMN notify_telegram TEXT NOT NULL DEFAULT 'YES';
ALTER TABLE settings ADD COLUMN notify_line TEXT NOT NULL DEFAULT 'YES';

-- Sync stock_qty for 001-0001 (ปลั๊กไฟ 5 ม. BLL PLUG B75 WHITE) to 2 matching its opening_balance
UPDATE materials SET stock_qty = 2, opening_qty = 2 WHERE code = '001-0001' AND stock_qty = 0;
