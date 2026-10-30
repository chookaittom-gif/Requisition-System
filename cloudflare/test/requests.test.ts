import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import '../src/api/requests';
import { handleRpc } from '../src/rpc';

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
const guest = async (fn: string, args: unknown[]) => (await post(fn, args)).json() as Promise<any>;
const rows = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<any>()).results;
const stock = async (id: string) => (await rows('SELECT stock_qty FROM materials WHERE id = ?', id))[0].stock_qty;

const T = '2026-01-01 00:00:00';
const addMat = (id: string, code: string, name: string, qty: number, price = 10) =>
  env.DB.prepare(
    "INSERT INTO materials (id, code, name, unit, unit_price, stock_qty, created_at, updated_at) VALUES (?, ?, ?, 'ชิ้น', ?, ?, ?, ?)",
  )
    .bind(id, code, name, price, qty, T, T)
    .run();

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM stock_movements'),
    env.DB.prepare('DELETE FROM requests'),
    env.DB.prepare('DELETE FROM materials'),
    env.DB.prepare('DELETE FROM users'),
  ]);
  await env.DB.prepare(
    "INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at) VALUES ('U-T1', 'off1', ?, 'O', 'officer', ?, ?)",
  )
    .bind(await legacyHash('1234'), T, T)
    .run();
  const res = await post('apiLogin', [{ username: 'off1', password: '1234' }]);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  await addMat('M-A', 'A-1', 'ปากกา', 10);
  await addMat('M-B', 'B-1', 'ดินสอ', 2);
});

const createReq = (items: unknown[], over: Record<string, unknown> = {}, as: 'officer' | 'guest' = 'officer') =>
  (as === 'officer' ? rpc : guest)('apiCreateRequest', [{ FullName: 'สมชาย', Department: 'ฝ่าย', Purpose: 'ใช้งาน', items, ...over }]);
const lastReq = async () => (await rows('SELECT * FROM requests ORDER BY created_at DESC, doc_no DESC LIMIT 1'))[0];
const status = (id: string, s: string, extra: Record<string, unknown> = {}) =>
  rpc('apiUpdateRequestStatus', [[{ ID: id, Status: s, ...extra }]]);

