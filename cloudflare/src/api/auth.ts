import { hashPassword, verifyPassword } from '../auth/password';
import { createSession, destroySession } from '../auth/session';
import { fail, withHeaders } from '../http';
import { logAudit } from '../lib/audit';
import { toLegacy } from '../lib/rows';
import { nowBkk } from '../lib/time';
import { registerRpc } from '../rpc';

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});

/** sanitizeUser_ (Code/code.gs:774). */
function sanitizeUser(row: Obj): Obj {
  const u = toLegacy('users', row);
  return {
    ID: u.ID,
    Username: u.Username,
    FullName: u.FullName,
    Role: u.Role,
    Position: u.Position,
    Department: u.Department || '',
    Email: u.Email || '',
  };
}

registerRpc('apiGetBootstrap', 'public', async (ctx) => {
  const s = await ctx.env.DB.prepare(
    'SELECT school_name, affiliation, logo_url, banner_url, address, phone FROM settings WHERE id = 1',
  ).first<Obj>();
  return {
    ok: true,
    settings: {
      SchoolName: s?.school_name ?? '',
      Affiliation: s?.affiliation ?? '',
      LogoUrl: s?.logo_url ?? '',
      BannerUrl: s?.banner_url ?? '',
      Address: s?.address ?? '',
      Phone: s?.phone ?? '',
    },
  };
});

registerRpc('apiLogin', 'public', async (ctx, args) => {
  const p = asObj(args[0]);
  const username = String(p.username ?? '').trim();
  const password = String(p.password ?? '').trim();
  if (!username || !password) return fail('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');

  const db = ctx.env.DB;
  const u = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<Obj>();
  const check = u ? await verifyPassword(String(u.password_hash), password, ctx.env.PW_SALT) : null;
  if (!u || !check?.ok) return fail('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');

  const now = nowBkk();
  let role = String(u.role);
  const stmts = [db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(u.id, now)];
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (check.needsRehash) {
    sets.push('password_hash = ?');
    vals.push(await hashPassword(password));
  }
  if (role.toLowerCase() === 'staff') {
    role = 'officer';
    sets.push('role = ?');
    vals.push('officer');
  }
  if (sets.length) {
    stmts.push(
      db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, now, u.id),
    );
  }
  stmts.push(
    logAudit(db, {
      action: 'LOGIN',
      entity: 'User',
      entityId: String(u.id),
      detail: `เข้าสู่ระบบ (${role})`,
      actor: String(u.username),
    }),
  );
  await db.batch(stmts);

  const { cookie } = await createSession(ctx.env, { id: String(u.id), role });
  return withHeaders({ ok: true, user: sanitizeUser({ ...u, role }) }, { 'Set-Cookie': cookie });
});

registerRpc('apiLogout', 'officer', async (ctx, args) => {
  const cookie = await destroySession(ctx);
  await logAudit(ctx.env.DB, {
    action: 'LOGOUT',
    entity: 'User',
    entityId: '',
    detail: 'ออกจากระบบ',
    actor: String(args[0] ?? ''),
  }).run();
  return withHeaders({ ok: true }, { 'Set-Cookie': cookie });
});

registerRpc('apiUpdateProfile', 'officer', async (ctx, args) => {
  const p = asObj(args[0]);
  const db = ctx.env.DB;
  const id = String(p.ID); // set from the session by applyActor
  const old = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<Obj>();
  if (!old) return fail('ไม่พบผู้ใช้งานนี้');
  const username = String(p.Username ?? '').trim();
  if (!username) return fail('กรุณากรอกชื่อผู้ใช้');
  const dup = await db
    .prepare('SELECT 1 AS x FROM users WHERE username = ? AND id <> ?')
    .bind(username, id)
    .first();
  if (dup) return fail(`ชื่อผู้ใช้ "${username}" มีอยู่แล้วในระบบ`);
  const pw = String(p.Password ?? '').trim();

  // Whitelist exactly the fields legacy apiUpdateProfile writes; never role/email/id.
  const department = p.Department !== undefined ? String(p.Department ?? '').trim() : String(old.department ?? '');
  await db.batch([
    db
      .prepare(
        'UPDATE users SET username = ?, password_hash = ?, full_name = ?, position = ?, department = ?, updated_at = ? WHERE id = ?',
      )
      .bind(
        username,
        pw ? await hashPassword(pw) : old.password_hash,
        String(p.FullName ?? '').trim(),
        String(p.Position ?? '').trim(),
        department,
        nowBkk(),
        id,
      ),
    logAudit(db, { action: 'UPDATE', entity: 'User', entityId: id, detail: 'อัปเดตโปรไฟล์', actor: username }),
  ]);
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<Obj>();
  return { ok: true, message: 'อัปเดตข้อมูลส่วนตัวเรียบร้อยแล้ว', user: sanitizeUser(u as Obj) };
});
