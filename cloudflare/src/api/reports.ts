import type { Env } from '../env';
import { fail } from '../http';
import { logAudit } from '../lib/audit';
import { computeStockState, toLegacy } from '../lib/rows';
import { currentFiscalYear, fiscalYearRange, todayBkk } from '../lib/time';
import { registerRpc, type Ctx } from '../rpc';
import { listMaterials } from './materials';
import { listRequests, mapRequest } from './requests';

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number => Number(v || 0);

/** Read-only handlers: failures return a generic Thai message, never raw SQLite text. */
async function safe(label: string, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    console.error(`${label} failed`, err);
    return fail('เกิดข้อผิดพลาดในการดึงข้อมูล');
  }
}

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

/** Legacy thaiDateFull_ (code.gs:1593). */
export function thaiDateFull(isoDate: unknown): string {
  if (!isoDate) return '';
  const parts = String(isoDate).substring(0, 10).split('-');
  if (parts.length < 3) return String(isoDate);
  const y = parseInt(parts[0], 10) + 543;
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  return `${d} ${THAI_MONTHS[m] || ''} ${y}`;
}

function fiscalYearOf(v: unknown): number {
  const fy = parseInt(String(v || ''), 10);
  return Number.isFinite(fy) ? fy : currentFiscalYear();
}

/** Builds " WHERE a AND b" for bound-parameter filters. */
const whereOf = (clauses: string[]): string => (clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '');

/* ============================== STOCK MOVEMENTS / AUDIT ============================== */
async function stockMovements(env: Env, filter: unknown): Promise<Obj[]> {
  const f = asObj(filter);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.materialId) {
    where.push('material_id = ?');
    binds.push(String(f.materialId));
  }
  if (f.type) {
    where.push('type = ?');
    binds.push(String(f.type));
  }
  if (f.from) {
    where.push('substr(created_at, 1, 10) >= ?');
    binds.push(String(f.from));
  }
  if (f.to) {
    where.push('substr(created_at, 1, 10) <= ?');
    binds.push(String(f.to));
  }
  if (f.q) {
    const q = String(f.q).toLowerCase();
    where.push('(instr(lower(code), ?) > 0 OR instr(lower(name), ?) > 0 OR instr(lower(ref_doc), ?) > 0)');
    binds.push(q, q, q);
  }
  const sql = `SELECT * FROM stock_movements${whereOf(where)} ORDER BY created_at DESC, rowid ASC LIMIT 1000`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all<Obj>();
  return results.map((r) => toLegacy('stock_movements', r));
}

async function auditLog(env: Env, filter: unknown): Promise<Obj[]> {
  const f = asObj(filter);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.action) {
    where.push('action = ?');
    binds.push(String(f.action));
  }
  if (f.from) {
    where.push('substr(created_at, 1, 10) >= ?');
    binds.push(String(f.from));
  }
  if (f.to) {
    where.push('substr(created_at, 1, 10) <= ?');
    binds.push(String(f.to));
  }
  if (f.q) {
    const q = String(f.q).toLowerCase();
    where.push('(instr(lower(detail), ?) > 0 OR instr(lower(actor), ?) > 0 OR instr(lower(entity), ?) > 0)');
    binds.push(q, q, q);
  }
  const sql = `SELECT * FROM audit_log${whereOf(where)} ORDER BY created_at DESC, rowid ASC LIMIT 500`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all<Obj>();
  return results.map((r) => toLegacy('audit_log', r));
}

registerRpc('apiGetStockMovements', 'officer', (ctx, args) =>
  safe('apiGetStockMovements', async () => ({ ok: true, data: await stockMovements(ctx.env, args[0]) })),
);

registerRpc('apiGetAuditLog', 'admin', (ctx, args) =>
  safe('apiGetAuditLog', async () => ({ ok: true, data: await auditLog(ctx.env, args[0]) })),
);

registerRpc('apiClearStockMovements', 'admin', async (ctx) => {
  try {
    const db = ctx.env.DB;
    const row = await db.prepare('SELECT COUNT(*) as count FROM stock_movements').first<{ count: number }>();
    const count = Number(row?.count || 0);

    const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM stock_movements')];
    stmts.push(
      logAudit(db, {
        action: 'DELETE',
        entity: 'StockMovements',
        entityId: 'ALL',
        detail: `ล้างประวัติสต็อกทั้งหมด ${count} รายการ`,
        actor: ctx.session?.username ?? '',
      }),
    );

    await db.batch(stmts);
    return { ok: true, message: `ล้างประวัติเคลื่อนไหวสต็อกเรียบร้อยแล้ว (${count} รายการ)` };
  } catch (err) {
    console.error('apiClearStockMovements failed', err);
    return fail('เกิดข้อผิดพลาดในการล้างประวัติสต็อก');
  }
});

