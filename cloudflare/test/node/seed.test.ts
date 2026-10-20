import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without type declarations
import { buildSeed } from '../../scripts/seed-legacy.mjs';

const USERS_HEADER = ['ID', 'Username', 'Password', 'FullName', 'Role', 'Position', 'CreatedAt', 'UpdatedAt'];
const SETTINGS_HEADER = ['SchoolName', 'Affiliation', 'LogoUrl', 'Address', 'Phone', 'UpdatedAt', 'NotifyEmail',
  'TelegramBotToken', 'TelegramChatId', 'NotifyOnNewRequest', 'NotifyOnStatusChange', 'NotifyLowStock', 'BannerUrl'];
const H = 'sha256$' + 'a'.repeat(64);

function workbook(users: unknown[][], settings: unknown[][] = []) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([USERS_HEADER, ...users]), 'Users');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([SETTINGS_HEADER, ...settings]), 'Settings');
  return wb;
}

// 10 values per row in HEADERS.Users order even though the sheet header has 8 names.
const row = (id: string, user: string, pw: string, role: string, dept = 'ฝ่ายพัสดุ') =>
  [id, user, pw, 'ชื่อ ' + user, role, 'ตำแหน่ง', dept, user + '@x.th', '2026-01-02T03:04:05', '2026-02-03 04:05:06'];

function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, dir), 'utf8'));
  }
  return db;
}

describe('seed-legacy buildSeed', () => {
  it('maps Users by HEADERS order, staff -> officer, T -> space', () => {
    const { sql, report } = buildSeed(workbook([row('U-1', 'admin', H, 'admin'), row('U-2', 'pat', H, 'staff')]));
    expect(sql.startsWith('--')).toBe(true);
    expect(sql.split('\n')[0].toLowerCase()).toContain('secret');
    const db = freshDb();
    db.exec(sql);
    const u = db.prepare("SELECT * FROM users WHERE id = 'U-2'").get() as Record<string, string>;
    expect(u.role).toBe('officer');
    expect(u.department).toBe('ฝ่ายพัสดุ');
    expect(u.email).toBe('pat@x.th');
    expect(u.created_at).toBe('2026-01-02 03:04:05');
    expect(u.updated_at).toBe('2026-02-03 04:05:06');
    expect(u.password_hash).toBe(H);
    expect(report.users).toMatchObject({ read: 2, written: 2 });
  });

  it('refuses plaintext, empty-ID and duplicate-username rows; reports IDs only', () => {
    const { sql, report } = buildSeed(workbook([
      row('U-1', 'a', H, 'admin'),
      row('U-2', 'b', 'plain1234', 'staff'),
      row('', 'c', H, 'staff'),
      row('U-4', 'a', H, 'staff'),
      row('U-5', 'e', 'pbkdf2$100000$x$y', 'officer'),
    ]));
    expect(sql).not.toContain('plain1234');
    expect(report.users.refused.map((r: { id: string }) => r.id).sort()).toEqual(['U-2', 'U-4']);
    expect(report.users.skippedEmptyId).toBe(1);
    expect(report.users.written).toBe(2);
    const db = freshDb();
    db.exec(sql);
    expect((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n).toBe(2);
  });

  it('converts Excel serial dates as Asia/Bangkok wall time', () => {
    const r = row('U-1', 'a', H, 'admin');
    r[8] = 46300.5; // 2026-10-05 12:00:00
    const { sql } = buildSeed(workbook([r]));
    expect(sql).toContain("'2026-10-05 12:00:00'");
  });

  it('is idempotent: running the SQL twice leaves the same rows', () => {
    const wb = workbook(
      [row('U-1', 'a', H, 'admin'), row('U-2', 'b', H, 'staff'), row('U-3', 'c', H, 'staff'), row('U-4', 'd', H, 'staff')],
      [['โรงเรียน', 'สังกัด', '', "ที่อยู่ 'x'", '054', '2026-03-04T01:02:03', '', 'TOKEN-1234567890', '-100', 'YES', 'yes', 'maybe', '']],
    );
    const { sql } = buildSeed(wb);
    const lines = sql.split('\n').filter((l: string) => l && !l.startsWith('--'));
    expect(lines.length).toBe(5);
    for (const l of lines) expect(l).toMatch(/^INSERT INTO (users|settings) .* ON CONFLICT\(id\) DO UPDATE SET /);
    const db = freshDb();
    db.exec(sql);
    db.exec(sql);
    expect((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n).toBe(4);
    const s = db.prepare('SELECT * FROM settings').all() as Record<string, string | number>[];
    expect(s.length).toBe(1);
    expect(s[0]).toMatchObject({
      id: 1, address: "ที่อยู่ 'x'", telegram_bot_token: 'TOKEN-1234567890',
      notify_on_new_request: 'YES', notify_on_status_change: 'YES', notify_low_stock: 'NO',
      updated_at: '2026-03-04 01:02:03',
    });
  });

  it('warns (id only) when Email holds a number, a sign of shifted columns', () => {
    const r = row('U-1', 'a', H, 'admin');
    r[7] = 46300.5;
    const { report } = buildSeed(workbook([r]));
    expect(report.users.warnings).toEqual([{ id: 'U-1', reason: 'email-not-text' }]);
  });
});
