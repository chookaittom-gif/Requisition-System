import type { Env } from '../env';

export interface TelegramResult {
  ok: boolean;
  message?: string;
}

/** Legacy sendTelegramNotify_: sendMessage with HTML parse mode. Never throws. */
export async function sendTelegram(token: string, chatId: string, html: string): Promise<TelegramResult> {
  if (!token || !chatId) return { ok: false, message: 'กรุณาระบุ Telegram Bot Token และ Chat ID' };
  if (!token.includes(':')) {
    return { ok: false, message: 'รูปแบบ Telegram Bot Token ไม่ถูกต้อง (ต้องมีเครื่องหมาย : เช่น 123456:ABC... ที่ได้รับจาก @BotFather)' };
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (resp.status >= 200 && resp.status < 300) return { ok: true, message: 'ส่งข้อความสำเร็จ' };
    let msg = `Telegram API Error (${resp.status})`;
    const content = await resp.text().catch(() => '');
    try {
      const parsed = JSON.parse(content) as { description?: string } | null;
      if (parsed?.description) msg += `: ${parsed.description}`;
    } catch {
      msg += `: ${content.substring(0, 120)}`;
    }
    console.error(msg);
    return { ok: false, message: msg };
  } catch (err) {
    // The error text can embed the request URL (and so the token); never log or return it.
    console.error('Telegram error', (err as Error)?.name);
    return { ok: false, message: 'ส่งข้อความ Telegram ไม่สำเร็จ' };
  }
}

export const MASK = '••••';

export const maskToken = (token: string): string => (token ? MASK + token.slice(-4) : '');

export const isMaskedToken = (v: string): boolean => v.startsWith(MASK);

/** Escape user-supplied text for Telegram parse_mode=HTML. */
export const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

/** Legacy thaiDateFull_. */
export function thaiDateFull(isoDate: string): string {
  if (!isoDate) return '';
  const parts = String(isoDate).substring(0, 10).split('-');
  if (parts.length < 3) return isoDate;
  const y = parseInt(parts[0], 10) + 543;
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  return `${d} ${THAI_MONTHS[m] || ''} ${y}`;
}

export interface NotifyConfig {
  token: string;
  chatId: string;
  onNewRequest: boolean;
  onStatusChange: boolean;
  onLowStock: boolean;
  notifyTelegram: boolean;
  notifyLine: boolean;
  schoolName: string;
}

/** Reads settings row 1. Flags are on only when stored as 'YES'. */
export async function getNotifyConfig(env: Env): Promise<NotifyConfig> {
  const s = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first<Record<string, string>>();
  return {
    token: s?.telegram_bot_token ?? '',
    chatId: s?.telegram_chat_id ?? '',
    onNewRequest: s?.notify_on_new_request === 'YES',
    onStatusChange: s?.notify_on_status_change === 'YES',
    onLowStock: s?.notify_low_stock === 'YES',
    notifyTelegram: s?.notify_telegram !== 'NO',
    notifyLine: s?.notify_line !== 'NO',
    schoolName: s?.school_name || 'ระบบเบิกจ่ายพัสดุ',
  };
}

type Obj = Record<string, unknown>;

/** New-request Telegram text with item list (capped at 10 items). */
export function newRequestText(req: Obj): string {
  const total = Number(req.TotalAmount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 });
  let text = (
    `🔔 <b>มีใบขอเบิกพัสดุใหม่</b>\n` +
    `📄 <b>เลขที่:</b> <code>${esc(req.DocNo)}</code>\n` +
    `👤 <b>ผู้ขอเบิก:</b> ${esc(req.FullName)}\n` +
    `🏢 <b>หลักสูตร / ฝ่ายงาน / โครงการ:</b> ${esc(req.Department || '-')}\n` +
    `🎯 <b>วัตถุประสงค์:</b> ${esc(req.Purpose || '-')}\n` +
    `📊 <b>จำนวน:</b> ${esc(req.ItemCount)} รายการ | <b>มูลค่ารวม:</b> ${total} บาท`
  );

  const items = Array.isArray(req.Items) ? (req.Items as Obj[]) : [];
  if (items.length > 0) {
    const lines = items.slice(0, 10).map((it) => {
      const unit = it.Unit ? ` ${it.Unit}` : '';
      return `  • ${esc(it.Name)}: <b>${it.Qty}</b>${unit}`;
    });
    if (items.length > 10) lines.push(`  <i>...และอีก ${items.length - 10} รายการ</i>`);
    text += `\n\n📦 <b>รายการพัสดุที่ขอเบิก:</b>\n` + lines.join('\n');
  }
  return text;
}