/* ============================== DASHBOARDS ============================== */
type Counters = { approved: number; pending: number; rejected: number };

const chartStatus = (c: Counters) => [
  { label: 'อนุมัติแล้ว', value: c.approved },
  { label: 'รออนุมัติ', value: c.pending },
  { label: 'ปฏิเสธ', value: c.rejected },
];

registerRpc('apiGetAdminDashboard', 'officer', (ctx) =>
  safe('apiGetAdminDashboard', async () => {
    const db = ctx.env.DB;
    const materials = await listMaterials(ctx);
    const { results: statuses } = await db
      .prepare('SELECT status, COUNT(*) AS n FROM requests GROUP BY status')
      .all<{ status: string; n: number }>();
    const n = (s: string) => statuses.find((r) => r.status === s)?.n ?? 0;
    const counters: Counters = { approved: n('APPROVED'), pending: n('PENDING'), rejected: n('REJECTED') };
    const used = await db
      .prepare(
        "SELECT COALESCE(SUM(i.total_price), 0) AS value, COALESCE(SUM(i.qty), 0) AS qty FROM request_items i JOIN requests r ON r.id = i.request_id WHERE r.status = 'APPROVED'",
      )
      .first<{ value: number; qty: number }>();
    const { results: byName } = await db
      .prepare(
        "SELECT i.name AS name, SUM(i.qty) AS qty FROM request_items i JOIN requests r ON r.id = i.request_id WHERE r.status = 'APPROVED' GROUP BY i.name ORDER BY MIN(i.rowid)",
      )
      .all<{ name: string; qty: number }>();

    const chartByItem = byName.map((r) => ({ label: r.name, value: num(r.qty) }));
    const chartTop10 = chartByItem.slice().sort((a, b) => b.value - a.value).slice(0, 10);
    const invAcc = await inventoryAccount(ctx, { fiscalYear: currentFiscalYear() });
    return {
      ok: true,
      summary: {
        totalMaterials: materials.length,
        remainValue: invAcc.summary.remainValue,
        usedValue: num(used?.value),
        usedQty: num(used?.qty),
        lowStock: materials.filter((m) => m.StockState !== 'OK').length,
      },
      counters,
      materials,
      chartByItem,
      chartTop10,
      chartStatus: chartStatus(counters),
    };
  }),
);

registerRpc('apiGetTeacherDashboard', 'officer', (ctx, args) =>
  safe('apiGetTeacherDashboard', async () => {
    const db = ctx.env.DB;
    const userId = String(args[0] ?? '');
    const { results: reqRows } = await db
      .prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY created_at DESC, rowid ASC')
      .bind(userId)
      .all<Obj>();
    const reqs = reqRows.map(mapRequest);
    const { results: items } = await db
      .prepare('SELECT i.* FROM request_items i JOIN requests r ON r.id = i.request_id WHERE r.user_id = ? ORDER BY i.rowid')
      .bind(userId)
      .all<Obj>();

    const approved = new Set(reqs.filter((r) => r.Status === 'APPROVED').map((r) => r.ID));
    const byItem = new Map<string, number>();
    for (const it of items) {
      if (!approved.has(it.request_id)) continue;
      const name = String(it.name);
      byItem.set(name, (byItem.get(name) ?? 0) + num(it.qty));
    }
    const counters: Counters = {
      approved: reqs.filter((r) => r.Status === 'APPROVED').length,
      pending: reqs.filter((r) => r.Status === 'PENDING').length,
      rejected: reqs.filter((r) => r.Status === 'REJECTED').length,
    };
    const recent = reqs.slice(0, 5).map((r) => ({
      ...r,
      Items: items
        .filter((it) => it.request_id === r.ID)
        .map((it) => ({
          MaterialID: it.material_id,
          Code: it.code,
          Name: it.name,
          Unit: it.unit,
          Qty: num(it.qty),
          UnitPrice: num(it.unit_price),
          TotalPrice: num(it.total_price),
          Remark: it.remark,
        })),
    }));
    return {
      ok: true,
      summary: { totalRequests: reqs.length },
      counters,
      chartByItem: [...byItem].map(([label, value]) => ({ label, value })),
      chartStatus: chartStatus(counters),
      recent,
    };
  }),
);

