import type { Env } from '../env';
import { hashPassword } from '../auth/password';
import { fail } from '../http';
import { logAudit } from '../lib/audit';
import { genId } from '../lib/ids';
import { toLegacy } from '../lib/rows';
import {
  getNotifyConfig,
  isMaskedToken,
  maskToken,
  newRequestText,
  sendTelegram,
  statusChangeText,
} from '../lib/telegram';
import { nowBkk } from '../lib/time';
import { registerRpc } from '../rpc';
import { notifyHooks } from './requests';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => String(v ?? '').trim();

/* ============================== NOTIFICATION HOOKS ============================== */
notifyHooks.onNewRequest = async (env, req) => {
  const cfg = await getNotifyConfig(env);
  if (!cfg.onNewRequest || !cfg.token || !cfg.chatId) return;
  await sendTelegram(cfg.token, cfg.chatId, newRequestText(req));
};

notifyHooks.onStatusChange = async (env, req, newStatus, reason) => {
  const cfg = await getNotifyConfig(env);
  if (!cfg.onStatusChange || !cfg.token || !cfg.chatId) return;
  let items: Obj[] = [];
  try {
    const { results } = await env.DB.prepare(
      'SELECT code AS Code, name AS Name, unit AS Unit, qty AS Qty, remark AS Remark FROM request_items WHERE request_id = ? ORDER BY rowid',
    )
      .bind(String(req.ID ?? ''))
      .all<Obj>();
    items = results;
  } catch (err) {
    console.error('status notify items failed', (err as Error)?.name);
  }
  await sendTelegram(cfg.token, cfg.chatId, statusChangeText(req, newStatus, reason, items));
};

/* ============================== SETTINGS ============================== */
const DEFAULT_SETTINGS = {
  SchoolName: '', Affiliation: '', LogoUrl: '', Address: '', Phone: '', UpdatedAt: '',
  NotifyEmail: '', TelegramBotToken: '', TelegramChatId: '',
  NotifyOnNewRequest: 'YES', NotifyOnStatusChange: 'YES', NotifyLowStock: 'YES', BannerUrl: '',
};

async function readSettings(env: Env): Promise<{ legacy: Obj; token: string }> {
  const row = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first<Obj>();
  if (!row) return { legacy: { ...DEFAULT_SETTINGS }, token: '' };
  const token = String(row.telegram_bot_token ?? '');
  return { legacy: { ...toLegacy('settings', row), TelegramBotToken: maskToken(token) }, token };
}

registerRpc('apiGetSettings', 'admin', async (ctx) => ({ ok: true, data: (await readSettings(ctx.env)).legacy }));

const flag = (v: unknown): 'YES' | 'NO' => {
  if (v === undefined || v === null || v === '') return 'YES';
  if (v === true) return 'YES';
  return String(v).trim().toUpperCase() === 'YES' ? 'YES' : 'NO';
};

