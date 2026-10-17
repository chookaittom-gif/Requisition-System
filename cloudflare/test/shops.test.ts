import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

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
    env.DB.prepare('DELETE FROM materials'),
    env.DB.prepare('DELETE FROM shops'),
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

describe('shops', () => {
  it('saves and lists shops with legacy headers', async () => {
    const saveRes = await rpc('apiSaveShop', [
      {
        Name: 'บริษัท สวนดุสิต ซัพพลาย จำกัด',
        TaxId: '0105512345678',
        Address: '140 ถ.สุเรนทร์ ต.สบตุ๋ย',
        Phone: '054-228019',
        Note: 'ร้านประจำ',
      },
    ]);
    expect(saveRes.ok).toBe(true);

    const listRes = await rpc('apiGetShops', []);
    expect(listRes.ok).toBe(true);
    expect(listRes.data).toHaveLength(1);
    expect(listRes.data[0]).toMatchObject({
      Name: 'บริษัท สวนดุสิต ซัพพลาย จำกัด',
      TaxId: '0105512345678',
      Address: '140 ถ.สุเรนทร์ ต.สบตุ๋ย',
      Phone: '054-228019',
      Note: 'ร้านประจำ',
    });
    expect(listRes.data[0].ID).toMatch(/^SHP-/);
  });

  it('rejects duplicate shop names case-insensitively', async () => {
    await rpc('apiSaveShop', [{ Name: 'ร้านเครื่องเขียนไทย' }]);
    const dupRes = await rpc('apiSaveShop', [{ Name: '  ร้านเครื่องเขียนไทย  ' }]);
    expect(dupRes.ok).toBe(false);
    expect(dupRes.message).toContain('มีอยู่แล้วในระบบ');
  });

  it('updates an existing shop', async () => {
    const saveRes = await rpc('apiSaveShop', [{ Name: 'ร้านเดิม', Phone: '081-111-1111' }]);
    const shopId = saveRes.id;

    const updateRes = await rpc('apiSaveShop', [
      { ID: shopId, action: 'update', Name: 'ร้านเดิม (ปรับปรุงชื่อ)', Phone: '089-999-9999' },
    ]);
    expect(updateRes.ok).toBe(true);

    const listRes = await rpc('apiGetShops', []);
    expect(listRes.data[0].Name).toBe('ร้านเดิม (ปรับปรุงชื่อ)');
    expect(listRes.data[0].Phone).toBe('089-999-9999');
  });

  it('deletes a shop', async () => {
    const saveRes = await rpc('apiSaveShop', [{ Name: 'ร้านจะลบ' }]);
    const shopId = saveRes.id;

    const delRes = await rpc('apiDeleteShop', [shopId]);
    expect(delRes.ok).toBe(true);

    const listRes = await rpc('apiGetShops', []);
    expect(listRes.data).toHaveLength(0);
  });

  it('auto-saves new shop into shops table when saving materials', async () => {
    const matRes = await rpc('apiSaveMaterials', [
      [
        {
          action: 'create',
          Code: 'MAT-SHP-1',
          Name: 'แฟ้มเอกสาร',
          Unit: 'อัน',
          UnitPrice: 50,
          StockQty: 10,
          MinQty: 2,
          Category: 'หมวดงานเอกสารและกระดาษ',
          ShopName: 'ร้านค้าสร้างใหม่อัตโนมัติ',
          ShopTaxId: '0105599999999',
          ShopAddress: 'เชียงใหม่',
          ShopPhone: '053-111111',
        },
      ],
    ]);
    expect(matRes.ok).toBe(true);

    const shopList = await rpc('apiGetShops', []);
    expect(shopList.ok).toBe(true);
    expect(shopList.data).toHaveLength(1);
    expect(shopList.data[0]).toMatchObject({
      Name: 'ร้านค้าสร้างใหม่อัตโนมัติ',
      TaxId: '0105599999999',
      Address: 'เชียงใหม่',
      Phone: '053-111111',
    });
  });
});