/* ============================== INVENTORY ACCOUNT ============================== */
async function inventoryAccount(ctx: Ctx, filter: unknown) {
  const f = asObj(filter);
  const from = f.from ? String(f.from) : null;
  const to = f.to ? String(f.to) : null;
  const fiscalYear = f.fiscalYear ? fiscalYearOf(f.fiscalYear) : (from || to ? null : fiscalYearOf(undefined));
  const range = fiscalYear ? fiscalYearRange(fiscalYear) : null;
  const effectiveFrom = from || (range ? range.from : null);
  const effectiveTo = to || (range ? range.to : null);

  const purchaseWhere = ['p.material_id = m.id'];
  const usedWhere = ['i.material_id = m.id', "r.status = 'APPROVED'"];
  const pBinds: unknown[] = [];
  const uBinds: unknown[] = [];
  if (effectiveFrom) {
    purchaseWhere.push('p.purchase_date >= ?');
    pBinds.push(effectiveFrom);
    usedWhere.push("COALESCE(r.request_date, '') >= ?");
    uBinds.push(effectiveFrom);
  }
  if (effectiveTo) {
    purchaseWhere.push('p.purchase_date <= ?');
    pBinds.push(effectiveTo);
    usedWhere.push("COALESCE(r.request_date, '') <= ?");
    uBinds.push(effectiveTo);
  }

  const obJoin = fiscalYear ? 'LEFT JOIN opening_balances ob ON ob.material_id = m.id AND ob.fiscal_year = ?' : '';
  const obSelect = fiscalYear ? ', ob.opening_qty AS ob_qty' : '';
  const mainBinds = fiscalYear ? [...pBinds, ...uBinds, fiscalYear] : [...pBinds, ...uBinds];

  const { results } = await ctx.env.DB.prepare(
    `SELECT m.*${obSelect},
       (SELECT COALESCE(SUM(p.qty), 0) FROM purchases p WHERE ${purchaseWhere.join(' AND ')}) AS purchased,
       (SELECT COALESCE(SUM(i.qty), 0) FROM request_items i JOIN requests r ON r.id = i.request_id WHERE ${usedWhere.join(' AND ')}) AS used
     FROM materials m ${obJoin}`,
  )
    .bind(...mainBinds)
    .all<Obj>();

  const { results: lotTotals } = await ctx.env.DB.prepare(
    "SELECT material_id, SUM(remaining_qty * unit_price) AS lot_remain_amount FROM material_lots WHERE status = 'ACTIVE' AND remaining_qty > 0 GROUP BY material_id",
  ).all<{ material_id: string; lot_remain_amount: number }>();
  const lotRemainMap = new Map(lotTotals.map((l) => [String(l.material_id), Number(l.lot_remain_amount)]));

  const data = results
    .map((row) => {
      const m = toLegacy('materials', row);
      const unitPrice = num(m.UnitPrice);
      const openingQty = row.ob_qty !== null && row.ob_qty !== undefined ? num(row.ob_qty) : num(m.OpeningQty);
      const purchaseQty = num(row.purchased);
      const usedQty = num(row.used);
      const remainQty = Math.max(0, openingQty + purchaseQty - usedQty);
      const lotRemainAmount = lotRemainMap.get(String(row.id));
      const remainAmount = lotRemainAmount !== undefined && remainQty > 0 ? lotRemainAmount : remainQty * unitPrice;
      return {
        Code: m.Code,
        Name: m.Name,
        Unit: m.Unit,
        UnitPrice: unitPrice,
        Category: m.Category || '',
        OpeningQty: openingQty,
        OpeningAmount: openingQty * unitPrice,
        PurchaseQty: purchaseQty,
        PurchasePrice: unitPrice,
        PurchaseAmount: purchaseQty * unitPrice,
        UsedQty: usedQty,
        UsedPrice: unitPrice,
        UsedAmount: usedQty * unitPrice,
        RemainQty: remainQty,
        RemainAmount: remainAmount,
        StockState: computeStockState(remainQty, num(m.MinQty)),
      };
    })
    .sort((a, b) => String(a.Code).localeCompare(String(b.Code)));

  const total = data.reduce(
    (acc, x) => {
      acc.OpeningQty += x.OpeningQty;
      acc.OpeningAmount += x.OpeningAmount;
      acc.PurchaseQty += x.PurchaseQty;
      acc.PurchaseAmount += x.PurchaseAmount;
      acc.UsedQty += x.UsedQty;
      acc.UsedAmount += x.UsedAmount;
      acc.RemainQty += x.RemainQty;
      acc.RemainAmount += x.RemainAmount;
      return acc;
    },
    { OpeningQty: 0, OpeningAmount: 0, PurchaseQty: 0, PurchaseAmount: 0, UsedQty: 0, UsedAmount: 0, RemainQty: 0, RemainAmount: 0 },
  );
  return {
    ok: true as const,
    summary: {
      totalMaterials: data.length,
      remainValue: total.RemainAmount,
      usedValue: total.UsedAmount,
      lowStock: from || to ? data.filter((x) => x.StockState !== 'OK').length : results.filter((r) => computeStockState(Number(r.stock_qty || 0), Number(r.min_qty || 0)) !== 'OK').length,
    },
    total,
    data,
    asOf: todayBkk(),
    fiscalYear: fiscalYear || undefined,
    filter: { from: from || (range ? range.from : ''), to: to || (range ? range.to : '') },
  };
}

