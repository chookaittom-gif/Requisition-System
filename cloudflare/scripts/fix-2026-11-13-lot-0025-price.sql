-- One-off data fix (2026-11-13): 001-0025 purchase P-6BDE2C20 and lot LOT-63AB0A12 were created at price 0,
-- while the approved request line and the material price are 95. Align purchase + lot price so lots,
-- purchases and the ledger agree. No effect on stock quantity or remaining value (the lot is fully consumed)
-- nor on any displayed total (the ledger already falls back to 95).
-- Backup: cloudflare/backup-before-opening-fix.sql (taken 2026-11-13, contains the original rows).
-- Apply:  npx wrangler d1 execute ims_db --remote --file scripts/fix-2026-11-13-lot-0025-price.sql
-- Guarded by the current wrong value: re-running changes nothing.
UPDATE purchases SET unit_price = 95, amount = 95 WHERE id = 'P-6BDE2C20' AND unit_price = 0 AND amount = 0;
UPDATE material_lots SET unit_price = 95 WHERE id = 'LOT-63AB0A12' AND unit_price = 0;
