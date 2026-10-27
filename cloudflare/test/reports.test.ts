import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import '../src/api/reports';

const SALT = 'SALT';
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const legacyHash = async (pw: string) =>
  'sha256$' + hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${SALT}|${pw}`)));

const post = (fn: string, args: unknown[], cookie?: string) =>
  SELF.fetch(
    new Request(`https://example.com/api/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ args }),
    }),
  );

let officer = '';
let admin = '';
const asOfficer = async (fn: string, ...args: unknown[]) => (await post(fn, args, officer)).json() as Promise<any>;
const asAdmin = async (fn: string, ...args: unknown[]) => (await post(fn, args, admin)).json() as Promise<any>;
const run = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).run();

const T = '2026-01-01 00:00:00';
const mat = (id: string, code: string, name: string, cat: string, price: number, opening: number, stock: number, min = 0) =>
  run(
    "INSERT INTO materials (id, code, name, unit, unit_price, stock_qty, min_qty, opening_qty, category, created_at, updated_at) VALUES (?, ?, ?, 'ชิ้น', ?, ?, ?, ?, ?, ?, ?)",
    id, code, name, price, stock, min, opening, cat, T, T,
  );
const purchase = (id: string, m: string, qty: number, date: string) =>
  run(
    "INSERT INTO purchases (id, material_id, qty, purchase_date, created_at) VALUES (?, ?, ?, ?, ?)",
    id, m, qty, date, `${date} 09:00:00`,
  );
const req = (id: string, status: string, date: string, userId: string | null, items: [string, string, number, number][]) =>
  env.DB.batch([
    env.DB.prepare(
      "INSERT INTO requests (id, doc_no, request_date, user_id, full_name, status, stock_applied, created_at, updated_at) VALUES (?, ?, ?, ?, 'ผู้ขอ', ?, ?, ?, ?)",
    ).bind(id, `DOC-${id}`, date, userId, status, status === 'APPROVED' ? 1 : 0, `${date} 10:00:00`, `${date} 10:00:00`),
    ...items.map(([itemId, m, qty, price], i) =>
      env.DB.prepare(
        "INSERT INTO request_items (id, request_id, material_id, code, name, unit, qty, unit_price, total_price) SELECT ?, ?, id, code, name, unit, ?, ?, ? FROM materials WHERE id = ?",
      ).bind(`${id}-${itemId}${i}`, id, qty, price, qty * price, m),
    ),
  ]);
const move = (id: string, m: string, type: string, qty: number, after: number, at: string, note = '') =>
  run(
    "INSERT INTO stock_movements (id, material_id, code, name, type, qty, after_qty, ref_doc, note, actor, created_at) VALUES (?, ?, 'c', 'n', ?, ?, ?, 'REF', ?, 'a', ?)",
    id, m, type, qty, after, note, at,
  );

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM stock_movements'),
    env.DB.prepare('DELETE FROM purchases'),
    env.DB.prepare('DELETE FROM opening_balances'),
    env.DB.prepare('DELETE FROM requests'),
    env.DB.prepare('DELETE FROM materials'),
    env.DB.prepare('DELETE FROM users'),
  ]);
  const pw = await legacyHash('1234');
  for (const [id, name, role] of [['U-R1', 'off1', 'officer'], ['U-R2', 'adm1', 'admin']]) {
    await run(
      "INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at) VALUES (?, ?, ?, 'N', ?, ?, ?)",
      id, name, pw, role, T, T,
    );
  }
  const login = async (username: string) =>
    ((await post('apiLogin', [{ username, password: '1234' }])).headers.get('set-cookie') ?? '').split(';')[0];
  officer = await login('off1');
  admin = await login('adm1');

  // Fixture: FY2569 = 2025-10-01..2026-09-30, FY2570 starts 2026-10-01
  await mat('M1', 'P-1', 'ปากกา', 'วัสดุสำนักงาน', 10, 5, 20);
  await mat('M2', 'P-2', 'กระดาษ', 'วัสดุสำนักงาน', 100, 0, 7, 10);
  await mat('M3', 'H-1', 'สบู่', 'วัสดุงานบ้าน', 20, 8, 3);
  await purchase('P1', 'M1', 4, '2025-09-30'); // FY2568
  await purchase('P2', 'M1', 10, '2025-10-01');
  await purchase('P3', 'M1', 5, '2026-03-15');
  await purchase('P4', 'M1', 7, '2026-10-01'); // FY2570
  await purchase('P5', 'M2', 20, '2026-01-10');
  await req('R1', 'APPROVED', '2025-11-01', 'U-R1', [['a', 'M1', 3, 10], ['b', 'M2', 5, 100]]);
  await req('R2', 'APPROVED', '2026-09-30', 'U-R1', [['a', 'M1', 2, 10]]);
  await req('R3', 'APPROVED', '2026-10-02', 'U-R2', [['a', 'M1', 4, 10]]); // FY2570
  await req('R4', 'PENDING', '2026-01-05', 'U-R1', [['a', 'M1', 100, 10], ['b', 'M2', 100, 100]]);
  await req('R5', 'APPROVED', '2025-09-29', 'U-R2', [['a', 'M2', 50, 100]]); // FY2568
  await req('R6', 'APPROVED', '2026-02-01', 'U-R2', [['a', 'M3', 4, 20]]);
  await req('R7', 'REJECTED', '2026-02-02', 'U-R1', [['a', 'M3', 6, 20]]);
});

