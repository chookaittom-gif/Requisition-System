import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/api/admin';
import { runLowStockCron } from '../src/cron';
import { notifyHooks } from '../src/api/requests';
import { sendLineMessages, sendLinePush } from '../src/lib/line';
import { approvedRequestFlex, newRequestFlex } from '../src/lib/lineFlex';
import { approvedRequestText, newRequestText, sendTelegram } from '../src/lib/telegram';

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
const rpc = async (fn: string, args: unknown[], c = adminCookie) => (await post(fn, args, c)).json() as Promise<any>;
const guest = async (fn: string, args: unknown[]) => (await post(fn, args)).json() as Promise<any>;
const rows = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<any>()).results;
const T = '2026-01-01 00:00:00';

const setSettings = (over: Record<string, string> = {}) => {
  const s = {
    telegram_bot_token: '123456:ABCDEFG',
    telegram_chat_id: '-100123',
    notify_on_new_request: 'YES',
    notify_on_status_change: 'YES',
    notify_low_stock: 'YES',
    ...over,
  };
  return env.DB.prepare(
    `INSERT INTO settings (id, school_name, affiliation, telegram_bot_token, telegram_chat_id, notify_on_new_request, notify_on_status_change, notify_low_stock, updated_at)
     VALUES (1, 'โรงเรียนทดสอบ', 'สังกัด', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET school_name=excluded.school_name, affiliation=excluded.affiliation, telegram_bot_token=excluded.telegram_bot_token,
       telegram_chat_id=excluded.telegram_chat_id, notify_on_new_request=excluded.notify_on_new_request,
       notify_on_status_change=excluded.notify_on_status_change, notify_low_stock=excluded.notify_low_stock, updated_at=excluded.updated_at`,
  )
    .bind(s.telegram_bot_token, s.telegram_chat_id, s.notify_on_new_request, s.notify_on_status_change, s.notify_low_stock, T)
    .run();
};

const addMat = (id: string, code: string, qty: number, min: number) =>
  env.DB.prepare(
    "INSERT INTO materials (id, code, name, unit, unit_price, stock_qty, min_qty, created_at, updated_at) VALUES (?, ?, ?, 'ชิ้น', 10, ?, ?, ?, ?)",
  )
    .bind(id, code, `พัสดุ ${code}`, qty, min, T, T)
    .run();

let fetchSpy: ReturnType<typeof vi.spyOn>;
const sent = () =>
  fetchSpy.mock.calls.map(([u, init]: [unknown, unknown]) => ({
    url: String(u instanceof Request ? u.url : u),
    body: JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')),
  }));

beforeEach(async () => {
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM stock_movements'),
    env.DB.prepare('DELETE FROM request_items'),
    env.DB.prepare('DELETE FROM requests'),
    env.DB.prepare('DELETE FROM materials'),
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare('DELETE FROM users'),
  ]);
  const ins = env.DB.prepare(
    'INSERT INTO users (id, username, password_hash, full_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  await env.DB.batch([
    ins.bind('U-AD', 'admin1', await legacyHash('1234'), 'Admin', 'admin', T, T),
    ins.bind('U-OF', 'off1', await legacyHash('1234'), 'Officer', 'officer', T, T),
  ]);
  const a = await post('apiLogin', [{ username: 'admin1', password: '1234' }]);
  adminCookie = (a.headers.get('set-cookie') ?? '').split(';')[0];
  const o = await post('apiLogin', [{ username: 'off1', password: '1234' }]);
  officerCookie = (o.headers.get('set-cookie') ?? '').split(';')[0];
});

afterEach(() => {
  fetchSpy.mockRestore();
});

const validSettings = (over: Record<string, unknown> = {}) => ({
  SchoolName: ' โรงเรียน ',
  Affiliation: 'สังกัด',
  NotifyOnNewRequest: 'YES',
  NotifyOnStatusChange: 'NO',
  NotifyLowStock: 'YES',
  ...over,
});
const storedToken = async () => (await rows('SELECT telegram_bot_token t FROM settings WHERE id = 1'))[0]?.t;

