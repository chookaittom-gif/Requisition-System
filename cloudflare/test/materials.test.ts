import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { todayBkk } from '../src/lib/time';

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

let cookie = '';
const rpc = async (fn: string, args: unknown[]) => (await post(fn, args, cookie)).json() as Promise<any>;
const rows = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<any>()).results;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM stock_movements'),
    env.DB.prepare('DELETE FROM purchases'),
    env.DB.prepare('DELETE FROM opening_balances'),
    env.DB.prepare('DELETE FROM materials'),
    env.DB.prepare('DELETE FROM categories'),
    env.DB.prepare('DELETE FROM users'),
  ]);
  await env.DB.prepare(
    "INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at) VALUES ('U-T1', 'off1', ?, 'O', 'officer', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
  )
    .bind(await legacyHash('1234'))
    .run();
  const res = await post('apiLogin', [{ username: 'off1', password: '1234' }]);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
});

const create = (over: Record<string, unknown> = {}) =>
  rpc('apiSaveMaterials', [
    [{ action: 'create', Code: 'A-1', Name: 'ปากกา', Unit: 'ด้าม', UnitPrice: 10, StockQty: 5, MinQty: 2, Category: 'เครื่องเขียน', ...over }],
  ]);

describe('materials', () => {
  it('create material logs opening IN', async () => {
    expect((await create()).ok).toBe(true);
    const [m] = await rows('SELECT * FROM materials');
    expect(m.opening_qty).toBe(5);
    expect(m.material_type).toBe('เครื่องเขียน');
    const mv = await rows('SELECT * FROM stock_movements');
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ type: 'IN', qty: 5, before_qty: 0, after_qty: 5, note: 'จัดซื้อ', actor: 'off1', material_id: m.id });
    expect((await rows("SELECT * FROM audit_log WHERE action='CREATE' AND entity='Material'")).length).toBe(1);
  });

  it('create material with OrderQty inserts into purchases and zeroes opening_qty', async () => {
    const res = await create({ Code: 'A-2', OrderQty: 50, StockQty: 50, AcquiredDate: '2026-10-19' });
    expect(res.ok).toBe(true);
    const [m] = await rows("SELECT * FROM materials WHERE code = 'A-2'");
    expect(m.opening_qty).toBe(0);
    expect(m.order_qty).toBe(50);
    expect(m.stock_qty).toBe(50);
    const [p] = await rows("SELECT * FROM purchases WHERE material_id = ?", m.id);
    expect(p).toMatchObject({
      code: 'A-2',
      qty: 50,
      unit_price: 10,
      amount: 500,
      purchase_date: '2026-10-19',
      note: 'จัดซื้อรับเข้า (สร้างพัสดุ)',
      actor: 'off1',
    });
  });

  it('duplicate code rejected with legacy message and nothing written', async () => {
    await create();
    const r = await create({ Name: 'อื่น' });
    expect(r).toEqual({ ok: false, message: 'รหัสพัสดุ "A-1" มีอยู่แล้วในระบบ' });
    expect(await rows('SELECT * FROM materials')).toHaveLength(1);
  });

  it('editing stock logs ADJUST |diff|', async () => {
    await create();
    const [m] = await rows('SELECT id FROM materials');
    const r = await rpc('apiSaveMaterials', [
      [{ action: 'update', ID: m.id, Code: 'A-1', Name: 'ปากกา', Unit: 'ด้าม', UnitPrice: 10, StockQty: 3, MinQty: 2, Category: 'x' }],
    ]);
    expect(r.ok).toBe(true);
    const [mv] = await rows("SELECT * FROM stock_movements WHERE type='ADJUST'");
    expect(mv).toMatchObject({ qty: 2, before_qty: 5, after_qty: 3, note: 'ปรับยอดจากฟอร์มแก้ไข' });
    expect((await rows('SELECT stock_qty FROM materials'))[0].stock_qty).toBe(3);
  });

  it('negative numbers give a Thai validation message', async () => {
    const r = await create({ StockQty: -1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('VALIDATION');
    expect(r.message).not.toMatch(/SQLITE|CHECK/);
  });

  it('non-string ImageUrl is VALIDATION', async () => {
    const r = await create({ ImageUrl: { base64: 'abc' } });
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(await rows('SELECT * FROM materials')).toHaveLength(0);
  });

  it('actor comes from session', async () => {
    await create({ actor: 'hacker' });
    expect((await rows('SELECT actor FROM stock_movements'))[0].actor).toBe('off1');
    expect((await rows('SELECT actor FROM audit_log WHERE entity = ?', 'Material'))[0].actor).toBe('off1');
  });

  it('low stock list', async () => {
    await create({ StockQty: 1 });
    await create({ Code: 'B-1', Name: 'ดินสอ', StockQty: 50 });
    const all = await rpc('apiGetMaterials', []);
    expect(all.data.map((m: any) => m.Code)).toEqual(['A-1', 'B-1']);
    const low = await rpc('apiGetLowStock', []);
    expect(low.data).toHaveLength(1);
    expect(low.data[0]).toMatchObject({ Code: 'A-1', StockState: 'LOW', StockQty: 1, MinQty: 2 });
  });

  it('public reads need no session', async () => {
    expect(((await (await post('apiGetMaterials', [])).json()) as any).ok).toBe(true);
    expect(((await (await post('apiGetCategories', [])).json()) as any).ok).toBe(true);
  });

  it('deleting a material keeps history', async () => {
    await create();
    const [m] = await rows('SELECT id FROM materials');
    const r = await rpc('apiDeleteMaterials', [[m.id]]);
    expect(r).toEqual({ ok: true, message: 'ลบข้อมูลพัสดุเรียบร้อยแล้ว' });
    const [mv] = await rows('SELECT * FROM stock_movements');
    expect(mv.material_id).toBeNull();
    expect(mv.code).toBe('A-1');
    expect(mv.name).toBe('ปากกา');
    expect((await rows("SELECT actor FROM audit_log WHERE action='DELETE'"))[0].actor).toBe('off1');
  });
});