/** Image URL field: empty or http(s) only. A legacy base64 upload object is not supported until Drive uploads exist. */
function imageUrl(url: unknown, file: unknown): { value: string } | { error: ReturnType<typeof fail> } {
  if (isObj(file) && file.base64) return { error: fail('การอัปโหลดไฟล์ผ่านหน้านี้ไม่รองรับ กรุณาใช้ลิงก์รูปภาพ', 'VALIDATION') };
  const value = str(url);
  if (value && !/^https?:\/\//i.test(value)) return { error: fail('ลิงก์รูปภาพต้องขึ้นต้นด้วย http:// หรือ https://', 'VALIDATION') };
  return { value };
}

registerRpc('apiSaveSettings', 'admin', async (ctx, args) => {
  const p = isObj(args[0]) ? args[0] : {};
  const logo = imageUrl(p.LogoUrl, p.logoFile);
  if ('error' in logo) return logo.error;
  const banner = imageUrl(p.BannerUrl, p.bannerFile);
  if ('error' in banner) return banner.error;
  const schoolName = str(p.SchoolName);
  const affiliation = str(p.Affiliation);
  if (!schoolName || !affiliation) return fail('กรุณากรอกชื่อหน่วยงานและสังกัด');

  const db = ctx.env.DB;
  const incoming = str(p.TelegramBotToken);
  const token = incoming && !isMaskedToken(incoming) ? incoming : (await readSettings(ctx.env)).token;
  const now = nowBkk();
  const d = {
    school_name: schoolName, affiliation, logo_url: logo.value, address: str(p.Address), phone: str(p.Phone),
    notify_email: str(p.NotifyEmail), telegram_chat_id: str(p.TelegramChatId),
    notify_on_new_request: flag(p.NotifyOnNewRequest), notify_on_status_change: flag(p.NotifyOnStatusChange),
    notify_low_stock: flag(p.NotifyLowStock), banner_url: banner.value,
  };
  await db.batch([
    db
      .prepare(
        `INSERT INTO settings (id, school_name, affiliation, logo_url, address, phone, notify_email, telegram_bot_token, telegram_chat_id, notify_on_new_request, notify_on_status_change, notify_low_stock, banner_url, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET school_name = excluded.school_name, affiliation = excluded.affiliation, logo_url = excluded.logo_url,
           address = excluded.address, phone = excluded.phone, notify_email = excluded.notify_email, telegram_bot_token = excluded.telegram_bot_token,
           telegram_chat_id = excluded.telegram_chat_id, notify_on_new_request = excluded.notify_on_new_request,
           notify_on_status_change = excluded.notify_on_status_change, notify_low_stock = excluded.notify_low_stock,
           banner_url = excluded.banner_url, updated_at = excluded.updated_at`,
      )
      .bind(
        d.school_name, d.affiliation, d.logo_url, d.address, d.phone, d.notify_email, token, d.telegram_chat_id,
        d.notify_on_new_request, d.notify_on_status_change, d.notify_low_stock, d.banner_url, now,
      ),
    logAudit(db, { action: 'UPDATE', entity: 'Settings', entityId: '', detail: 'บันทึกการตั้งค่าระบบ', actor: str(p.actor) }),
  ]);
  return { ok: true, message: 'บันทึกการตั้งค่าเรียบร้อยแล้ว', data: (await readSettings(ctx.env)).legacy };
});

registerRpc('apiTestTelegram', 'admin', async (ctx, args) => {
  const payload = args[0];
  let token = '';
  let chatId = '';
  if (isObj(payload)) {
    token = str(payload.token ?? payload.TelegramBotToken);
    chatId = str(payload.chatId ?? payload.TelegramChatId);
  } else if (typeof payload === 'string') {
    token = payload.trim();
    chatId = str(args[1]);
  }
  const row = await ctx.env.DB.prepare('SELECT school_name, telegram_bot_token, telegram_chat_id FROM settings WHERE id = 1').first<Obj>();
  if (!token || isMaskedToken(token)) token = String(row?.telegram_bot_token ?? '');
  chatId = chatId || String(row?.telegram_chat_id ?? '');
  if (!token || !chatId) return fail('กรุณากรอก Telegram Bot Token และ Chat ID ก่อนทดสอบ');
  const msg =
    `🔔 <b>ทดสอบการเชื่อมต่อ Telegram</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `🏫 <b>ระบบ:</b> ${String(row?.school_name || 'ระบบเบิกจ่ายพัสดุ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n` +
    `📅 <b>เวลาทดสอบ:</b> ${nowBkk()}\n` +
    `🟢 <b>สถานะ:</b> บอทส่งข้อความสำเร็จเรียบร้อยแล้ว!\n` +
    `━━━━━━━━━━━━━━━━━━━`;
  const res = await sendTelegram(token, chatId, msg);
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, message: 'ส่งข้อความทดสอบไปยัง Telegram สำเร็จแล้ว' };
});

/* ============================== USERS ============================== */
const SELF_DELETE_MSG = 'ไม่สามารถลบบัญชีของตนเองได้';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  department: string;
}

registerRpc('apiGetUsers', 'admin', async (ctx) => {
  const { results } = await ctx.env.DB.prepare('SELECT * FROM users').all<Obj>();
  const data = results
    .map((u) => {
      const l = toLegacy('users', u);
      return {
        ID: l.ID, Username: l.Username, FullName: l.FullName, Role: l.Role, Position: l.Position,
        Department: l.Department || '', Email: l.Email || '', CreatedAt: l.CreatedAt,
      };
    })
    .sort((a, b) => String(a.FullName).localeCompare(String(b.FullName), 'th'));
  return { ok: true, data };
});

const normRole = (v: unknown): 'admin' | 'officer' | null => {
  const r = String(v ?? '').trim().toLowerCase();
  if (r === 'admin') return 'admin';
  if (r === 'officer' || r === 'staff') return 'officer';
  return null;
};

registerRpc('apiSaveUsers', 'admin', async (ctx, args) => {
  const list = Array.isArray(args[0]) ? args[0].filter(isObj) : [];
  const db = ctx.env.DB;
  const { results } = await db.prepare('SELECT id, username, password_hash, role, department FROM users').all<UserRow>();
  const users = new Map(results.map((u) => [u.id, { ...u }]));
  const stmts: D1PreparedStatement[] = [];
  const now = nowBkk();
  const dupName = (name: string, selfId: string) =>
    [...users.values()].some((u) => u.username.trim() === name && u.id !== selfId);

  for (const item of list) {
    const actor = str(item.actor);
    if (item.action === 'delete') {
      const id = str(item.ID);
      const target = users.get(id);
      if (target && actor && target.username === actor) return fail(SELF_DELETE_MSG);
      users.delete(id);
      stmts.push(db.prepare('DELETE FROM users WHERE id = ?').bind(id));
      stmts.push(logAudit(db, { action: 'DELETE', entity: 'User', entityId: id, detail: '', actor }));
      continue;
    }

    const username = str(item.Username);
    if (!username) return fail('กรุณาระบุชื่อผู้ใช้');
    const id = str(item.ID);
    if (dupName(username, item.action === 'update' ? id : '')) return fail(`ชื่อผู้ใช้ "${username}" มีอยู่แล้วในระบบ`);
    const pw = str(item.Password);

    if (item.action === 'update') {
      const old = users.get(id);
      if (!old) return fail('ไม่พบผู้ใช้งานนี้');
      const role = item.Role === undefined ? normRole(old.role) : normRole(item.Role);
      if (!role) return fail('สิทธิ์ผู้ใช้งานไม่ถูกต้อง');
      const hash = pw ? await hashPassword(pw) : old.password_hash;
      const department = item.Department !== undefined ? str(item.Department) : old.department;
      stmts.push(
        db
          .prepare(
            'UPDATE users SET username = ?, password_hash = ?, full_name = ?, role = ?, position = ?, department = ?, email = ?, updated_at = ? WHERE id = ?',
          )
          .bind(username, hash, str(item.FullName), role, str(item.Position), department, str(item.Email), now, id),
      );
      if (pw || role !== normRole(old.role)) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
      stmts.push(logAudit(db, { action: 'UPDATE', entity: 'User', entityId: id, detail: username, actor }));
      users.set(id, { ...old, username, password_hash: hash, role, department });
    } else {
      if (!pw) return fail('กรุณากำหนดรหัสผ่าน');
      const role = normRole(item.Role);
      if (!role) return fail('สิทธิ์ผู้ใช้งานไม่ถูกต้อง');
      const newId = genId('U');
      const hash = await hashPassword(pw);
      stmts.push(
        db
          .prepare(
            'INSERT INTO users (id, username, password_hash, full_name, role, position, department, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(newId, username, hash, str(item.FullName), role, str(item.Position), str(item.Department), str(item.Email), now, now),
      );
      stmts.push(logAudit(db, { action: 'CREATE', entity: 'User', entityId: '', detail: username, actor }));
      users.set(newId, { id: newId, username, password_hash: hash, role, department: str(item.Department) });
    }
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true, message: 'บันทึกข้อมูลผู้ใช้งานเรียบร้อยแล้ว' };
});

registerRpc('apiDeleteUsers', 'admin', async (ctx, args) => {
  const ids = (Array.isArray(args[0]) ? args[0] : []).map(str).filter(Boolean);
  const actor = str(args[1]);
  const db = ctx.env.DB;
  const found: { id: string; username: string }[] = [];
  for (const id of ids) {
    const u = await db.prepare('SELECT id, username FROM users WHERE id = ?').bind(id).first<{ id: string; username: string }>();
    if (!u) continue;
    if (actor && u.username === actor) return fail(SELF_DELETE_MSG);
    found.push(u);
  }
  if (found.length) {
    // sessions rows go away through ON DELETE CASCADE
    await db.batch(
      found.flatMap((u) => [
        db.prepare('DELETE FROM users WHERE id = ?').bind(u.id),
        logAudit(db, { action: 'DELETE', entity: 'User', entityId: u.id, detail: '', actor }),
      ]),
    );
  }
  return { ok: true, message: 'ลบข้อมูลผู้ใช้งานเรียบร้อยแล้ว' };
});