describe('settings', () => {
  it('settings token is masked', async () => {
    await setSettings();
    const res = await rpc('apiGetSettings', []);
    expect(res.ok).toBe(true);
    expect(res.data.TelegramBotToken).toBe('••••DEFG');
    expect(JSON.stringify(res)).not.toContain('123456:ABCDEFG');
  });

  it('unset token is empty string and missing row gives defaults', async () => {
    const res = await rpc('apiGetSettings', []);
    expect(res.data.TelegramBotToken).toBe('');
    expect(res.data.SchoolName).toBe('');
  });

  it('saving masked or empty token keeps stored token', async () => {
    await setSettings();
    expect((await rpc('apiSaveSettings', [validSettings({ TelegramBotToken: '••••DEFG' })])).ok).toBe(true);
    expect(await storedToken()).toBe('123456:ABCDEFG');
    const res = await rpc('apiSaveSettings', [validSettings({ TelegramBotToken: '' })]);
    expect(res.ok).toBe(true);
    expect(await storedToken()).toBe('123456:ABCDEFG');
    expect(JSON.stringify(res)).not.toContain('123456:ABCDEFG');
  });

  it('saving a new token replaces it and normalizes flags', async () => {
    await setSettings();
    const res = await rpc('apiSaveSettings', [validSettings({ TelegramBotToken: ' 999:ZZZZ ', NotifyLowStock: 'no', NotifyTelegram: 'NO', NotifyLine: 'YES' })]);
    expect(res.ok).toBe(true);
    expect(res.data.TelegramBotToken).toBe('••••ZZZZ');
    expect(res.data.NotifyTelegram).toBe('NO');
    expect(res.data.NotifyLine).toBe('YES');
    expect(await storedToken()).toBe('999:ZZZZ');
    const [r] = await rows('SELECT * FROM settings');
    expect(r).toMatchObject({ school_name: 'โรงเรียน', notify_on_status_change: 'NO', notify_low_stock: 'NO', notify_on_new_request: 'YES', notify_telegram: 'NO', notify_line: 'YES' });
    expect((await rows("SELECT * FROM audit_log WHERE entity='Settings'")).length).toBe(1);
  });

  it('save creates the settings row when none exists and requires name', async () => {
    expect(await rpc('apiSaveSettings', [validSettings({ SchoolName: '' })])).toEqual({
      ok: false,
      message: 'กรุณากรอกชื่อหน่วยงานและสังกัด',
    });
    expect((await rpc('apiSaveSettings', [validSettings({ TelegramBotToken: 'abc:1234' })])).ok).toBe(true);
    expect(await storedToken()).toBe('abc:1234');
  });

  it('logo/banner: url ok, upload object with base64 rejected, null ignored', async () => {
    expect((await rpc('apiSaveSettings', [validSettings({ LogoUrl: 'https://x.example/l.png', logoFile: null })])).ok).toBe(true);
    expect((await rows('SELECT logo_url FROM settings'))[0].logo_url).toBe('https://x.example/l.png');
    const bad = await rpc('apiSaveSettings', [validSettings({ bannerFile: { base64: 'AAAA', name: 'b.png' } })]);
    expect(bad).toMatchObject({ ok: false, code: 'VALIDATION' });
    const bad2 = await rpc('apiSaveSettings', [validSettings({ LogoUrl: 'javascript:alert(1)' })]);
    expect(bad2).toMatchObject({ ok: false, code: 'VALIDATION' });
  });

  it('settings RPCs are admin only', async () => {
    expect(await rpc('apiGetSettings', [], officerCookie)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await rpc('apiSaveSettings', [validSettings()], officerCookie)).toMatchObject({ code: 'FORBIDDEN' });
    expect(await rpc('apiTestTelegram', [{}], officerCookie)).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('telegram', () => {
  it('sendTelegram posts HTML payload and reports API errors', async () => {
    expect(await sendTelegram('', '1', 'x')).toEqual({ ok: false, message: 'กรุณาระบุ Telegram Bot Token และ Chat ID' });
    expect(await sendTelegram('T:1', '5', '<b>hi</b>')).toEqual({ ok: true, message: 'ส่งข้อความสำเร็จ' });
    expect(sent()[0]).toEqual({
      url: 'https://api.telegram.org/botT:1/sendMessage',
      body: { chat_id: '5', text: '<b>hi</b>', parse_mode: 'HTML', disable_web_page_preview: true },
    });
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({ description: 'Bad Request: chat not found' }), { status: 400 }));
    expect(await sendTelegram('T:1', '5', 'x')).toEqual({ ok: false, message: 'Telegram API Error (400): Bad Request: chat not found' });
    fetchSpy.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    expect((await sendTelegram('T:1', '5', 'x')).ok).toBe(false);
  });

  it('apiTestTelegram uses stored token when masked/empty', async () => {
    await setSettings();
    const res = await rpc('apiTestTelegram', [{ token: '••••DEFG', chatId: '' }]);
    expect(res).toEqual({ ok: true, message: 'ส่งข้อความทดสอบไปยัง Telegram สำเร็จแล้ว' });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].url).toBe('https://api.telegram.org/bot123456:ABCDEFG/sendMessage');
    expect(sent()[0].body.chat_id).toBe('-100123');
    expect(sent()[0].body.text).toContain('ทดสอบการเชื่อมต่อ Telegram');
  });

  it('apiTestTelegram uses provided token and chat id, legacy string form, and missing config message', async () => {
    await setSettings();
    await rpc('apiTestTelegram', ['777:NEW', '-5']);
    expect(sent()[0].url).toBe('https://api.telegram.org/bot777:NEW/sendMessage');
    expect(sent()[0].body.chat_id).toBe('-5');
    await env.DB.prepare('DELETE FROM settings').run();
    expect(await rpc('apiTestTelegram', [{ token: '', chatId: '' }])).toEqual({
      ok: false,
      message: 'กรุณากรอก Telegram Bot Token และ Chat ID ก่อนทดสอบ',
    });
  });
});