const byCode = (r: any, code: string) => r.data.find((x: any) => x.Code === code);

describe('inventory report', () => {
  it('inventory report FY 2569', async () => {
    const r = await asOfficer('apiGetInventoryReport', { fiscalYear: 2569, reportDate: '2026-09-30' });
    expect(r.ok).toBe(true);
    expect(r.reportInfo).toMatchObject({
      fiscalYear: 2569,
      reportDate: '2026-09-30',
      reportDateThai: '30 กันยายน 2569',
      startDate: '2025-10-01',
      endDate: '2026-09-30',
      category: '',
    });
    expect(r.data.map((x: any) => [x.seq, x.Code, x.OpeningQty, x.PurchaseQty, x.UsedQty, x.RemainQty, x.Amount])).toEqual([
      [1, 'H-1', 8, 0, 4, 4, 80],
      [2, 'P-2', 0, 20, 5, 15, 1500],
      [3, 'P-1', 5, 15, 5, 15, 150],
    ]);
    expect(r.categorySummary).toEqual([
      { category: 'วัสดุงานบ้าน', totalAmount: 80 },
      { category: 'วัสดุสำนักงาน', totalAmount: 1650 },
    ]);
    expect(r.total).toEqual({ OpeningQty: 13, PurchaseQty: 35, UsedQty: 14, RemainQty: 34, Amount: 1730 });
    expect(r.asOf).toBe('2026-09-30');
  });

  it('report date caps the period and the category filter applies', async () => {
    const r = await asOfficer('apiGetInventoryReport', { fiscalYear: 2569, reportDate: '2026-02-28', category: 'วัสดุสำนักงาน' });
    expect(r.reportInfo.endDate).toBe('2026-02-28');
    expect(r.data).toHaveLength(2);
    expect(byCode(r, 'P-1')).toMatchObject({ PurchaseQty: 10, UsedQty: 3, RemainQty: 12 });
  });

  it('remain is clamped at zero', async () => {
    await req('R8', 'APPROVED', '2026-04-01', 'U-R1', [['a', 'M3', 50, 20]]);
    const r = await asOfficer('apiGetInventoryReport', { fiscalYear: 2569, reportDate: '2026-09-30' });
    expect(byCode(r, 'H-1')).toMatchObject({ UsedQty: 54, RemainQty: 0, Amount: 0 });
  });

  it('without purchases rows, PurchaseQty is 0 and OpeningQty comes from opening_qty', async () => {
    await run(
      "INSERT INTO materials (id, code, name, unit, unit_price, stock_qty, min_qty, opening_qty, order_qty, acquired_date, category, created_at, updated_at) VALUES (?, ?, ?, 'รีม', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      'M99', 'ว.001', 'กระดาษ A4', 120, 50, 5, 50, 50, '2026-10-19', 'วัสดุสำนักงาน', T, T,
    );
    const r = await asOfficer('apiGetInventoryReport', { fiscalYear: 2570, reportDate: '2026-10-19' });
    const row = byCode(r, 'ว.001');
    expect(row).toBeDefined();
    expect(row.OpeningQty).toBe(50);
    expect(row.PurchaseQty).toBe(0);
    expect(row.RemainQty).toBe(50);
  });

  it('pending requests are not counted as used', async () => {
    const r = await asOfficer('apiGetInventoryReport', { fiscalYear: 2569, reportDate: '2026-09-30' });
    expect(byCode(r, 'P-1').UsedQty).toBe(5); // R4 pending (100) and R7 rejected excluded
    expect(byCode(r, 'H-1').UsedQty).toBe(4);
    const dash = await asOfficer('apiGetAdminDashboard');
    expect(dash.counters).toEqual({ approved: 5, pending: 1, rejected: 1 });
  });

  it('opening balance overrides materials.opening_qty', async () => {
    await run("INSERT INTO opening_balances (id, material_id, fiscal_year, opening_qty, created_at, updated_at) VALUES ('OB1', 'M3', 2569, 10, ?, ?)", T, T);
    await run("INSERT INTO opening_balances (id, material_id, fiscal_year, opening_qty, created_at, updated_at) VALUES ('OB2', 'M3', 2570, 99, ?, ?)", T, T);
    const r = await asOfficer('apiGetInventoryReport', { fiscalYear: 2569, reportDate: '2026-09-30' });
    expect(byCode(r, 'H-1')).toMatchObject({ OpeningQty: 10, RemainQty: 6, Amount: 120 });
    expect(byCode(r, 'P-1').OpeningQty).toBe(5);
  });

  it('dayOut sums APPROVED request items by RequestDate day in the report month', async () => {
    // R1 (M1 3, M2 5) is 2025-11-01. Add more in November 2025:
    await req('R9', 'APPROVED', '2025-11-01', 'U-R1', [['a', 'M1', 4, 10]]); // same day as R1 -> M1 day1 = 7
    await req('R10', 'APPROVED', '2025-11-15', 'U-R1', [['a', 'M1', 2, 10]]);
    await req('R11', 'PENDING', '2025-11-15', 'U-R1', [['a', 'M1', 99, 10]]); // excluded
    // approved much later (Mar 2026) but dated in November -> counted on its RequestDate day
    await req('R12', 'APPROVED', '2025-11-20', 'U-R1', [['a', 'M2', 1, 100]]);
    await run("UPDATE requests SET approved_date = '2026-03-01' WHERE id = 'R12'");
    const r = await asOfficer('apiGetInventoryReport', { fiscalYear: 2569, reportDate: '2025-11-30' });
    expect(r.dayOut).toEqual({ M1: { 1: 7, 15: 2 }, M2: { 1: 5, 20: 1 } });
    const oct = await asOfficer('apiGetInventoryReport', { fiscalYear: 2569, reportDate: '2026-09-30' });
    expect(oct.dayOut).toEqual({ M1: { 30: 2 } });
  });

  it('requires a session', async () => {
    const r = await (await post('apiGetInventoryReport', [{}])).json<any>();
    expect(r.code).toBe('AUTH');
  });
});