registerRpc('apiGetInventoryAccount', 'officer', (ctx, args) =>
  safe('apiGetInventoryAccount', () => inventoryAccount(ctx, args[0])),
);

/* ============================== INVENTORY REPORT ============================== */
async function readSettings(env: Env): Promise<Obj> {
  const row = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first<Obj>();
  return row ? toLegacy('settings', row) : {};
}

registerRpc('apiGetInventoryReport', 'officer', (ctx, args) =>
  safe('apiGetInventoryReport', async () => {
    const f = asObj(args[0]);
    const fiscalYear = fiscalYearOf(f.fiscalYear);
    const reportDate = f.reportDate ? String(f.reportDate) : todayBkk();
    const categoryFilter = String(f.category || '').trim();
    const range = fiscalYearRange(fiscalYear);
    const startDate = range.from;
    const endDate = reportDate < range.to ? reportDate : range.to;

    const binds: unknown[] = [startDate, endDate, startDate, endDate, fiscalYear];
    let catSql = '';
    if (categoryFilter) {
      catSql = ' WHERE trim(m.category) = ? OR trim(m.material_type) = ?';
      binds.push(categoryFilter, categoryFilter);
    }
    const { results } = await ctx.env.DB.prepare(
      `SELECT m.*, ob.opening_qty AS ob_qty,
         (SELECT COALESCE(SUM(p.qty), 0) FROM purchases p
            WHERE p.material_id = m.id AND substr(p.purchase_date, 1, 10) BETWEEN ? AND ?) AS purchased,
         (SELECT COALESCE(SUM(i.qty), 0) FROM request_items i JOIN requests r ON r.id = i.request_id
            WHERE i.material_id = m.id AND r.status = 'APPROVED'
              AND substr(COALESCE(NULLIF(r.request_date, ''), r.approved_date), 1, 10) BETWEEN ? AND ?) AS used
       FROM materials m
       LEFT JOIN opening_balances ob ON ob.material_id = m.id AND ob.fiscal_year = ?${catSql}`,
    )
      .bind(...binds)
      .all<Obj>();

    const { results: lotTotals } = await ctx.env.DB.prepare(
      "SELECT material_id, SUM(remaining_qty * unit_price) AS lot_remain_amount FROM material_lots WHERE status = 'ACTIVE' AND remaining_qty > 0 GROUP BY material_id",
    ).all<{ material_id: string; lot_remain_amount: number }>();
    const lotRemainMap = new Map(lotTotals.map((l) => [String(l.material_id), Number(l.lot_remain_amount)]));

    const data = results
      .map((row) => {
        const m = toLegacy('materials', row);
        const unitPrice = num(m.UnitPrice);
        let openingQty = row.ob_qty === null || row.ob_qty === undefined ? num(m.OpeningQty) : num(row.ob_qty);
        let purchaseQty = num(row.purchased);
        const usedQty = num(row.used);

        const remainQty = Math.max(0, openingQty + purchaseQty - usedQty);
        const lotRemainAmount = lotRemainMap.get(String(row.id));
        const amount = lotRemainAmount !== undefined && remainQty > 0 ? lotRemainAmount : remainQty * unitPrice;
        return {
          seq: 0,
          ID: m.ID,
          Category: String(m.Category || ''),
          MaterialType: m.MaterialType || m.Category || '',
          Code: m.Code || '',
          Name: String(m.Name || ''),
          SizeSpec: m.SizeSpec || '',
          Unit: m.Unit || '',
          UnitPrice: unitPrice,
          OpeningQty: openingQty,
          PurchaseQty: purchaseQty,
          UsedQty: usedQty,
          RemainQty: remainQty,
          Amount: amount,
          StorageLocation: m.StorageLocation || '',
        };
      })
      .sort((a, b) => {
        const c = a.Category.localeCompare(b.Category, 'th');
        return c !== 0 ? c : a.Name.localeCompare(b.Name, 'th');
      });
    data.forEach((r, i) => {
      r.seq = i + 1;
    });

    const catMap = new Map<string, number>();
    for (const r of data) catMap.set(r.Category || 'อื่นๆ', (catMap.get(r.Category || 'อื่นๆ') ?? 0) + r.Amount);
    const total = data.reduce(
      (acc, r) => {
        acc.OpeningQty += r.OpeningQty;
        acc.PurchaseQty += r.PurchaseQty;
        acc.UsedQty += r.UsedQty;
        acc.RemainQty += r.RemainQty;
        acc.Amount += r.Amount;
        return acc;
      },
      { OpeningQty: 0, PurchaseQty: 0, UsedQty: 0, RemainQty: 0, Amount: 0 },
    );
    // Stock card daily OUT (legacy code.gs:1936-1954): APPROVED requests dated in the report month, by request_date day.
    const dayRows = await ctx.env.DB.prepare(
      `SELECT i.material_id AS mid, CAST(substr(r.request_date, 9, 2) AS INTEGER) AS day, SUM(i.qty) AS qty
         FROM request_items i JOIN requests r ON r.id = i.request_id
        WHERE r.status = 'APPROVED' AND substr(r.request_date, 1, 7) = ?
        GROUP BY i.material_id, day`,
    )
      .bind(reportDate.substring(0, 7))
      .all<{ mid: string; day: number; qty: number }>();
    const dayOut: Record<string, Record<number, number>> = {};
    for (const d of dayRows.results) {
      if (d.day >= 1 && d.day <= 31) (dayOut[d.mid] ??= {})[d.day] = num(d.qty);
    }
    const settings = await readSettings(ctx.env);
    return {
      ok: true,
      dayOut,
      reportInfo: {
        schoolName: settings.SchoolName || 'ศูนย์การศึกษา ลำปาง',
        affiliation: settings.Affiliation || '',
        fiscalYear,
        reportDate,
        reportDateThai: thaiDateFull(reportDate),
        category: categoryFilter,
        startDate,
        endDate,
      },
      data,
      categorySummary: [...catMap].map(([category, totalAmount]) => ({ category, totalAmount })),
      total,
      asOf: reportDate,
    };
  }),
);