describe('line flex', () => {
  const REQ = {
    DocNo: 'REQ-001', FullName: 'สมชาย ใจดี', Department: '', Purpose: 'ใช้ในห้องเรียน',
    ItemCount: 3, TotalAmount: 1234.5,
  };
  const lineCalls = () => sent().filter((c: { url: string }) => c.url === 'https://api.line.me/v2/bot/message/push');
  const tgCalls = () => sent().filter((c: { url: string }) => c.url.startsWith('https://api.telegram.org/'));
  const withLine = async () => {
    await setSettings();
    await env.DB.prepare("UPDATE settings SET line_token = 'LT', line_to = 'Cgroup' WHERE id = 1").run();
  };
  const cardText = (msg: any): string => JSON.stringify(msg.contents);

  it('builders: orange new-request card and green approved card with fallbacks', () => {
    const n = newRequestFlex(REQ);
    const a = approvedRequestFlex(REQ);
    expect(n).toMatchObject({ type: 'flex', contents: { type: 'bubble', styles: { header: { backgroundColor: '#F97316' } } } });
    expect(a).toMatchObject({ type: 'flex', contents: { type: 'bubble', styles: { header: { backgroundColor: '#16A34A' } } } });
    expect(cardText(n)).toContain('มีใบขอเบิกพัสดุใหม่');
    expect(cardText(a)).toContain('อนุมัติใบขอเบิกพัสดุแล้ว');
    for (const m of [n, a] as any[]) {
      const t = cardText(m);
      expect(t).toContain('REQ-001');
      expect(t).toContain('สมชาย ใจดี');
      expect(t).toContain('ใช้ในห้องเรียน');
      expect(t).toContain('3 รายการ');
      expect(t).toContain('1,234.50 บาท');
      expect(String(m.altText)).toContain('REQ-001');
      expect(String(m.altText).length).toBeLessThanOrEqual(400);
    }
    expect(cardText(n)).toContain('"text":"-"'); // empty Department falls back to "-"
    expect(String((newRequestFlex({ ...REQ, FullName: 'x'.repeat(900) }) as any).altText).length).toBe(400);
  });

  it('notification builders format requested items and approved/rejected breakdown correctly', () => {
    const reqWithItems = {
      ...REQ,
      Items: [
        { Name: 'คอมพิวเตอร์', Qty: 2, ApprovedQty: 1, Unit: 'เครื่อง' },
        { Name: 'ปลั๊กไฟ', Qty: 3, ApprovedQty: 0, Unit: 'อัน' },
      ],
    };
    const tgNew = newRequestText(reqWithItems);
    expect(tgNew).toContain('รายการพัสดุที่ขอเบิก:');
    expect(tgNew).toContain('คอมพิวเตอร์: <b>2</b> เครื่อง');
    expect(tgNew).toContain('ปลั๊กไฟ: <b>3</b> อัน');

    const tgAp = approvedRequestText(reqWithItems);
    expect(tgAp).toContain('อนุมัติ 1 รายการ | ไม่อนุมัติ 1 รายการ');
    expect(tgAp).toContain('รายการที่อนุมัติ:');
    expect(tgAp).toContain('คอมพิวเตอร์: <b>1</b> เครื่อง (ขอ 2)');
    expect(tgAp).toContain('รายการที่ตัดออก:');
    expect(tgAp).toContain('ปลั๊กไฟ (ขอ 3 อัน - ไม่อนุมัติ)');

    const lineNew = newRequestFlex(reqWithItems);
    expect(cardText(lineNew)).toContain('รายการพัสดุที่ขอเบิก:');
    expect(cardText(lineNew)).toContain('คอมพิวเตอร์: 2 เครื่อง');

    const lineAp = approvedRequestFlex(reqWithItems);
    expect(cardText(lineAp)).toContain('สรุป: อนุมัติ 1 | ไม่อนุมัติ 1 รายการ');
    expect(cardText(lineAp)).toContain('คอมพิวเตอร์: 1 เครื่อง (ขอ 2)');
    expect(cardText(lineAp)).toContain('ปลั๊กไฟ: ❌ ไม่อนุมัติ');
  });

  it('sendLineMessages posts the given messages; sendLinePush still posts text', async () => {
    expect(await sendLineMessages('', 'C', [])).toMatchObject({ ok: false });
    expect(await sendLineMessages('LT', 'C1', [newRequestFlex(REQ)])).toEqual({ ok: true, message: 'ส่งข้อความสำเร็จ' });
    expect(lineCalls()[0].body.to).toBe('C1');
    expect(lineCalls()[0].body.messages[0].type).toBe('flex');
    expect(await sendLinePush('LT', 'C1', 'hello')).toEqual({ ok: true, message: 'ส่งข้อความสำเร็จ' });
    expect(lineCalls()[1].body.messages).toEqual([{ type: 'text', text: 'hello' }]);
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({ message: 'bad' }), { status: 400 }));
    expect(await sendLineMessages('LT', 'C1', [])).toEqual({ ok: false, message: 'LINE API Error (400): bad' });
  });

  it('new request: LINE gets a flex card, Telegram keeps the original text', async () => {
    await withLine();
    await notifyHooks.onNewRequest!(env as any, REQ);
    expect(lineCalls()).toHaveLength(1);
    expect(lineCalls()[0].body.messages[0].type).toBe('flex');
    expect(tgCalls()).toHaveLength(1);
    expect(tgCalls()[0].body.text).toBe(newRequestText(REQ));
  });

  it('approved & rejected: LINE gets a flex card, Telegram gets text only on approved (reject telegram disabled); other statuses send nothing', async () => {
    await withLine();
    await notifyHooks.onStatusChange!(env as any, REQ, 'CANCELLED', '');
    expect(sent()).toHaveLength(0);

    await notifyHooks.onStatusChange!(env as any, REQ, 'REJECTED', 'งบประมาณไม่เพียงพอ');
    expect(lineCalls()).toHaveLength(1);
    expect(cardText(lineCalls()[0].body.messages[0])).toContain('ไม่อนุมัติใบขอเบิกพัสดุ');
    expect(tgCalls()).toHaveLength(0);

    await notifyHooks.onStatusChange!(env as any, REQ, 'APPROVED', '');
    expect(lineCalls()).toHaveLength(2);
    expect(cardText(lineCalls()[1].body.messages[0])).toContain('อนุมัติใบขอเบิกพัสดุแล้ว');
    expect(tgCalls()).toHaveLength(1);
    expect(tgCalls()[0].body.text).toBe(approvedRequestText(REQ));
  });

  it('flex rejected by LINE: falls back to the original text message', async () => {
    await withLine();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockImplementation(async (u: unknown) =>
      String(u).includes('api.line.me') && fetchSpy.mock.calls.filter(([x]: [unknown]) => String(x).includes('api.line.me')).length === 1
        ? new Response(JSON.stringify({ message: 'invalid flex' }), { status: 400 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await notifyHooks.onNewRequest!(env as any, REQ);
    expect(lineCalls()).toHaveLength(2);
    expect(lineCalls()[0].body.messages[0].type).toBe('flex');
    expect(lineCalls()[1].body.messages[0].type).toBe('text');
    expect(lineCalls()[1].body.messages[0].text).toContain('มีใบขอเบิกพัสดุใหม่');
    expect(errSpy).toHaveBeenCalledWith('line flex failed', 'LINE API Error (400): invalid flex');
    errSpy.mockRestore();
  });

  it('channel toggles independently mute telegram or line', async () => {
    await withLine();
    await env.DB.prepare("UPDATE settings SET notify_telegram = 'NO', notify_line = 'YES' WHERE id = 1").run();
    await notifyHooks.onNewRequest!(env as any, REQ);
    expect(tgCalls()).toHaveLength(0);
    expect(lineCalls()).toHaveLength(1);

    await env.DB.prepare("UPDATE settings SET notify_telegram = 'YES', notify_line = 'NO' WHERE id = 1").run();
    await notifyHooks.onNewRequest!(env as any, REQ);
    expect(tgCalls()).toHaveLength(1);
    expect(lineCalls()).toHaveLength(1);
  });
});

describe('users', () => {
  it('new user password is pbkdf2, never returned', async () => {
    const res = await rpc('apiSaveUsers', [
      [{ action: 'create', Username: 'newu', Password: 'secret1', FullName: 'ใหม่', Role: 'officer', Email: 'a@b.c' }],
    ]);
    expect(res).toEqual({ ok: true, message: 'บันทึกข้อมูลผู้ใช้งานเรียบร้อยแล้ว' });
    const [u] = await rows("SELECT * FROM users WHERE username = 'newu'");
    expect(u.password_hash).toMatch(/^pbkdf2\$100000\$/);
    expect(u.password_hash).not.toContain('secret1');
    expect(u.id).toMatch(/^U-[0-9A-F]{8}$/);
    expect((await rows("SELECT * FROM audit_log WHERE action='CREATE' AND entity='User'")).length).toBe(1);
    const list = await rpc('apiGetUsers', []);
    const got = list.data.find((x: any) => x.Username === 'newu');
    expect(got).toMatchObject({ FullName: 'ใหม่', Role: 'officer', Email: 'a@b.c' });
    expect(got.CreatedAt).toBeTruthy();
    expect(JSON.stringify(list)).not.toMatch(/Password|pbkdf2|sha256/i);
  });

  it('duplicate username rejected and nothing written', async () => {
    const res = await rpc('apiSaveUsers', [
      [
        { action: 'create', Username: 'okuser', Password: 'p', FullName: 'x', Role: 'officer' },
        { action: 'create', Username: 'off1', Password: 'p', FullName: 'x', Role: 'officer' },
      ],
    ]);
    expect(res).toEqual({ ok: false, message: 'ชื่อผู้ใช้ "off1" มีอยู่แล้วในระบบ' });
    expect(await rows("SELECT * FROM users WHERE username = 'okuser'")).toHaveLength(0);
  });

  it('duplicate username rejected regardless of case', async () => {
    const res = await rpc('apiSaveUsers', [
      [{ action: 'create', Username: 'OFF1', Password: 'p', FullName: 'x', Role: 'officer' }],
    ]);
    expect(res).toEqual({ ok: false, message: 'ชื่อผู้ใช้ "OFF1" มีอยู่แล้วในระบบ' });
    expect(await rows('SELECT id FROM users')).toHaveLength(2);
  });

  it('create requires password and valid role; staff maps to officer', async () => {
    expect(await rpc('apiSaveUsers', [[{ action: 'create', Username: 'a1', Password: '', Role: 'officer' }]])).toEqual({
      ok: false,
      message: 'กรุณากำหนดรหัสผ่าน',
    });
    expect((await rpc('apiSaveUsers', [[{ action: 'create', Username: 'a1', Password: 'p', Role: 'root' }]])).ok).toBe(false);
    expect((await rpc('apiSaveUsers', [[{ action: 'create', Username: 'a2', Password: 'p', Role: 'staff' }]])).ok).toBe(true);
    expect((await rows("SELECT role FROM users WHERE username = 'a2'"))[0].role).toBe('officer');
  });

  it('update with empty password keeps old hash; ignores injected columns', async () => {
    const before = (await rows("SELECT password_hash h FROM users WHERE id = 'U-OF'"))[0].h;
    const res = await rpc('apiSaveUsers', [
      [{ action: 'update', ID: 'U-OF', Username: 'off1', Password: '', FullName: 'ชื่อใหม่', Role: 'officer', password_hash: 'evil', id: 'X' }],
    ]);
    expect(res.ok).toBe(true);
    const [u] = await rows("SELECT * FROM users WHERE id = 'U-OF'");
    expect(u.password_hash).toBe(before);
    expect(u.full_name).toBe('ชื่อใหม่');
  });

  it('password or role change by admin deletes that user sessions', async () => {
    expect((await rows("SELECT * FROM sessions WHERE user_id = 'U-OF'")).length).toBe(1);
    await rpc('apiSaveUsers', [[{ action: 'update', ID: 'U-OF', Username: 'off1', Password: '', FullName: 'O', Role: 'officer' }]]);
    expect((await rows("SELECT * FROM sessions WHERE user_id = 'U-OF'")).length).toBe(1);
    await rpc('apiSaveUsers', [[{ action: 'update', ID: 'U-OF', Username: 'off1', Password: 'newpw', FullName: 'O', Role: 'officer' }]]);
    expect(await rows("SELECT * FROM sessions WHERE user_id = 'U-OF'")).toHaveLength(0);
    expect(await rpc('apiGetMyRequests', [], officerCookie)).toMatchObject({ code: 'AUTH' });
    const re = await post('apiLogin', [{ username: 'off1', password: 'newpw' }]);
    expect((await re.json<any>()).ok).toBe(true);
    const cookie2 = (re.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await rows("SELECT * FROM sessions WHERE user_id = 'U-OF'")).length).toBe(1);
    await rpc('apiSaveUsers', [[{ action: 'update', ID: 'U-OF', Username: 'off1', Password: '', FullName: 'O', Role: 'admin' }]]);
    expect(await rows("SELECT * FROM sessions WHERE user_id = 'U-OF'")).toHaveLength(0);
    expect(cookie2).toBeTruthy();
  });

  it('admin cannot delete self (apiDeleteUsers and delete action)', async () => {
    const msg = 'ไม่สามารถลบบัญชีของตนเองได้';
    expect(await rpc('apiDeleteUsers', [['U-AD'], 'spoofed'])).toEqual({ ok: false, message: msg });
    expect(await rpc('apiDeleteUsers', [['U-OF', 'U-AD']])).toEqual({ ok: false, message: msg });
    expect(await rpc('apiSaveUsers', [[{ action: 'delete', ID: 'U-AD' }]])).toEqual({ ok: false, message: msg });
    expect(await rows('SELECT id FROM users')).toHaveLength(2);
  });

  it('delete removes user and cascades their sessions', async () => {
    expect((await rows("SELECT * FROM sessions WHERE user_id = 'U-OF'")).length).toBe(1);
    const res = await rpc('apiDeleteUsers', [['U-OF']]);
    expect(res).toEqual({ ok: true, message: 'ลบข้อมูลผู้ใช้งานเรียบร้อยแล้ว' });
    expect(await rows("SELECT * FROM users WHERE id = 'U-OF'")).toHaveLength(0);
    expect(await rows("SELECT * FROM sessions WHERE user_id = 'U-OF'")).toHaveLength(0);
    expect((await rows("SELECT * FROM audit_log WHERE action='DELETE' AND entity='User'")).length).toBe(1);
  });

  it('users RPCs are admin only', async () => {
    expect(await rpc('apiGetUsers', [], officerCookie)).toMatchObject({ code: 'FORBIDDEN' });
    expect(await rpc('apiSaveUsers', [[]], officerCookie)).toMatchObject({ code: 'FORBIDDEN' });
    expect(await rpc('apiDeleteUsers', [['U-AD']], officerCookie)).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('low-stock cron', () => {
  it('cron sends one Telegram message when low stock and enabled', async () => {
    await setSettings();
    await addMat('M1', 'A1', 0, 2);
    await addMat('M2', 'A2', 1, 2);
    await addMat('M3', 'A3', 50, 2);
    await runLowStockCron(env);
    expect(sent()).toHaveLength(1);
    const { url, body } = sent()[0];
    expect(url).toBe('https://api.telegram.org/bot123456:ABCDEFG/sendMessage');
    expect(body.chat_id).toBe('-100123');
    expect(body.text).toBe(
      '⚠️ <b>แจ้งเตือนสต็อกพัสดุ</b>\nหมดสต็อก: 1 รายการ\nใกล้หมด: 1 รายการ\n\n• A1 พัสดุ A1 → 0 ชิ้น\n• A2 พัสดุ A2 → 1 ชิ้น\n',
    );
  });

  it('cron truncates after 15 items', async () => {
    await setSettings();
    for (let i = 0; i < 17; i++) await addMat(`M${i}`, `C${String(i).padStart(2, '0')}`, 0, 1);
    await runLowStockCron(env);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].body.text).toContain('... และอีก 2 รายการ');
  });

  it("cron sends nothing when NotifyLowStock is 'NO', no token/chat, or nothing is low", async () => {
    await addMat('M1', 'A1', 0, 2);
    await setSettings({ notify_low_stock: 'NO' });
    await runLowStockCron(env);
    await setSettings({ telegram_bot_token: '' });
    await runLowStockCron(env);
    await setSettings({ telegram_chat_id: '' });
    await runLowStockCron(env);
    await setSettings();
    await env.DB.prepare('UPDATE materials SET stock_qty = 100').run();
    await runLowStockCron(env);
    expect(sent()).toHaveLength(0);
  });

  it('cron never throws', async () => {
    await setSettings();
    await addMat('M1', 'A1', 0, 2);
    fetchSpy.mockImplementation(async () => {
      throw new Error('network down');
    });
    await expect(runLowStockCron(env)).resolves.toBeUndefined();
  });
});

describe('request notifications', () => {
  const create = () =>
    guest('apiCreateRequest', [{ FullName: 'สมชาย', Department: 'ฝ่าย', Purpose: 'ใช้งาน', items: [{ MaterialID: 'M1', Qty: 2 }] }]);

  it('new request triggers telegram when NotifyOnNewRequest is YES', async () => {
    await setSettings();
    await addMat('M1', 'A1', 10, 1);
    expect((await create()).ok).toBe(true);
    const [r] = await rows('SELECT * FROM requests');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    const { url, body } = sent()[0];
    expect(url).toBe('https://api.telegram.org/bot123456:ABCDEFG/sendMessage');
    expect(body.text).toContain(`<code>${r.doc_no}</code>`);
    expect(body.text).toContain('🔔 <b>มีใบขอเบิกพัสดุใหม่</b>');
    expect(body.text).toContain('🎯 <b>วัตถุประสงค์:</b> ใช้งาน'); expect(body.text).not.toContain('1. พัสดุ A1');
    expect(body.text).not.toContain('รอการอนุมัติ');
  });

  it('new request sends nothing when flag is NO; telegram failure does not break the RPC', async () => {
    await setSettings({ notify_on_new_request: 'NO' });
    await addMat('M1', 'A1', 10, 1);
    expect((await create()).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent()).toHaveLength(0);
    await setSettings();
    fetchSpy.mockImplementation(async () => {
      throw new Error('down');
    });
    expect((await create()).ok).toBe(true);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });

  it('status change: rejection does not send telegram message', async () => {
    await setSettings();
    await addMat('M1', 'A1', 10, 1);
    await create();
    const [r] = await rows('SELECT * FROM requests');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    const res = await rpc('apiUpdateRequestStatus', [[{ ID: r.id, Status: 'REJECTED', RejectReason: 'ไม่อนุมัติเนื่องจากงบไม่พอ' }]]);
    expect(res.ok).toBe(true);
    // Telegram reject notification is disabled
    expect(sent()).toHaveLength(1);
  });

  it('approval sends a short telegram and LINE message', async () => {
    await setSettings();
    await env.DB.prepare('UPDATE settings SET line_token = ?, line_to = ? WHERE id = 1').bind('LTOKEN', 'Cgroup1').run();
    await addMat('M1', 'A1', 10, 1);
    await create();
    const [r] = await rows('SELECT * FROM requests');
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    const res = await rpc('apiUpdateRequestStatus', [[{ ID: r.id, Status: 'APPROVED' }]]);
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(sent()).toHaveLength(4));
    const tg = sent()[2];
    expect(tg.url).toBe('https://api.telegram.org/bot123456:ABCDEFG/sendMessage');
    expect(tg.body.text).toContain('✅ <b>อนุมัติใบขอเบิกพัสดุแล้ว</b>');
    expect(tg.body.text).toContain(`<code>${r.doc_no}</code>`);
    const push = sent()[3];
    expect(push.url).toBe('https://api.line.me/v2/bot/message/push');
    expect(push.body.messages[0].type).toBe('flex');
    const card = JSON.stringify(push.body.messages[0].contents);
    expect(card).toContain('✅ อนุมัติใบขอเบิกพัสดุแล้ว');
    expect(card).toContain(r.doc_no);
    expect(card).toContain('1 รายการ');
    expect(card).toContain('20.00 บาท');
  });

  it('new request pushes a LINE message when token and group id are set', async () => {
    await setSettings();
    await env.DB.prepare('UPDATE settings SET line_token = ?, line_to = ? WHERE id = 1').bind('LTOKEN', 'Cgroup1').run();
    await addMat('M1', 'A1', 10, 1);
    await create();
    const [r] = await rows('SELECT * FROM requests');
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    const push = sent().find((s: { url: string }) => s.url === 'https://api.line.me/v2/bot/message/push');
    expect(push?.body.to).toBe('Cgroup1');
    expect(push?.body.messages[0].type).toBe('flex');
    const card = JSON.stringify(push?.body.messages[0].contents);
    expect(card).toContain(r.doc_no);
    expect(card).toContain('ใช้งาน');
    expect(card).toContain('1 รายการ');
    expect(card).toContain('20.00 บาท');
  });

  it('LINE push is skipped when the group id is empty', async () => {
    await setSettings();
    await env.DB.prepare("UPDATE settings SET line_token = 'LTOKEN', line_to = '' WHERE id = 1").run();
    await addMat('M1', 'A1', 10, 1);
    await create();
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    await new Promise((r2) => setTimeout(r2, 50));
    expect(sent().map((s: { url: string }) => s.url)).toEqual(['https://api.telegram.org/bot123456:ABCDEFG/sendMessage']);
  });

  it('status change sends nothing when flag is NO', async () => {
    await setSettings({ notify_on_new_request: 'NO', notify_on_status_change: 'NO' });
    await addMat('M1', 'A1', 10, 1);
    await create();
    const [r] = await rows('SELECT * FROM requests');
    await rpc('apiUpdateRequestStatus', [[{ ID: r.id, Status: 'APPROVED' }]]);
    await new Promise((r2) => setTimeout(r2, 50));
    expect(sent()).toHaveLength(0);
  });

  it('new-request and approval toggles are independent', async () => {
    // Approval alert off, new-request alert on: creating sends, approving does not.
    await setSettings({ notify_on_new_request: 'YES', notify_on_status_change: 'NO' });
    await addMat('M1', 'A1', 10, 1);
    await create();
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    const [r] = await rows('SELECT * FROM requests');
    await rpc('apiUpdateRequestStatus', [[{ ID: r.id, Status: 'APPROVED' }]]);
    await new Promise((r2) => setTimeout(r2, 50));
    expect(sent()).toHaveLength(1);
  });

  it('new-request off, approval on: creating sends nothing, approving sends', async () => {
    await setSettings({ notify_on_new_request: 'NO', notify_on_status_change: 'YES' });
    await addMat('M1', 'A1', 10, 1);
    await create();
    await new Promise((r2) => setTimeout(r2, 50));
    expect(sent()).toHaveLength(0);
    const [r] = await rows('SELECT * FROM requests');
    await rpc('apiUpdateRequestStatus', [[{ ID: r.id, Status: 'APPROVED' }]]);
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
  });
});