describe('purchases', () => {
  it('purchase adds stock', async () => {
    await create({ StockQty: 3 });
    const [m] = await rows('SELECT id FROM materials');
    const r = await rpc('apiPurchaseMaterials', [[{ MaterialID: m.id, Qty: 4, Note: '' }]]);
    expect(r).toEqual({ ok: true, message: 'บันทึกการจัดซื้อพัสดุเรียบร้อยแล้ว' });
    expect((await rows('SELECT stock_qty FROM materials'))[0].stock_qty).toBe(7);
    const [p] = await rows('SELECT * FROM purchases');
    expect(p).toMatchObject({ qty: 4, unit_price: 10, amount: 40, purchase_date: todayBkk(), actor: 'off1', code: 'A-1' });
    const [mv] = await rows("SELECT * FROM stock_movements WHERE note = 'จัดซื้อเพิ่ม'");
    expect(mv).toMatchObject({ type: 'IN', qty: 4, before_qty: 3, after_qty: 7 });
    expect((await rows("SELECT detail FROM audit_log WHERE action='PURCHASE'"))[0].detail).toBe('A-1 +4');
  });

  it('same material twice in one list accumulates', async () => {
    await create({ StockQty: 0 });
    const [m] = await rows('SELECT id FROM materials');
    await rpc('apiPurchaseMaterials', [[{ MaterialID: m.id, Qty: 2 }, { MaterialID: m.id, Qty: 3 }]]);
    expect((await rows('SELECT stock_qty FROM materials'))[0].stock_qty).toBe(5);
    const mv = await rows("SELECT before_qty, after_qty FROM stock_movements WHERE type='IN' ORDER BY after_qty");
    expect(mv).toEqual([{ before_qty: 0, after_qty: 2 }, { before_qty: 2, after_qty: 5 }]);
  });

  it('negative qty is VALIDATION', async () => {
    await create();
    const [m] = await rows('SELECT id FROM materials');
    expect(await rpc('apiPurchaseMaterials', [[{ MaterialID: m.id, Qty: -1 }]])).toMatchObject({ ok: false, code: 'VALIDATION' });
  });
});

describe('categories and opening balance', () => {
  it('category create/update/delete and thai sort', async () => {
    await rpc('apiSaveCategory', [{ Name: 'ข' }]);
    await rpc('apiSaveCategory', [{ Name: 'ก' }]);
    expect((await rpc('apiGetCategories', [])).data.map((c: any) => c.Name)).toEqual(['ก', 'ข']);
    const [c] = await rows("SELECT id FROM categories WHERE name='ก'");
    expect(await rpc('apiSaveCategory', [{ action: 'update', ID: c.id, Name: 'ค' }])).toEqual({ ok: true, message: 'บันทึกหมวดหมู่เรียบร้อยแล้ว' });
    expect(await rpc('apiSaveCategory', [{ action: 'delete', ID: c.id, Name: 'ค' }])).toEqual({ ok: true, message: 'ลบหมวดหมู่เรียบร้อยแล้ว' });
    expect(await rpc('apiSaveCategory', [{ Name: ' ' }])).toEqual({ ok: false, message: 'กรุณาระบุชื่อหมวดหมู่' });
  });

  it('opening balance upsert', async () => {
    await create();
    const [m] = await rows('SELECT id FROM materials');
    await rpc('apiSaveOpeningBalance', [{ MaterialID: m.id, FiscalYear: 2569, OpeningQty: 5 }]);
    const r = await rpc('apiSaveOpeningBalance', [{ MaterialID: m.id, FiscalYear: '2569', OpeningQty: 9, actor: 'hacker' }]);
    expect(r).toEqual({ ok: true, message: 'บันทึกยอดยกมาเรียบร้อยแล้ว' });
    const ob = await rows('SELECT * FROM opening_balances');
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({ opening_qty: 9, fiscal_year: 2569, set_by: 'off1' });
    expect(await rpc('apiSaveOpeningBalance', [{ MaterialID: '', FiscalYear: 2569 }])).toEqual({ ok: false, message: 'กรุณาระบุรหัสพัสดุและปีงบประมาณ' });
  });
});