/** Approved-request Telegram text with approved and rejected breakdown (capped at 10 items). */
export function approvedRequestText(req: Obj): string {
  const total = Number(req.TotalAmount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 });
  const items = Array.isArray(req.Items) ? (req.Items as Obj[]) : [];
  let approvedCount = 0;
  let rejectedCount = 0;
  const approvedLines: string[] = [];
  const rejectedLines: string[] = [];

  for (const it of items) {
    const aQty = Number(it.ApprovedQty ?? it.Qty ?? 0);
    const reqQty = Number(it.Qty ?? 0);
    const unit = it.Unit ? ` ${it.Unit}` : '';
    if (aQty > 0) {
      approvedCount++;
      approvedLines.push(`  • ${esc(it.Name)}: <b>${aQty}</b>${unit}${aQty < reqQty ? ` (ขอ ${reqQty})` : ''}`);
    } else {
      rejectedCount++;
      rejectedLines.push(`  • ${esc(it.Name)} (ขอ ${reqQty}${unit} - ไม่อนุมัติ)`);
    }
  }

  const isPartial = Boolean(req.IsPartial || rejectedCount > 0 || (items.length > 0 && items.some((it: any) => it.ApprovedQty !== undefined && it.ApprovedQty < it.Qty)));
  const title = isPartial ? '✅ <b>อนุมัติใบขอเบิกพัสดุแล้ว (อนุมัติบางส่วน)</b>\n' : '✅ <b>อนุมัติใบขอเบิกพัสดุแล้ว</b>\n';
  const summaryLine = items.length > 0
    ? `📊 <b>สรุปผล:</b> อนุมัติ ${approvedCount} รายการ | ไม่อนุมัติ ${rejectedCount} รายการ (<b>มูลค่ารวม:</b> ${total} บาท)`
    : `📊 <b>จำนวน:</b> ${esc(req.ItemCount)} รายการ | <b>มูลค่ารวม:</b> ${total} บาท`;

  let text = (
    title +
    `📄 <b>เลขที่:</b> <code>${esc(req.DocNo)}</code>\n` +
    `👤 <b>ผู้ขอเบิก:</b> ${esc(req.FullName)}\n` +
    `🏢 <b>หลักสูตร / ฝ่ายงาน / โครงการ:</b> ${esc(req.Department || '-')}\n` +
    summaryLine
  );

  if (approvedLines.length > 0) {
    const disp = approvedLines.slice(0, 10);
    if (approvedLines.length > 10) disp.push(`  <i>...และอีก ${approvedLines.length - 10} รายการ</i>`);
    text += `\n\n📦 <b>รายการที่อนุมัติ:</b>\n` + disp.join('\n');
  }
  if (rejectedLines.length > 0) {
    const disp = rejectedLines.slice(0, 10);
    if (rejectedLines.length > 10) disp.push(`  <i>...และอีก ${rejectedLines.length - 10} รายการ</i>`);
    text += `\n\n❌ <b>รายการที่ตัดออก:</b>\n` + disp.join('\n');
  }

  return text;
}

export function rejectedRequestText(req: Obj, reason?: string): string {
  const total = Number(req.TotalAmount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 });
  return (
    `❌ <b>ไม่อนุมัติใบขอเบิกพัสดุ</b>\n` +
    `📄 <b>เลขที่:</b> <code>${esc(req.DocNo)}</code>\n` +
    `👤 <b>ผู้ขอเบิก:</b> ${esc(req.FullName)}\n` +
    `🏢 <b>หลักสูตร / ฝ่ายงาน / โครงการ:</b> ${esc(req.Department || '-')}\n` +
    `❗ <b>เหตุผล:</b> ${esc(reason || req.RejectReason || '-')}\n` +
    `📊 <b>จำนวน:</b> ${esc(req.ItemCount)} รายการ | <b>มูลค่ารวม:</b> ${total} บาท`
  );
}

/** Legacy notifyLowStock_ Telegram text. `low` = materials whose StockState is not OK. */
export function lowStockText(low: Obj[]): string {
  const outCount = low.filter((m) => m.StockState === 'OUT').length;
  const lowCount = low.filter((m) => m.StockState === 'LOW').length;
  let lines = `⚠️ <b>แจ้งเตือนสต็อกพัสดุ</b>\nหมดสต็อก: ${outCount} รายการ\nใกล้หมด: ${lowCount} รายการ\n\n`;
  for (const m of low.slice(0, 15)) lines += `• ${esc(m.Code)} ${esc(m.Name)} → ${m.StockQty} ${esc(m.Unit)}\n`;
  if (low.length > 15) lines += `... และอีก ${low.length - 15} รายการ`;
  return lines;
}