describe('stock card', () => {
  beforeEach(async () => {
    // inserted out of order on purpose; M1 fiscal opening 5
    await move('S4', 'M1', 'ADJUST', 2, 18, '2026-03-01 09:00:00');
    await move('S1', 'M1', 'IN', 10, 15, '2025-10-02 09:00:00');
    await move('S3', 'M1', 'ADJUST', 8, 20, '2025-12-01 09:00:00');
    await move('S2', 'M1', 'OUT', 3, 12, '2025-11-01 09:00:00');
    await move('S5', 'M1', 'OUT', 5, 15, '2026-01-10 10:00:00');
    await move('S6', 'M1', 'IN', 5, 20, '2026-02-01 10:00:00', 'ซื้อเพิ่ม');
    await move('S7', 'M1', 'IN', 99, 999, '2026-10-05 10:00:00'); // outside range
    await move('S8', 'M2', 'IN', 1, 1, '2026-02-01 10:00:00'); // other material
  });

  it('stock card opening replays movements before from', async () => {
    const r = await asOfficer('apiGetStockCard', 'M1', { fiscalYear: 2569, from: '2026-01-01' });
    expect(r.ok).toBe(true);
    const d = r.data;
    // 5 +10 (IN) -3 (OUT) -> ADJUST sets 20
    expect(d.openingBalance).toBe(20);
    expect(d.dateRange).toEqual({ from: '2026-01-01', to: '2026-09-30' });
    expect(d.fiscalYear).toBe(2569);
    expect(d.entries.map((e: any) => [e.description, e.inQty, e.outQty, e.balance, e.date])).toEqual([
      ['ยอดยกมา', 20, 0, 20, '2026-01-01'],
      ['จ่ายตามใบขอเบิก (REF)', 0, 5, 15, '2026-01-10'],
      ['ซื้อเพิ่ม', 5, 0, 20, '2026-02-01'],
      ['ปรับปรุงยอดสต็อก', 0, 2, 18, '2026-03-01'],
    ]);
    expect(d.entries[0]).toMatchObject({ dateTh: '1 มกราคม 2569', actor: '-', refDoc: '' });
    expect(d.summary).toEqual({ totalIn: 5, totalOut: 7, currentBalance: 18 });
    expect(d.material).toMatchObject({ ID: 'M1', Code: 'P-1', UnitPrice: 10, StockQty: 20 });
  });

  it('defaults to the whole fiscal year and validates input', async () => {
    const r = await asOfficer('apiGetStockCard', 'M1', { fiscalYear: 2569 });
    expect(r.data.dateRange.from).toBe('2025-10-01');
    expect(r.data.openingBalance).toBe(5);
    expect(r.data.entries).toHaveLength(7);
    expect(await asOfficer('apiGetStockCard', '', {})).toEqual({ ok: false, message: 'กรุณาระบุรหัสวัสดุ (Material ID)' });
    expect(await asOfficer('apiGetStockCard', 'NOPE', {})).toEqual({ ok: false, message: 'ไม่พบข้อมูลพัสดุในระบบ' });
  });
});