describe('create', () => {
  it('create checks stock but does not deduct', async () => {
    const bad = await createReq([{ MaterialID: 'M-A', Qty: 11 }]);
    expect(bad).toEqual({ ok: false, message: 'จำนวนที่ขอเบิก "ปากกา" เกินจำนวนคงเหลือในสต็อก (10 ชิ้น)', code: 'VALIDATION' });
    expect(await rows('SELECT * FROM requests')).toHaveLength(0);

    const r = await createReq([{ MaterialID: 'M-A', Qty: 3, Remark: 'r' }]);
    expect(r.ok).toBe(true);
    const req = await lastReq();
    expect(req.status).toBe('PENDING');
    expect(req.doc_no).toMatch(/^REQ-\d{8}-\d{4}$/);
    expect(r.message).toBe(`บันทึกใบขอเบิกพัสดุเรียบร้อยแล้ว เลขที่ ${req.doc_no}`);
    expect(req).toMatchObject({ user_id: 'U-T1', total_amount: 30, item_count: 1, stock_applied: 0 });
    expect(await stock('M-A')).toBe(10);
    const [it] = await rows('SELECT * FROM request_items WHERE request_id = ?', req.id);
    expect(it).toMatchObject({ code: 'A-1', name: 'ปากกา', unit: 'ชิ้น', qty: 3, unit_price: 10, total_price: 30, remark: 'r' });
    expect((await rows("SELECT actor FROM audit_log WHERE action='CREATE'"))[0].actor).toBe('off1');
  });

  it('prices come from the database, not the client', async () => {
    await createReq([{ MaterialID: 'M-A', Qty: 2, UnitPrice: 0.01, Name: 'x', TotalPrice: 1 }]);
    expect((await lastReq()).total_amount).toBe(20);
  });

  it('rejects bad qty, unknown material, bad attach', async () => {
    for (const qty of [0, -1, 'abc', '']) {
      expect(await createReq([{ MaterialID: 'M-A', Qty: qty }])).toMatchObject({ ok: false, code: 'VALIDATION' });
    }
    expect(await createReq([{ MaterialID: 'NOPE', Qty: 1 }])).toMatchObject({ ok: false });
    expect(await createReq([])).toEqual({ ok: false, message: 'ไม่พบรายการพัสดุที่ถูกต้อง' });
    expect(await createReq([{ MaterialID: 'M-A', Qty: 1 }], { AttachUrl: 'javascript:alert(1)' })).toMatchObject({ code: 'VALIDATION' });
    expect(await createReq([{ MaterialID: 'M-A', Qty: 1 }], { attach: { base64: 'abc', name: 'a.pdf' } })).toMatchObject({ code: 'VALIDATION' });
    expect(await rows('SELECT * FROM requests')).toHaveLength(0);
    expect((await createReq([{ MaterialID: 'M-A', Qty: 1 }], { attach: null, AttachUrl: 'https://x.test/a.pdf' })).ok).toBe(true);
    expect((await lastReq()).attach_url).toBe('https://x.test/a.pdf');
  });

  it('guest request stores null user', async () => {
    const r = await createReq([{ MaterialID: 'M-A', Qty: 1 }], { FullName: 'แขก', UserID: 'U-T1', actor: 'hacker' }, 'guest');
    expect(r.ok).toBe(true);
    expect((await lastReq()).user_id).toBeNull();
    expect((await rows("SELECT actor FROM audit_log WHERE action='CREATE'"))[0].actor).toBe('แขก');
    const anon = await createReq([{ MaterialID: 'M-A', Qty: 1 }], { FullName: '' }, 'guest');
    expect(anon.ok).toBe(true);
    expect((await rows("SELECT actor FROM audit_log WHERE action='CREATE' ORDER BY created_at DESC, rowid DESC"))[0].actor).toBe('ผู้ขอเบิก (บุคคลทั่วไป)');
  });

  it('guest rate limit', async () => {
    let calls = 0;
    const limited = {
      ...env,
      GUEST_LIMITER: {
        limit: async (o: { key: string }) => {
          calls++;
          expect(o.key).toBe('1.2.3.4');
          return { success: calls <= 10 };
        },
      },
    } as unknown as Env;
    const ctx = (): any => ({
      env: limited,
      req: new Request('https://example.com'),
      exec: { waitUntil() {}, passThroughOnException() {} },
      session: null,
      ip: '1.2.3.4',
    });
    let last: any;
    for (let i = 0; i < 11; i++) {
      last = await (await handleRpc('apiCreateRequest', ctx(), [{ FullName: 'g', items: [{ MaterialID: 'M-A', Qty: 1 }] }])).json();
    }
    expect(last).toMatchObject({ ok: false, code: 'RATE_LIMIT' });
    expect(await rows('SELECT * FROM requests')).toHaveLength(10);
  });
});

