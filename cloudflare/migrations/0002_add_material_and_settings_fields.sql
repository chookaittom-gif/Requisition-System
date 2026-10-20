-- Migration: Add material shop/budget fields and settings line_token
ALTER TABLE materials ADD COLUMN shop_name TEXT NOT NULL DEFAULT '';
ALTER TABLE materials ADD COLUMN shop_address TEXT NOT NULL DEFAULT '';
ALTER TABLE materials ADD COLUMN shop_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE materials ADD COLUMN shop_tax_id TEXT NOT NULL DEFAULT '';
ALTER TABLE materials ADD COLUMN budget_source TEXT NOT NULL DEFAULT 'งบประมาณแผ่นดิน';
ALTER TABLE materials ADD COLUMN acquired_date TEXT NOT NULL DEFAULT '';
ALTER TABLE materials ADD COLUMN order_qty REAL NOT NULL DEFAULT 0;

ALTER TABLE settings ADD COLUMN line_token TEXT NOT NULL DEFAULT '';