describe('dashboards', () => {
  it('admin dashboard remainValue matches inventory account remainValue for current fiscal year', async () => {
    const r = await asOfficer('apiGetAdminDashboard');
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ totalMaterials: 3, remainValue: 240, usedValue: 5670, usedQty: 68, lowStock: 1 });
    expect(r.counters).toEqual({ approved: 5, pending: 1, rejected: 1 });
    expect(r.chartStatus).toEqual([
      { label: 'อนุมัติแล้ว', value: 5 },
      { label: 'รออนุมัติ', value: 1 },
      { label: 'ปฏิเสธ', value: 1 },
    ]);
    expect(r.chartTop10).toEqual([
      { label: 'กระดาษ', value: 55 },
      { label: 'ปากกา', value: 9 },
      { label: 'สบู่', value: 4 },
    ]);
    expect(r.chartByItem).toHaveLength(3);
    expect(r.materials).toHaveLength(3);
    expect(r.materials[0]).toMatchObject({ Code: 'H-1', StockState: 'OK' });
  });

  it('teacher dashboard is per user', async () => {
    const r = await asOfficer('apiGetTeacherDashboard', 'U-R1');
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ totalRequests: 4 });
    expect(r.counters).toEqual({ approved: 2, pending: 1, rejected: 1 });
    expect(r.chartByItem).toEqual([
      { label: 'ปากกา', value: 5 },
      { label: 'กระดาษ', value: 5 },
    ]);
    expect(r.recent).toHaveLength(4);
    expect(r.recent[0].DocNo).toBe('DOC-R2'); // newest first
    expect(r.recent[0].Items).toEqual([
      { MaterialID: 'M1', Code: 'P-1', Name: 'ปากกา', Unit: 'ชิ้น', Qty: 2, UnitPrice: 10, TotalPrice: 20, Remark: '' },
    ]);
  });

  it('inventory account', async () => {
    const r = await asOfficer('apiGetInventoryAccount', { from: '2025-10-01', to: '2026-09-30' });
    expect(r.ok).toBe(true);
    expect(r.data.map((x: any) => x.Code)).toEqual(['H-1', 'P-1', 'P-2']);
    expect(r.data[1]).toMatchObject({
      OpeningQty: 5, OpeningAmount: 50, PurchaseQty: 15, PurchaseAmount: 150,
      UsedQty: 5, UsedAmount: 50, RemainQty: 15, RemainAmount: 150, StockState: 'OK',
    });
    expect(r.data[2].StockState).toBe('OK');
    expect(r.total).toMatchObject({ OpeningQty: 13, PurchaseQty: 35, UsedQty: 14, RemainQty: 34, RemainAmount: 1730 });
    expect(r.summary).toEqual({ totalMaterials: 3, remainValue: 1730, usedValue: r.total.UsedAmount, lowStock: 0 });
    expect(r.filter).toEqual({ from: '2025-10-01', to: '2026-09-30' });
  });
});

