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

let adminCookie = '';
let officerCookie = '';
const adminRpc = async (fn: string, args: unknown[]) => (await post(fn, args, adminCookie)).json() as Promise<any>;
const officerRpc = async (fn: string, args: unknown[]) => (await post(fn, args, officerCookie)).json() as Promise<any>;
const publicRpc = async (fn: string, args: unknown[]) => (await post(fn, args)).json() as Promise<any>;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM personnel'),
    env.DB.prepare('DELETE FROM requests'),
    env.DB.prepare('DELETE FROM materials'),
    env.DB.prepare('DELETE FROM users'),
  ]);

  // Insert admin and officer
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at) VALUES ('U-ADM', 'admin', ?, 'ผู้ดูแล', 'admin', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
    ).bind(await legacyHash('admin1234')),
    env.DB.prepare(
      "INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at) VALUES ('U-OFF', 'officer', ?, 'เจ้าหน้าที่', 'officer', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
    ).bind(await legacyHash('officer1234')),
  ]);

  const resAdmin = await post('apiLogin', [{ username: 'admin', password: 'admin1234' }]);
  adminCookie = (resAdmin.headers.get('set-cookie') ?? '').split(';')[0];

  const resOfficer = await post('apiLogin', [{ username: 'officer', password: 'officer1234' }]);
  officerCookie = (resOfficer.headers.get('set-cookie') ?? '').split(';')[0];
});