describe('approve / stock', () => {
  it('approve deducts once', async () => {
    await createReq([{ MaterialID: 'M-A', Qty: 3 }]);
    const req = await lastReq();
    const r = await status(req.id, 'APPROVED');
    expect(r).toMatchObject({ ok: true, message: 'อัปเดตสถานะใบขอเบิกเรียบร้อยแล้ว' });
    expect(r.results).toEqual([{ ID: req.id, DocNo: req.doc_no, ok: true, message: 'อัปเดตสถานะเรียบร้อยแล้ว' }]);
    expect(await stock('M-A')).toBe(7);
    const mv = await rows('SELECT * FROM stock_movements');
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ type: 'OUT', qty: 3, before_qty: 10, after_qty: 7, ref_doc: req.doc_no, actor: 'off1' });
    const again = await status(req.id, 'APPROVED');
    expect(again.ok).toBe(true);
    expect(await stock('M-A')).toBe(7);
    expect(await rows('SELECT * FROM stock_movements')).toHaveLength(1);
    const after = await lastReq();
    expect(after).toMatchObject({ status: 'APPROVED', stock_applied: 1, approved_by: 'off1' });
    expect(after.approved_date).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it('approve fails whole request when short', async () => {
    await createReq([{ MaterialID: 'M-A', Qty: 3 }, { MaterialID: 'M-B', Qty: 2 }]);
    const req = await lastReq();
    await env.DB.prepare("UPDATE materials SET stock_qty = 1 WHERE id = 'M-B'").run();
    const r = await status(req.id, 'APPROVED');
    expect(r.ok).toBe(false);
    expect(r.message).toBe('สต็อกไม่พอ: B-1 ดินสอ คงเหลือ 1 ขอ 2');
    expect(r.results[0].shortages).toEqual([{ Code: 'B-1', Name: 'ดินสอ', StockQty: 1, Qty: 2 }]);
    expect(await stock('M-A')).toBe(10);
    expect(await stock('M-B')).toBe(1);
    expect((await lastReq()).status).toBe('PENDING');
    expect(await rows('SELECT * FROM stock_movements')).toHaveLength(0);
    expect(await rows("SELECT * FROM audit_log WHERE action='STATUS'")).toHaveLength(0);
  });

  it('bulk approve reports per request', async () => {
    await createReq([{ MaterialID: 'M-A', Qty: 1 }]);
    const ok = await lastReq();
    await createReq([{ MaterialID: 'M-B', Qty: 2 }]);
    const short = (await rows('SELECT * FROM requests WHERE id <> ?', ok.id))[0];
    await env.DB.prepare("UPDATE materials SET stock_qty = 0 WHERE id = 'M-B'").run();
    const r = await rpc('apiUpdateRequestStatus', [[{ ID: ok.id, Status: 'APPROVED' }, { ID: short.id, Status: 'APPROVED' }]]);
    expect(r.ok).toBe(false);
    expect(r.results.map((x: any) => x.ok)).toEqual([true, false]);
    expect(r.results[1].shortages).toHaveLength(1);
    expect(r.message).toContain(short.doc_no);
    expect(r.message).toContain('B-1 ดินสอ คงเหลือ 0 ขอ 2');
    expect(await stock('M-A')).toBe(9);
  });

  it('concurrent approvals never go negative', async () => {
    await env.DB.prepare("UPDATE materials SET stock_qty = 3 WHERE id = 'M-A'").run();
    await createReq([{ MaterialID: 'M-A', Qty: 3 }]);
    await createReq([{ MaterialID: 'M-A', Qty: 3 }]);
    const reqs = await rows('SELECT id FROM requests');
    const res = await Promise.all(reqs.map((q: any) => status(q.id, 'APPROVED')));
    expect(res.filter((x) => x.ok)).toHaveLength(1);
    const loser = res.find((x) => !x.ok);
    expect(loser.message).toContain('สต็อกไม่พอ: A-1 ปากกา');
    expect(await stock('M-A')).toBe(0);
    expect(await rows("SELECT * FROM requests WHERE status = 'APPROVED'")).toHaveLength(1);
    expect(await rows('SELECT * FROM stock_movements')).toHaveLength(1);
  });

  it('approve -> reject -> approve moves stock once each way', async () => {
    await createReq([{ MaterialID: 'M-A', Qty: 3 }]);
    const { id, doc_no } = await lastReq();
    await status(id, 'APPROVED');
    expect(await stock('M-A')).toBe(7);
    expect((await status(id, 'REJECTED', { RejectReason: 'ไม่อนุมัติ' })).ok).toBe(true);
    expect(await stock('M-A')).toBe(10);
    expect((await lastReq()).stock_applied).toBe(0);
    expect((await status(id, 'APPROVED')).ok).toBe(true);
    expect(await stock('M-A')).toBe(7);
    const mv = await rows('SELECT type, ref_doc, note FROM stock_movements ORDER BY created_at, rowid');
    expect(mv.map((m: any) => m.type)).toEqual(['OUT', 'IN', 'OUT']);
    expect(mv.every((m: any) => m.ref_doc === doc_no)).toBe(true);
    expect(mv[1].note).toBe('คืนสต็อกจากใบขอเบิก');
  });

  it('reject keeps RejectReason only when REJECTED; approver fields set on every change', async () => {
    await createReq([{ MaterialID: 'M-A', Qty: 1 }]);
    const { id } = await lastReq();
    await status(id, 'REJECTED', { RejectReason: 'เหตุผล', actor: 'hacker' });
    let q = await lastReq();
    expect(q).toMatchObject({ status: 'REJECTED', reject_reason: 'เหตุผล', approved_by: 'off1' });
    expect(q.approved_date).not.toBe('');
    await status(id, 'PENDING', { RejectReason: 'ignored' });
    q = await lastReq();
    expect(q).toMatchObject({ status: 'PENDING', reject_reason: '', approved_by: 'off1' });
    expect(await stock('M-A')).toBe(10);
    expect(await rows('SELECT * FROM stock_movements')).toHaveLength(0);
    expect(await rows("SELECT * FROM audit_log WHERE action='STATUS'")).toHaveLength(2);
    expect(await status(id, 'BOGUS')).toMatchObject({ ok: false, message: 'สถานะไม่ถูกต้อง' });
  });

  it('partial approval approves selected items and adjusted qty, deducting stock accurately', async () => {
    await createReq([
      { MaterialID: 'M-A', Qty: 2 },
      { MaterialID: 'M-B', Qty: 2 },
    ]);
    const { id } = await lastReq();
    const reqItems = await rows('SELECT id, material_id FROM request_items WHERE request_id = ?', id);
    const itemA = reqItems.find((x: any) => x.material_id === 'M-A');
    const itemB = reqItems.find((x: any) => x.material_id === 'M-B');

    const res = await rpc('apiUpdateRequestStatus', [[{
      ID: id,
      Status: 'APPROVED',
      Items: [
        { ID: itemA.id, ApprovedQty: 1 },
        { ID: itemB.id, ApprovedQty: 0 },
      ],
    }]]);
    expect(res).toMatchObject({ ok: true });

    const q = await lastReq();
    expect(q.status).toBe('APPROVED');
    expect(q.is_partial).toBe(1);
    expect(q.item_count).toBe(1);
    expect(q.total_amount).toBe(10);

    expect(await stock('M-A')).toBe(9);
    expect(await stock('M-B')).toBe(2);

    await status(id, 'REJECTED');
    expect(await stock('M-A')).toBe(10);
    expect(await stock('M-B')).toBe(2);
    });
});

