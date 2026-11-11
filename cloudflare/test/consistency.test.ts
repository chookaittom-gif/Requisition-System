import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import '../src/api/materials';
import '../src/api/requests';
import '../src/api/reports';
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
const rpc = async (fn: string, ...args: unknown[]) => (await post(fn, args, cookie)).json() as Promise<any>;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM stock_movements'),
    env.DB.prepare('DELETE FROM purchases'),
    env.DB.prepare('DELETE FROM requests'),
    env.DB.prepare('DELETE FROM opening_balances'),
    env.DB.prepare('DELETE FROM materials'),
    env.DB.prepare('DELETE FROM users'),
  ]);
  await env.DB.prepare(
    "INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at) VALUES ('U-C1', 'off1', ?, 'O', 'officer', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
  )
    .bind(await legacyHash('1234'))
    .run();
  cookie = ((await post('apiLogin', [{ username: 'off1', password: '1234' }])).headers.get('set-cookie') ?? '').split(';')[0];
});

describe('every screen agrees on quantity and value', () => {
  it('after buys at two prices, approvals, a cancellation and a manual stock edit', async () => {
    // 5 @ 10, then buy 5 @ 20 => lots [5@10, 5@20]
    await rpc('apiSaveMaterials', [{ action: 'create', Code: 'A-1', Name: 'ปากกา', Unit: 'ด้าม', UnitPrice: 10, StockQty: 5, MinQty: 1, Category: 'เครื่องเขียน' }]);
    const first = (await rpc('apiGetMaterials')).data;
    const id = first[0].ID as string;
    await rpc('apiPurchaseMaterials', [{ MaterialID: id, Qty: 5, UnitPrice: 20 }]);

    // Both requests are priced at 10 when raised; approval then consumes lots FIFO.
    const mk = async (qty: number) => { const r = await rpc('apiCreateRequest', { FullName: 'ครู', Department: 'ฝ่าย', Purpose: 'ใช้งาน', items: [{ MaterialID: id, Qty: qty }] }); expect(r.ok, JSON.stringify(r)).toBe(true); };
    await mk(7);
    await mk(1);
    const reqs = (await env.DB.prepare('SELECT id, doc_no FROM requests ORDER BY created_at ASC, rowid ASC').all<any>()).results;
    const setStatus = (rid: string, s: string) => rpc('apiUpdateRequestStatus', [{ ID: rid, Status: s, RejectReason: 'x' }]);
    // reqs[0] = 7 pcs, reqs[1] = 1 pc
    expect((await setStatus(reqs[0].id, 'APPROVED')).ok).toBe(true); // L1 gone, L2 3 left, price -> 20
    expect((await setStatus(reqs[1].id, 'APPROVED')).ok).toBe(true); // L2 2 left
    expect((await setStatus(reqs[0].id, 'REJECTED')).ok).toBe(true); // 7 back to L1 (5) and L2 (2): L1 5, L2 4
    await rpc('apiSaveMaterials', [{ action: 'update', ID: id, Code: 'A-1', Name: 'ปากกา', Unit: 'ด้าม', UnitPrice: 10, StockQty: 8, MinQty: 1, Category: 'เครื่องเขียน' }]); // L1 4, L2 4

    const expectedQty = 8;
    const expectedValue = 4 * 10 + 4 * 20; // 120

    const mat = (await rpc('apiGetMaterials')).data.find((m: any) => m.ID === id);
    expect(mat).toMatchObject({ StockQty: expectedQty, RemainAmount: expectedValue, UnitPrice: 10 });

    const acc = await rpc('apiGetInventoryAccount', {});
    expect(acc.data.find((x: any) => x.Code === 'A-1')).toMatchObject({ RemainQty: expectedQty, RemainAmount: expectedValue });
    expect(acc.summary.remainValue).toBe(expectedValue);

    const rep = await rpc('apiGetInventoryReport', { reportDate: todayBkk() });
    expect(rep.data.find((x: any) => x.Code === 'A-1')).toMatchObject({ RemainQty: expectedQty, Amount: expectedValue });

    const card = await rpc('apiGetStockCard', id, {});
    expect(card.data.summary.currentBalance).toBe(expectedQty);

    const dash = await rpc('apiGetAdminDashboard');
    expect(dash.summary.remainValue).toBe(expectedValue);
    // The one approved request (1 pc) was issued from the @20 lot even though it was raised at 10.
    expect(dash.summary.usedValue).toBe(20);

    // And the books balance: opening + received - issued = remaining, in money as well as quantity.
    const row = acc.data.find((x: any) => x.Code === 'A-1');
    expect(row.OpeningQty + row.PurchaseQty - row.UsedQty).toBe(row.RemainQty);
    expect(row.OpeningAmount + row.PurchaseAmount - row.UsedAmount).toBeCloseTo(row.RemainAmount, 6);
  });
});