/* ============================== STOCK CARD ============================== */
interface CardEntry {
  date: string;
  dateTh: string;
  description: string;
  inQty: number;
  outQty: number;
  balance: number;
  actor: string;
  refDoc: string;
}

async function stockCard(env: Env, materialId: unknown, filter: unknown) {
  if (!materialId) return fail('กรุณาระบุรหัสวัสดุ (Material ID)');
  const f = asObj(filter);
  const db = env.DB;
  const id = String(materialId);
  const matRow = await db.prepare('SELECT * FROM materials WHERE id = ?').bind(id).first<Obj>();
  if (!matRow) return fail('ไม่พบข้อมูลพัสดุในระบบ');
  const mat = toLegacy('materials', matRow);

  const fiscalYear = fiscalYearOf(f.fiscalYear);
  const range = fiscalYearRange(fiscalYear);
  const fromDate = f.from ? String(f.from) : range.from;
  const toDate = f.to ? String(f.to) : range.to;

  const ob = await db
    .prepare('SELECT opening_qty FROM opening_balances WHERE material_id = ? AND fiscal_year = ?')
    .bind(id, fiscalYear)
    .first<{ opening_qty: number }>();
  let fiscalOpeningQty = ob ? num(ob.opening_qty) : num(mat.OpeningQty);
  if (!ob && num(mat.OrderQty) > 0) {
    const acqDate = String(mat.AcquiredDate || '').substring(0, 10);
    if (acqDate >= fromDate && acqDate <= toDate) {
      fiscalOpeningQty = Math.max(0, fiscalOpeningQty - num(mat.OrderQty));
    }
  }

  const { results: moves } = await db
    .prepare('SELECT * FROM stock_movements WHERE material_id = ? ORDER BY created_at ASC, rowid ASC')
    .bind(id)
    .all<Obj>();

  let running = fiscalOpeningQty;
  const period: Obj[] = [];
  for (const m of moves) {
    const d = String(m.created_at || '').substring(0, 10);
    if (d < fromDate) {
      const qty = num(m.qty);
      if (m.type === 'IN') running += qty;
      else if (m.type === 'OUT') running -= qty;
      else if (m.type === 'ADJUST') running = num(m.after_qty);
    } else if (d <= toDate) {
      period.push(m);
    }
  }

  const periodOpening = running;
  let totalIn = 0;
  let totalOut = 0;

  // Resolve requester's full name for OUT movements from requests
  const refDocs = Array.from(new Set(period.map((m) => String(m.ref_doc || '').trim()).filter(Boolean)));
  const reqNameMap = new Map<string, string>();
  if (refDocs.length > 0) {
    const placeholders = refDocs.map(() => '?').join(',');
    const { results: reqList } = await db
      .prepare(`SELECT doc_no, full_name FROM requests WHERE doc_no IN (${placeholders})`)
      .bind(...refDocs)
      .all<{ doc_no: string; full_name: string }>();
    for (const r of reqList) {
      if (r.full_name) reqNameMap.set(r.doc_no, r.full_name);
    }
  }

  const entries: CardEntry[] = [
    { date: fromDate, dateTh: thaiDateFull(fromDate), description: 'ยอดยกมา', inQty: periodOpening, outQty: 0, balance: periodOpening, actor: '-', refDoc: '' },
  ];
  for (const m of period) {
    const d = String(m.created_at || '').substring(0, 10);
    const qty = num(m.qty);
    const refDoc = String(m.ref_doc || '').trim();
    const ref = refDoc ? ` (${refDoc})` : '';
    let inQty = 0;
    let outQty = 0;
    let desc = String(m.note || '');
    let displayActor = String(m.actor || '');

    if (m.type === 'IN') {
      inQty = qty;
      totalIn += qty;
      running += qty;
      if (!desc) desc = `รับเข้าสต๊อก${ref}`;
    } else if (m.type === 'OUT') {
      outQty = qty;
      totalOut += qty;
      running -= qty;
      if (!desc) desc = `จ่ายตามใบขอเบิก${ref}`;
      if (refDoc && reqNameMap.has(refDoc)) {
        displayActor = reqNameMap.get(refDoc)!;
      }
    } else if (m.type === 'ADJUST') {
      const after = num(m.after_qty);
      const diff = after - running;
      if (diff > 0) {
        inQty = diff;
        totalIn += diff;
      } else if (diff < 0) {
        outQty = Math.abs(diff);
        totalOut += Math.abs(diff);
      }
      running = after;
      if (!desc) desc = 'ปรับปรุงยอดสต็อก';
    }
    entries.push({
      date: d,
      dateTh: thaiDateFull(d),
      description: desc,
      inQty,
      outQty,
      balance: running,
      actor: displayActor,
      refDoc: refDoc,
    });
  }

  const settings = await readSettings(env);
  return {
    ok: true as const,
    data: {
      schoolName: settings.SchoolName || 'มหาวิทยาลัยสวนดุสิต ศูนย์การศึกษาลำปาง',
      affiliation: settings.Affiliation || 'มหาวิทยาลัยสวนดุสิต',
      fiscalYear,
      dateRange: { from: fromDate, to: toDate },
      material: {
        ID: mat.ID,
        Code: String(mat.Code ?? ''),
        Name: mat.Name,
        Unit: mat.Unit,
        UnitPrice: num(mat.UnitPrice),
        Category: mat.Category,
        MaterialType: mat.MaterialType || '',
        SizeSpec: mat.SizeSpec || '',
        StorageLocation: mat.StorageLocation || '',
        StockQty: num(mat.StockQty),
      },
      openingBalance: periodOpening,
      summary: { totalIn, totalOut, currentBalance: running },
      entries,
    },
  };
}