describe('delete', () => {
  it('delete approved request restores stock and cascades items', async () => {
    await createReq([{ MaterialID: 'M-A', Qty: 4 }]);
    const { id, doc_no } = await lastReq();
    await status(id, 'APPROVED');
    expect(await stock('M-A')).toBe(6);
    const r = await rpc('apiDeleteRequests', [[id]]);
    expect(r).toEqual({ ok: true, message: 'ลบใบขอเบิกเรียบร้อยแล้ว' });
    expect(await stock('M-A')).toBe(10);
    expect(await rows('SELECT * FROM requests')).toHaveLength(0);
    expect(await rows('SELECT * FROM request_items')).toHaveLength(0);
    const mv = await rows("SELECT * FROM stock_movements WHERE type = 'IN'");
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ ref_doc: doc_no, actor: 'off1' });
    expect((await rows("SELECT detail, actor FROM audit_log WHERE action='DELETE'"))[0]).toEqual({ detail: doc_no, actor: 'off1' });
  });

  it('delete pending request leaves stock alone', async () => {
    await createReq([{ MaterialID: 'M-A', Qty: 4 }]);
    const { id } = await lastReq();
    await rpc('apiDeleteRequests', [[id, 'R-NOPE']]);
    expect(await stock('M-A')).toBe(10);
    expect(await rows('SELECT * FROM stock_movements')).toHaveLength(0);
    expect(await rows('SELECT * FROM requests')).toHaveLength(0);
  });
});

