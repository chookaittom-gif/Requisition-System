// Builds seeds/legacy-seed.sql from an exported legacy workbook (Users + Settings).
// Usage: node scripts/seed-legacy.mjs <path-to-exported.xlsx> [out.sql]
// The output contains password hashes and the Telegram token: it is gitignored, never commit it.
// Mapping rules: docs/data-mapping.md. Only reads trusted local files.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';

// HEADERS.Users / HEADERS.Settings from Code/code.gs:29-35.
const USERS_COLS = ['ID', 'Username', 'Password', 'FullName', 'Role', 'Position', 'Department', 'Email', 'CreatedAt', 'UpdatedAt'];
const HASH_PREFIX = /^(sha256|pbkdf2)\$/;

const text = (v) => (v === null || v === undefined ? '' : String(v)).replace(/\u00a0/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const fmtUtc = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

// Returns 'YYYY-MM-DD HH:MM:SS' or '' when empty/unparseable.
export function normalizeDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return '';
    // Excel/Sheets serial = wall time of the spreadsheet (Asia/Bangkok).
    return fmtUtc(new Date(Math.round((Date.UTC(1899, 11, 30) + v * 86400000) / 1000) * 1000));
  }
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? '' : fmtUtc(new Date(Math.round(v.getTime() / 1000) * 1000 + 7 * 3600000));
  }
  const s = text(v).replace('T', ' ').replace(/\.\d+$/, '').replace(/Z$/, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s : '';
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

function rowsOf(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`sheet "${name}" not found`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

export function buildSeed(wb) {
  const stamp = fmtUtc(new Date(Date.now() + 7 * 3600000));
  const lines = ['-- WARNING: contains secrets (password hashes, Telegram bot token). Gitignored; never commit or share.'];
  const report = {
    users: { read: 0, written: 0, skippedEmptyId: 0, refused: [], warnings: [] },
    settings: { read: 0, written: 0 },
  };

  // Users: positional mapping by HEADERS.Users (the sheet header row has only 8 names).
  const seenNames = new Set();
  for (const r of rowsOf(wb, 'Users').slice(1)) {
    const c = Object.fromEntries(USERS_COLS.map((k, i) => [k, r[i]]));
    const id = text(c.ID);
    if (!id) { report.users.skippedEmptyId++; continue; }
    report.users.read++;
    const username = text(c.Username);
    const pw = text(c.Password);
    if (!HASH_PREFIX.test(pw)) { report.users.refused.push({ id, reason: 'password-not-hashed' }); continue; }
    if (!username) { report.users.refused.push({ id, reason: 'empty-username' }); continue; }
    if (seenNames.has(username)) { report.users.refused.push({ id, reason: 'duplicate-username' }); continue; }
    seenNames.add(username);
    if (typeof c.Email === 'number') report.users.warnings.push({ id, reason: 'email-not-text' });
    const email = typeof c.Email === 'number' ? '' : text(c.Email);
    const role = text(c.Role).toLowerCase();
    const updated = normalizeDate(c.UpdatedAt);
    const created = normalizeDate(c.CreatedAt) || updated || stamp;
    const vals = [id, username, pw, text(c.FullName), role === 'staff' ? 'officer' : role, text(c.Position),
      text(c.Department), email, created, updated || created];
    lines.push(
      'INSERT INTO users (id, username, password_hash, full_name, role, position, department, email, created_at, updated_at) VALUES ('
      + vals.map(q).join(', ')
      + ') ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, full_name = excluded.full_name, '
      + 'role = excluded.role, position = excluded.position, department = excluded.department, email = excluded.email, '
      + 'created_at = excluded.created_at, updated_at = excluded.updated_at;',
    );
    report.users.written++;
  }

  // Settings: single data row (row 2), mapped by header name.
  const srows = rowsOf(wb, 'Settings');
  if (srows.length >= 2) {
    report.settings.read = 1;
    const head = srows[0].map(text);
    const g = (n) => srows[1][head.indexOf(n)];
    const yn = (n) => (text(g(n)).toUpperCase() === 'YES' ? 'YES' : 'NO');
    const cols = [
      ['school_name', text(g('SchoolName'))], ['affiliation', text(g('Affiliation'))], ['logo_url', text(g('LogoUrl'))],
      ['address', text(g('Address'))], ['phone', text(g('Phone'))], ['notify_email', text(g('NotifyEmail'))],
      ['telegram_bot_token', text(g('TelegramBotToken'))], ['telegram_chat_id', text(g('TelegramChatId'))],
      ['notify_on_new_request', yn('NotifyOnNewRequest')], ['notify_on_status_change', yn('NotifyOnStatusChange')],
      ['notify_low_stock', yn('NotifyLowStock')], ['banner_url', text(g('BannerUrl'))],
      ['updated_at', normalizeDate(g('UpdatedAt')) || stamp],
    ];
    lines.push(
      `INSERT INTO settings (id, ${cols.map(([k]) => k).join(', ')}) VALUES (1, ${cols.map(([, v]) => q(v)).join(', ')}) `
      + `ON CONFLICT(id) DO UPDATE SET ${cols.map(([k]) => `${k} = excluded.${k}`).join(', ')};`,
    );
    report.settings.written = 1;
  }

  return { sql: lines.join('\n') + '\n', report };
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2];
  if (!input) { console.error('usage: node scripts/seed-legacy.mjs <exported.xlsx> [out.sql]'); process.exit(2); }
  const out = resolve(process.argv[3] ?? fileURLToPath(new URL('../seeds/legacy-seed.sql', import.meta.url)));
  const { sql, report } = buildSeed(XLSX.read(readFileSync(input), { type: 'buffer' }));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, sql, 'utf8');
  const u = report.users;
  console.log(`users: read ${u.read}, written ${u.written}, skipped(empty id) ${u.skippedEmptyId}, refused ${u.refused.length}`);
  for (const x of u.refused) console.log(`  refused ${x.id}: ${x.reason}`);
  for (const x of u.warnings) console.log(`  warning ${x.id}: ${x.reason} (check column layout)`);
  console.log(`settings: read ${report.settings.read}, written ${report.settings.written}`);
  console.log(`wrote ${out} (contains secrets, gitignored)`);
}
