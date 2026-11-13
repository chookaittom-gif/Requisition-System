-- One-off data fix (2026-11-13): reconcile 3 materials whose ledger quantity disagrees with
-- real stock (materials.stock_qty = SUM(material_lots.remaining_qty)).
-- NOT a migration. Review, back up, then run manually (steps below).
--
--   0) Backup:   npx wrangler d1 export ims_db --remote --output backup-before-opening-fix.sql
--   1) Before (PowerShell; --file does not print rows, so pass the SQL as --command):
--        $sql = (Get-Content scripts/verify-2026-11-13-opening-mismatch.sql -Raw) -replace '(?m)^--.*$','' -replace '\s+',' '
--        npx wrangler d1 execute ims_db --remote --command $sql
--      Expected before the fix: ok = 0 on all 3 rows (ledger 4 / 3 / 14 vs stock 3 / 2 / 24).
--   2) Apply:    npx wrangler d1 execute ims_db --remote --file scripts/fix-2026-11-13-opening-mismatch.sql
--   3) After:    run step 1 again; every row must show ok = 1
--
-- Idempotent: each UPDATE is guarded by the current wrong value, so a second run changes nothing.
-- Lots, stock_qty, purchases and request data are NOT touched. Only ledger inputs are corrected.

-- 001-0021: FY2570 opening says 4, real stock/lots/IN movement say 3 (no movement explains the 4th).
UPDATE opening_balances
   SET opening_qty = 3, updated_at = datetime('now', '+7 hours')
 WHERE fiscal_year = 2570 AND opening_qty = 4
   AND material_id = (SELECT id FROM materials WHERE code = '001-0021');
UPDATE materials
   SET opening_qty = 3, updated_at = datetime('now', '+7 hours')
 WHERE code = '001-0021' AND opening_qty = 4;

-- 001-0022: FY2570 opening says 3, real stock/lots/IN movement say 2.
UPDATE opening_balances
   SET opening_qty = 2, updated_at = datetime('now', '+7 hours')
 WHERE fiscal_year = 2570 AND opening_qty = 3
   AND material_id = (SELECT id FROM materials WHERE code = '001-0022');
UPDATE materials
   SET opening_qty = 2, updated_at = datetime('now', '+7 hours')
 WHERE code = '001-0022' AND opening_qty = 3;

-- 8851552201016: manual ADJUST 34 -> 24 (2026-10-20, Chookait) was recorded against a before_qty of 34
-- that no longer exists (a duplicate "จัดซื้อ" IN 24 was removed). Real stock = 24 = 1 purchase of 24.
-- Neutralise the phantom -10 by making that row a zero-net adjustment; the original values stay in the note.
UPDATE stock_movements
   SET qty = 0,
       before_qty = 24,
       after_qty = 24,
       note = note || ' [แก้ 2026-11-13: เดิม ก่อนปรับ 34 -> หลังปรับ 24 (qty 10) คลาดเคลื่อนจากรายการจัดซื้อซ้ำที่ถูกลบ; ยอดจริง 24]'
 WHERE type = 'ADJUST' AND before_qty = 34 AND after_qty = 24 AND qty = 10
   AND code = '8851552201016';
