-- Read-only check (SELECT only). ok = 1 when ledger quantity == real stock == lot quantity.
-- Ledger quantity = FY2570 opening + purchases - approved requests + net ADJUST.
SELECT m.code,
       m.stock_qty AS stock,
       COALESCE((SELECT SUM(remaining_qty) FROM material_lots l WHERE l.material_id = m.id), 0) AS lots,
       COALESCE((SELECT opening_qty FROM opening_balances ob WHERE ob.material_id = m.id AND ob.fiscal_year = 2570), m.opening_qty)
         + COALESCE((SELECT SUM(qty) FROM purchases p WHERE p.material_id = m.id), 0)
         - COALESCE((SELECT SUM(COALESCE(ri.approved_qty, ri.qty)) FROM request_items ri JOIN requests r ON r.id = ri.request_id
                      WHERE ri.material_id = m.id AND r.status = 'APPROVED'), 0)
         + COALESCE((SELECT SUM(after_qty - before_qty) FROM stock_movements s WHERE s.material_id = m.id AND s.type = 'ADJUST'), 0) AS ledger,
       CASE WHEN m.stock_qty = COALESCE((SELECT SUM(remaining_qty) FROM material_lots l WHERE l.material_id = m.id), 0)
             AND m.stock_qty = COALESCE((SELECT opening_qty FROM opening_balances ob WHERE ob.material_id = m.id AND ob.fiscal_year = 2570), m.opening_qty)
         + COALESCE((SELECT SUM(qty) FROM purchases p WHERE p.material_id = m.id), 0)
         - COALESCE((SELECT SUM(COALESCE(ri.approved_qty, ri.qty)) FROM request_items ri JOIN requests r ON r.id = ri.request_id
                      WHERE ri.material_id = m.id AND r.status = 'APPROVED'), 0)
         + COALESCE((SELECT SUM(after_qty - before_qty) FROM stock_movements s WHERE s.material_id = m.id AND s.type = 'ADJUST'), 0)
            THEN 1 ELSE 0 END AS ok
  FROM materials m
 WHERE m.code IN ('001-0021', '001-0022', '8851552201016')
 ORDER BY m.code;