describe('personnel API', () => {
  it('public lookup returns personnel data for exact code (case-insensitive)', async () => {
    // Save personnel as admin
    const saveRes = await adminRpc('apiSavePersonnel', [
      {
        Code: 'P001',
        FullName: 'ดร.สมชาย ใจดี',
        Position: 'อาจารย์',
        Department: 'สาขาวิชาเทคโนโลยีสารสนเทศ',
        Active: 1,
      },
    ]);
    expect(saveRes.ok).toBe(true);

    // Public lookup lowercase
    const lookup1 = await publicRpc('apiLookupPersonnel', ['p001']);
    expect(lookup1.ok).toBe(true);
    expect(lookup1.data).toEqual({
      Code: 'P001',
      FullName: 'ดร.สมชาย ใจดี',
      Position: 'อาจารย์',
      Department: 'สาขาวิชาเทคโนโลยีสารสนเทศ',
    });

    // Public lookup uppercase
    const lookup2 = await publicRpc('apiLookupPersonnel', ['P001']);
    expect(lookup2.ok).toBe(true);
    expect(lookup2.data.FullName).toBe('ดร.สมชาย ใจดี');
  });

  it('public lookup fails on missing, inactive or not-found codes', async () => {
    await adminRpc('apiSavePersonnel', [
      {
        Code: 'P002',
        FullName: 'นายสมบัติ พักงาน',
        Position: 'เจ้าหน้าที่',
        Department: 'ฝ่ายอาคาร',
        Active: 0,
      },
    ]);

    // Empty code
    const emptyRes = await publicRpc('apiLookupPersonnel', ['']);
    expect(emptyRes.ok).toBe(false);

    // Inactive code
    const inactiveRes = await publicRpc('apiLookupPersonnel', ['P002']);
    expect(inactiveRes.ok).toBe(false);
    expect(inactiveRes.message).toContain('ไม่พบข้อมูลบุคลากร');

    // Non-existent code
    const notFoundRes = await publicRpc('apiLookupPersonnel', ['P999']);
    expect(notFoundRes.ok).toBe(false);
  });

  it('officer and admin can list personnel', async () => {
    await adminRpc('apiSavePersonnel', [
      { Code: 'P01', FullName: 'คนแรก', Position: 'อาจารย์', Department: 'สาขา A' },
    ]);

    const offList = await officerRpc('apiGetPersonnel', []);
    expect(offList.ok).toBe(true);
    expect(offList.data).toHaveLength(1);
    expect(offList.data[0].Code).toBe('P01');

    // Public cannot list personnel
    const pubList = await publicRpc('apiGetPersonnel', []);
    expect(pubList.ok).toBe(false);
  });

  it('admin can update, delete, and import bulk personnel', async () => {
    // Import 2 rows
    const impRes = await adminRpc('apiImportPersonnel', [
      [
        { 'รหัสบุคลากร': 'T100', 'ชื่อ-สกุล': 'อาจารย์ ก', 'ตำแหน่ง': 'อาจารย์', 'หลักสูตร': 'คอมพิวเตอร์' },
        { Code: 'T200', FullName: 'เจ้าหน้าที่ ข', Position: 'เจ้าหน้าที่', Department: 'การเงิน' },
      ],
    ]);
    expect(impRes.ok).toBe(true);
    expect(impRes.count).toBe(2);

    let list = (await adminRpc('apiGetPersonnel', [])).data;
    expect(list).toHaveLength(2);

    // Update T100
    const updRes = await adminRpc('apiSavePersonnel', [
      { Code: 'T100', FullName: 'ศ.ดร.อาจารย์ ก (แก้ไข)', Position: 'อาจารย์', Department: 'คอมพิวเตอร์' },
    ]);
    expect(updRes.ok).toBe(true);

    const lookupUpdated = await publicRpc('apiLookupPersonnel', ['T100']);
    expect(lookupUpdated.data.FullName).toBe('ศ.ดร.อาจารย์ ก (แก้ไข)');

    // Delete T200
    const delRes = await adminRpc('apiDeletePersonnel', ['T200']);
    expect(delRes.ok).toBe(true);

    list = (await adminRpc('apiGetPersonnel', [])).data;
    expect(list).toHaveLength(1);
    expect(list[0].Code).toBe('T100');
  });

  it('apiCreateRequest overrides FullName/Position/Department when PersonnelCode is provided', async () => {
    await adminRpc('apiSavePersonnel', [
      { Code: 'EMP-01', FullName: 'สมศรี มณีฉาย', Position: 'อาจารย์', Department: 'วิทยาการคอมพิวเตอร์' },
    ]);

    await env.DB.prepare(
      "INSERT INTO materials (id, code, name, unit, unit_price, stock_qty, created_at, updated_at) VALUES ('M1', 'C1', 'กระดาษ A4', 'รีม', 100, 10, '2026-01-01', '2026-01-01')",
    ).run();

    // Guest submits request with spoofed FullName but valid PersonnelCode
    const res = await publicRpc('apiCreateRequest', [
      {
        PersonnelCode: 'EMP-01',
        FullName: 'แฮกเกอร์ ปลอมชื่อ',
        Position: 'ผู้บริหารสูงสุด',
        Department: 'ฝ่ายแอบอ้าง',
        Purpose: 'ใช้สอนนักศึกษา',
        items: [{ MaterialID: 'M1', Qty: 1 }],
      },
    ]);
    expect(res.ok).toBe(true);

    const reqRow = (await env.DB.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 1').first()) as any;
    expect(reqRow.full_name).toBe('สมศรี มณีฉาย');
    expect(reqRow.position).toBe('อาจารย์');
    expect(reqRow.department).toBe('วิทยาการคอมพิวเตอร์');
  });

  it('apiCreateRequest rejects invalid PersonnelCode', async () => {
    await env.DB.prepare(
      "INSERT INTO materials (id, code, name, unit, unit_price, stock_qty, created_at, updated_at) VALUES ('M1', 'C1', 'กระดาษ A4', 'รีม', 100, 10, '2026-01-01', '2026-01-01')",
    ).run();

    const res = await publicRpc('apiCreateRequest', [
      {
        PersonnelCode: 'NOT_EXIST_CODE',
        FullName: 'นายทดสอบ',
        Position: 'อาจารย์',
        Department: 'สาขา',
        Purpose: 'ใช้สอน',
        items: [{ MaterialID: 'M1', Qty: 1 }],
      },
    ]);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('ไม่พบรหัสบุคลากรนี้ในระบบ');
  });
});