registerRpc('apiGetStockCard', 'officer', (ctx, args) =>
  safe('apiGetStockCard', () => stockCard(ctx.env, args[0], args[1])),
);

/* ============================== CSV EXPORT ============================== */
function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(
      row
        .map((v) => {
          const s = String(v === null || v === undefined ? '' : v);
          return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    );
  }
  return '﻿' + lines.join('\n');
}

/** base64 of the UTF-8 bytes (btoa alone throws on non-Latin1 text). */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

registerRpc('apiExportCSV', 'admin', (ctx, args) =>
  safe('apiExportCSV', async () => {
    const type = args[0];
    const filter = asObj(args[1]);
    const today = todayBkk();
    let headers: string[];
    let rows: unknown[][];
    let filename: string;

    if (type === 'materials') {
      const data = await listMaterials(ctx);
      headers = ['รหัส', 'ชื่อพัสดุ', 'หมวดหมู่', 'หน่วย', 'ราคา/หน่วย', 'คงเหลือ', 'จุดสั่งซื้อ', 'สถานะ'];
      rows = data.map((m) => [m.Code, m.Name, m.Category, m.Unit, m.UnitPrice, m.StockQty, m.MinQty, m.StockState]);
      filename = `materials_${today}.csv`;
    } else if (type === 'requests') {
      const data = await listRequests(ctx.env, filter);
      headers = ['เลขที่', 'วันที่', 'ผู้ขอ', 'ฝ่าย', 'วัตถุประสงค์', 'จำนวนรายการ', 'มูลค่า', 'สถานะ'];
      rows = data.map((r) => [r.DocNo, r.RequestDate, r.FullName, r.Department, r.Purpose, r.ItemCount, r.TotalAmount, r.Status]);
      filename = `requests_${today}.csv`;
    } else if (type === 'stock_movements') {
      const data = await stockMovements(ctx.env, filter);
      headers = ['วันที่', 'รหัส', 'ชื่อ', 'ประเภท', 'จำนวน', 'ก่อน', 'หลัง', 'อ้างอิง', 'หมายเหตุ', 'ผู้ทำ'];
      rows = data.map((r) => [r.CreatedAt, r.Code, r.Name, r.Type, r.Qty, r.BeforeQty, r.AfterQty, r.RefDoc, r.Note, r.Actor]);
      filename = `stock_movements_${today}.csv`;
    } else if (type === 'audit') {
      const data = await auditLog(ctx.env, filter);
      headers = ['วันที่', 'การกระทำ', 'Entity', 'EntityID', 'รายละเอียด', 'ผู้ทำ'];
      rows = data.map((r) => [r.CreatedAt, r.Action, r.Entity, r.EntityID, r.Detail, r.Actor]);
      filename = `audit_log_${today}.csv`;
    } else if (type === 'account') {
      const res = await inventoryAccount(ctx, filter);
      headers = ['รหัส', 'รายการ', 'หมวดหมู่', 'ยอดยกมา', 'หน่วย', 'ราคา', 'รวมยกมา', 'ซื้อ', 'รวมซื้อ', 'ใช้ไป', 'รวมใช้', 'คงเหลือ', 'มูลค่าคงเหลือ'];
      rows = res.data.map((x) => [
        x.Code, x.Name, x.Category, x.OpeningQty, x.Unit, x.UnitPrice, x.OpeningAmount,
        x.PurchaseQty, x.PurchaseAmount, x.UsedQty, x.UsedAmount, x.RemainQty, x.RemainAmount,
      ]);
      filename = `inventory_account_${today}.csv`;
    } else if (type === 'stock_card') {
      const res = await stockCard(ctx.env, filter.materialId, filter);
      if (!res.ok) return res;
      headers = ['วันที่', 'รายการ', 'รับ', 'จ่าย', 'คงเหลือ', 'ผู้ลงชื่อ/ผู้ทำ', 'เอกสารอ้างอิง'];
      rows = res.data.entries.map((e) => [e.dateTh || e.date, e.description, e.inQty || '', e.outQty || '', e.balance, e.actor || '', e.refDoc || '']);
      filename = `stock_card_${res.data.material.Code || 'item'}_${today}.csv`;
    } else {
      return fail('ประเภท export ไม่ถูกต้อง');
    }

    return { ok: true, filename, base64: base64Utf8(toCsv(headers, rows)), mimeType: 'text/csv;charset=utf-8' };
  }),
);
