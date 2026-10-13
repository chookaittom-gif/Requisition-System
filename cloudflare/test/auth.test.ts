import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { nowBkk } from '../src/lib/time';

const SALT = 'SALT';
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const legacyHash = async (pw: string) => 'sha256$' + (await sha256Hex(`${SALT}|${pw}`));

const post = (fn: string, args: unknown[], cookie?: string) =>
  SELF.fetch(
    new Request(`https://example.com/api/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ args }),
    }),
  );

async function seedUser(over: Partial<Record<string, string>> = {}) {
  const u = { id: 'U-TEST0001', username: 'u', password_hash: await legacyHash('1234'), role: 'staff', ...over };
  await env.DB.prepare(
    "INSERT INTO users (id, username, password_hash, full_name, role, email, created_at, updated_at) VALUES (?, ?, ?, 'Old Name', ?, 'old@x', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
  )
    .bind(u.id, u.username, u.password_hash, u.role)
    .run();
  return u;
}

async function loginCookie(password = '1234') {
  const res = await post('apiLogin', [{ username: 'u', password }]);
  const sc = res.headers.get('set-cookie') ?? '';
  return { res, cookie: sc.split(';')[0] };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM settings'),
  ]);
});

describe('password', () => {
  it('legacy sha256 hash verifies and asks for rehash', async () => {
    const stored = await legacyHash('1234');
    expect(await verifyPassword(stored, '1234', SALT)).toEqual({ ok: true, needsRehash: true });
    expect((await verifyPassword(stored, '9999', SALT)).ok).toBe(false);
  });
  it('plaintext legacy verifies and asks for rehash', async () => {
    expect(await verifyPassword('1234', '1234', SALT)).toEqual({ ok: true, needsRehash: true });
    expect((await verifyPassword('1234', '12345', SALT)).ok).toBe(false);
  });
  it('pbkdf2 round trip', async () => {
    const h = await hashPassword('x');
    expect(h).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword(h, 'x', '')).toEqual({ ok: true, needsRehash: false });
    expect((await verifyPassword(h, 'y', '')).ok).toBe(false);
  });
});

describe('auth rpc', () => {
  it('login sets HttpOnly cookie and rehashes', async () => {
    await seedUser();
    const { res } = await loginCookie();
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.user.Role).toBe('officer');
    expect(body.user).not.toHaveProperty('Password');
    expect(body).not.toHaveProperty('token');
    const sc = res.headers.get('set-cookie')!;
    for (const part of ['ims_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=28800']) {
      expect(sc).toContain(part);
    }
    const row = await env.DB.prepare('SELECT password_hash, role FROM users WHERE id = ?')
      .bind('U-TEST0001')
      .first<any>();
    expect(row.password_hash.startsWith('pbkdf2$')).toBe(true);
    expect(row.role).toBe('officer');
    const audit = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'LOGIN'").first<any>();
    expect(audit).toBeTruthy();
    expect(audit.actor).toBe('u');
    expect(((await (await post('apiLogin', [{ username: 'u', password: '1234' }])).json()) as any).ok).toBe(true);
  });

  it('wrong password gives legacy message', async () => {
    await seedUser();
    const res = await post('apiLogin', [{ username: 'u', password: 'nope' }]);
    expect(await res.json()).toEqual({ ok: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    expect(res.headers.get('set-cookie')).toBeNull();
    const empty = await post('apiLogin', [{ username: '', password: '' }]);
    expect(await empty.json()).toEqual({ ok: false, message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  });

  it('expired session returns AUTH', async () => {
    await seedUser();
    const past = nowBkk(new Date(Date.now() - 1000));
    await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex('tok'), 'U-TEST0001', 'officer', past, past)
      .run();
    const res = await post('apiUpdateProfile', [{}], 'ims_session=tok');
    expect(((await res.json()) as any).code).toBe('AUTH');
  });

  it('logout deletes the session row and clears cookie', async () => {
    await seedUser();
    const { cookie } = await loginCookie();
    expect((await env.DB.prepare('SELECT COUNT(*) c FROM sessions').first<any>()).c).toBe(1);
    const res = await post('apiLogout', ['ignored'], cookie);
    expect(((await res.json()) as any).ok).toBe(true);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await env.DB.prepare('SELECT COUNT(*) c FROM sessions').first<any>()).c).toBe(0);
    expect(((await (await post('apiUpdateProfile', [{}], cookie)).json()) as any).code).toBe('AUTH');
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE action='LOGOUT' AND actor='u'").first()).toBeTruthy();
  });

  it('profile update cannot change role or email', async () => {
    await seedUser();
    const { cookie } = await loginCookie();
    const res = await post(
      'apiUpdateProfile',
      [{ ID: 'U-OTHER', Username: 'u', Role: 'admin', Email: 'x@y', FullName: 'N', Position: 'P', Password: 'newpw' }],
      cookie,
    );
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message).toBe('อัปเดตข้อมูลส่วนตัวเรียบร้อยแล้ว');
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('U-TEST0001').first<any>();
    expect(row.full_name).toBe('N');
    expect(row.position).toBe('P');
    expect(row.role).toBe('officer');
    expect(row.email).toBe('old@x');
    expect(row.password_hash.startsWith('pbkdf2$')).toBe(true);
    expect((await verifyPassword(row.password_hash, 'newpw', SALT)).ok).toBe(true);
  });

  it('profile rejects duplicate username', async () => {
    await seedUser();
    await seedUser({ id: 'U-TEST0002', username: 'other' });
    const { cookie } = await loginCookie();
    const body = (await (await post('apiUpdateProfile', [{ Username: 'other', FullName: 'N' }], cookie)).json()) as any;
    expect(body).toEqual({ ok: false, message: 'ชื่อผู้ใช้ "other" มีอยู่แล้วในระบบ' });
  });

  it('bootstrap never exposes telegram token', async () => {
    await env.DB.prepare(
      "INSERT INTO settings (id, school_name, telegram_bot_token, telegram_chat_id, updated_at) VALUES (1, 'โรงเรียน', '123:ABC', '99', '2026-01-01 00:00:00')",
    ).run();
    const body = (await (await post('apiGetBootstrap', [])).json()) as any;
    expect(body.ok).toBe(true);
    expect(body.settings.SchoolName).toBe('โรงเรียน');
    expect(JSON.stringify(body)).not.toContain('123:ABC');
    expect(body.settings).not.toHaveProperty('TelegramBotToken');
    expect(Object.keys(body.settings).sort()).toEqual([
      'Address',
      'Affiliation',
      'BannerUrl',
      'LogoUrl',
      'Phone',
      'SchoolName',
    ]);
  });
});