describe('movementStmt guard', () => {
  it('writes nothing when the request stock_txn does not match', async () => {
    const { movementStmt } = await import('../src/lib/stock');
    await create();
    const [m] = await rows('SELECT id FROM materials');
    await env.DB.prepare(
      "INSERT INTO requests (id, doc_no, request_date, created_at, updated_at, stock_txn) VALUES ('R-1', 'REQ-1', '2026-01-01', 'x', 'x', 'T1')",
    ).run();
    const base = { materialId: m.id, type: 'OUT' as const, qty: 2, refDoc: 'REQ-1', note: '', actor: 'a', guardRequestId: 'R-1' };
    await env.DB.batch([movementStmt(env.DB, { ...base, guardTxn: 'WRONG' })]);
    expect(await rows("SELECT * FROM stock_movements WHERE type='OUT'")).toHaveLength(0);
    await env.DB.batch([movementStmt(env.DB, { ...base, guardTxn: 'T1' })]);
    const [mv] = await rows("SELECT * FROM stock_movements WHERE type='OUT'");
    expect(mv).toMatchObject({ qty: 2, before_qty: 5, after_qty: 3 });
  });
});

describe('fix round 1', () => {
  it('null imageFile/docFile is accepted; base64 payload rejected', async () => {
    expect((await create({ imageFile: null, docFile: null })).ok).toBe(true);
    const r = await create({ Code: 'Z', imageFile: { base64: 'abc' } });
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION' });
  });

  it('update with unchanged StockQty writes no movement; changed writes one ADJUST', async () => {
    await create();
    const [m] = await rows('SELECT id FROM materials');
    const upd = (q: number) =>
      rpc('apiSaveMaterials', [[{ action: 'update', ID: m.id, Code: 'A-1', Name: 'ปากกา', Unit: 'ด้าม', UnitPrice: 10, StockQty: q, MinQty: 2, Category: 'x' }]]);
    expect((await upd(5)).ok).toBe(true);
    expect(await rows("SELECT * FROM stock_movements WHERE type='ADJUST'")).toHaveLength(0);
    // stock drifts after any earlier read: movement must use live value
    await env.DB.prepare('UPDATE materials SET stock_qty = 8').run();
    expect((await upd(6)).ok).toBe(true);
    const adj = await rows("SELECT * FROM stock_movements WHERE type='ADJUST'");
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ qty: 2, before_qty: 8, after_qty: 6 });
  });

  it('movementStmt throws on half-specified guard', async () => {
    const { movementStmt } = await import('../src/lib/stock');
    const base = { materialId: 'M', type: 'OUT' as const, qty: 1, refDoc: '', note: '', actor: 'a' };
    expect(() => movementStmt(env.DB, { ...base, guardRequestId: 'R' })).toThrow();
    expect(() => movementStmt(env.DB, { ...base, guardTxn: 'T' })).toThrow();
  });
});

describe('category code', () => {
  it('creates category with code, rejects duplicate code, and updates code', async () => {
    // 1. Create with code
    const r1 = await rpc('apiSaveCategory', [{ action: 'create', Name: 'หมวดเครื่องมือช่าง', Code: 'TOOL' }]);
    expect(r1.ok).toBe(true);

    const list1 = await rpc('apiGetCategories', []);
    expect(list1.ok).toBe(true);
    const cat = list1.data.find((c: any) => c.Name === 'หมวดเครื่องมือช่าง');
    expect(cat).toBeTruthy();
    expect(cat.Code).toBe('TOOL');

    // 2. Reject duplicate code
    const dupCode = await rpc('apiSaveCategory', [{ action: 'create', Name: 'หมวดช่างกล', Code: 'TOOL' }]);
    expect(dupCode.ok).toBe(false);
    expect(dupCode.message).toContain('มีอยู่แล้วในระบบ');

    // 3. Reject duplicate name
    const dupName = await rpc('apiSaveCategory', [{ action: 'create', Name: 'หมวดเครื่องมือช่าง', Code: 'MECH' }]);
    expect(dupName.ok).toBe(false);
    expect(dupName.message).toContain('มีอยู่แล้วในระบบ');

    // 4. Update code
    const upd = await rpc('apiSaveCategory', [{ action: 'update', ID: cat.ID, Name: 'หมวดเครื่องมือช่างและอุปกรณ์', Code: 'MECH' }]);
    expect(upd.ok).toBe(true);

    const list2 = await rpc('apiGetCategories', []);
    const cat2 = list2.data.find((c: any) => c.ID === cat.ID);
    expect(cat2.Name).toBe('หมวดเครื่องมือช่างและอุปกรณ์');
    expect(cat2.Code).toBe('MECH');

    // 5. Default fallback code for default office categories
    await env.DB.prepare("INSERT INTO categories (id, name, created_at) VALUES ('CAT-DOC', 'หมวดงานเอกสารและกระดาษ', '2026-01-01 00:00:00')").run();
    const list3 = await rpc('apiGetCategories', []);
    const docCat = list3.data.find((c: any) => c.Name === 'หมวดงานเอกสารและกระดาษ');
    expect(docCat.Code).toBe('DOC');
  });
});