describe('reads', () => {
  it('track by DocNo exact or FullName substring, max 10', async () => {
    await createReq([{ MaterialID: 'M-A', Qty: 1, Remark: 'หมายเหตุ' }], { FullName: 'สมชาย ใจดี' });
    const first = await lastReq();
    for (let i = 0; i < 11; i++) await createReq([{ MaterialID: 'M-A', Qty: 1 }], { FullName: 'สมหญิง ใจดี' });

    const byDoc = await guest('apiTrackRequest', [first.doc_no.toLowerCase()]);
    expect(byDoc.data).toHaveLength(1);
    expect(byDoc.data[0]).toMatchObject({ DocNo: first.doc_no, Status: 'PENDING', ItemCount: 1, TotalAmount: 10, FullName: 'สมชาย ใจดี' });
    expect(byDoc.data[0].Items).toEqual([{ Name: 'ปากกา', Qty: 1, Unit: 'ชิ้น', Remark: 'หมายเหตุ' }]);
    expect(Object.keys(byDoc.data[0])).not.toContain('UserID');

    expect((await guest('apiTrackRequest', ['REQ-9999']) ).ok).toBe(false);
    expect((await guest('apiTrackRequest', ['ใจดี'])).data).toHaveLength(10);
    expect((await guest('apiTrackRequest', ['สมหญิง'])).data).toHaveLength(10);
    expect(await guest('apiTrackRequest', ['  '])).toEqual({ ok: false, message: 'กรุณาระบุเลขที่ใบขอเบิก หรือชื่อผู้ขอเบิก' });
    expect(await guest('apiTrackRequest', ['ไม่มีคนนี้'])).toEqual({ ok: false, message: 'ไม่พบข้อมูลใบขอเบิกที่ตรงกับคำค้นหา: ไม่มีคนนี้' });
  });

  it('list filters, my requests, print', async () => {
    await createReq([{ MaterialID: 'M-A', Qty: 2 }], { FullName: 'อลิซ', Purpose: 'งานปาร์ตี้' });
    const a = await lastReq();
    await createReq([{ MaterialID: 'M-B', Qty: 1 }], { FullName: 'บ๊อบ' }, 'guest');
    await status(a.id, 'REJECTED', { RejectReason: 'x' });

    const all = await rpc('apiGetRequests', [{}]);
    expect(all.data).toHaveLength(2);
    expect(all.data[0]).not.toHaveProperty('stock_applied');
    expect((await rpc('apiGetRequests', [{ status: 'rejected' }])).data).toHaveLength(1);
    expect((await rpc('apiGetRequests', [{ q: 'ปาร์ตี้' }])).data.map((r: any) => r.FullName)).toEqual(['อลิซ']);
    expect((await rpc('apiGetRequests', [{ from: '2999-01-01' }])).data).toHaveLength(0);
    expect((await rpc('apiGetRequests', [])).data).toHaveLength(2);

    const mine = await rpc('apiGetMyRequests', []);
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0].Items[0]).toMatchObject({ MaterialID: 'M-A', Code: 'A-1', Qty: 2, TotalPrice: 20 });

    const pr = await rpc('apiGetRequestForPrint', [a.id]);
    expect(pr.data.request).toMatchObject({ ID: a.id, Status: 'REJECTED' });
    expect(pr.data.items).toMatchObject([{ Code: 'A-1', Name: 'ปากกา', Unit: 'ชิ้น', Qty: 2, UnitPrice: 10, TotalPrice: 20 }]);
    expect(pr.data.printedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(await rpc('apiGetRequestForPrint', ['nope'])).toEqual({ ok: false, message: 'ไม่พบใบขอเบิกนี้' });
  });

  it('officer-only functions need a session', async () => {
    for (const fn of ['apiGetRequests', 'apiGetMyRequests', 'apiGetRequestForPrint', 'apiUpdateRequestStatus', 'apiDeleteRequests']) {
      expect(await guest(fn, [])).toMatchObject({ ok: false, code: 'AUTH' });
    }
  });
});