describe('stock movements and audit log', () => {
  beforeEach(async () => {
    await move('S1', 'M1', 'IN', 1, 1, '2026-01-01 08:00:00');
    await move('S2', 'M1', 'OUT', 1, 0, '2026-01-02 08:00:00');
    await move('S3', 'M2', 'IN', 1, 1, '2026-01-03 08:00:00');
  });

  it('filters and orders newest first', async () => {
    const all = await asOfficer('apiGetStockMovements');
    expect(all.data.map((m: any) => m.ID)).toEqual(['S3', 'S2', 'S1']);
    expect((await asOfficer('apiGetStockMovements', { materialId: 'M1' })).data).toHaveLength(2);
    expect((await asOfficer('apiGetStockMovements', { type: 'IN' })).data).toHaveLength(2);
    expect((await asOfficer('apiGetStockMovements', { from: '2026-01-02', to: '2026-01-02' })).data.map((m: any) => m.ID)).toEqual(['S2']);
    expect((await asOfficer('apiGetStockMovements', { q: 'ref' })).data).toHaveLength(3);
    expect((await asOfficer('apiGetStockMovements', { q: "x' OR 1=1 --" })).data).toHaveLength(0);
  });

  it('audit log is admin only and filterable', async () => {
    await run('DELETE FROM audit_log'); // logins above wrote their own rows
    await run("INSERT INTO audit_log (id, action, entity, entity_id, detail, actor, created_at) VALUES ('L1', 'CREATE', 'Request', 'R1', 'สร้างใบ', 'off1', '2026-01-01 08:00:00')");
    await run("INSERT INTO audit_log (id, action, entity, entity_id, detail, actor, created_at) VALUES ('L2', 'DELETE', 'Material', 'M1', 'ลบ', 'adm1', '2026-01-02 08:00:00')");
    expect((await asOfficer('apiGetAuditLog')).code).toBe('FORBIDDEN');
    const all = await asAdmin('apiGetAuditLog');
    expect(all.data.map((x: any) => x.ID)).toEqual(['L2', 'L1']);
    expect((await asAdmin('apiGetAuditLog', { action: 'CREATE' })).data.map((x: any) => x.ID)).toEqual(['L1']);
    expect((await asAdmin('apiGetAuditLog', { q: 'ADM' })).data.map((x: any) => x.ID)).toEqual(['L2']);
  });
});

const decode = (b64: string) => new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

describe('csv export', () => {
  it('CSV starts with BOM', async () => {
    const r = await asAdmin('apiExportCSV', 'materials');
    expect(r.ok).toBe(true);
    expect(r.mimeType).toBe('text/csv;charset=utf-8');
    expect(r.filename).toMatch(/^materials_\d{4}-\d{2}-\d{2}\.csv$/);
    const text = decode(r.base64);
    expect(text.charAt(0)).toBe('﻿');
    const lines = text.slice(1).split('\n');
    expect(lines[0]).toBe('รหัส,ชื่อพัสดุ,หมวดหมู่,หน่วย,ราคา/หน่วย,คงเหลือ,จุดสั่งซื้อ,สถานะ');
    expect(lines[1]).toBe('H-1,สบู่,วัสดุงานบ้าน,ชิ้น,20,3,0,OK');
    expect(lines).toHaveLength(4);
  });

  it('admin-only', async () => {
    const r = await asOfficer('apiExportCSV', 'materials');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FORBIDDEN');
  });

  it('quotes fields and rejects unknown types', async () => {
    await run("UPDATE materials SET name = 'a,b \"q\"' WHERE id = 'M3'");
    const text = decode((await asAdmin('apiExportCSV', 'materials')).base64);
    expect(text.split('\n')[1]).toBe('H-1,"a,b ""q""",วัสดุงานบ้าน,ชิ้น,20,3,0,OK');
    expect(await asAdmin('apiExportCSV', 'nope')).toEqual({ ok: false, message: 'ประเภท export ไม่ถูกต้อง' });
  });

  it('headers of the other types', async () => {
    await move('S1', 'M1', 'IN', 1, 1, '2026-01-01 08:00:00');
    const head = async (type: string, filter?: unknown) =>
      decode((await asAdmin('apiExportCSV', type, filter)).base64).slice(1).split('\n')[0];
    expect(await head('requests')).toBe('เลขที่,วันที่,ผู้ขอ,ฝ่าย,วัตถุประสงค์,จำนวนรายการ,มูลค่า,สถานะ');
    expect(await head('stock_movements')).toBe('วันที่,รหัส,ชื่อ,ประเภท,จำนวน,ก่อน,หลัง,อ้างอิง,หมายเหตุ,ผู้ทำ');
    expect(await head('audit')).toBe('วันที่,การกระทำ,Entity,EntityID,รายละเอียด,ผู้ทำ');
    expect(await head('account')).toBe('รหัส,รายการ,หมวดหมู่,ยอดยกมา,หน่วย,ราคา,รวมยกมา,ซื้อ,รวมซื้อ,ใช้ไป,รวมใช้,คงเหลือ,มูลค่าคงเหลือ');
    expect(await head('stock_card', { materialId: 'M1', fiscalYear: 2569 })).toBe('วันที่,รายการ,รับ,จ่าย,คงเหลือ,ผู้ลงชื่อ/ผู้ทำ,เอกสารอ้างอิง');
    const card = await asAdmin('apiExportCSV', 'stock_card', { materialId: 'M1', fiscalYear: 2569 });
    expect(card.filename).toMatch(/^stock_card_P-1_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(decode(card.base64).split('\n')[1]).toBe('1 ตุลาคม 2568,ยอดยกมา,5,,5,-,');
  });
});
