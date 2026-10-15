export interface LineResult {
  ok: boolean;
  message?: string;
}

/**
 * POST a JSON notification to the LINE webhook URL saved in settings (LINE Notify has been shut down).
 * The URL is a secret: it is never logged or returned in error messages. Never throws; returns { ok, message }.
 */
export async function sendLineWebhook(url: string, payload: Record<string, unknown>): Promise<LineResult> {
  const trimmed = String(url || '').trim();
  if (!trimmed) return { ok: false, message: 'กรุณาระบุ LINE Webhook URL' };
  if (!/^https:\/\//i.test(trimmed)) return { ok: false, message: 'LINE Webhook URL ต้องขึ้นต้นด้วย https://' };

  try {
    const resp = await fetch(trimmed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (resp.status >= 200 && resp.status < 300) return { ok: true, message: 'ส่งข้อความสำเร็จ' };
    return { ok: false, message: `LINE Webhook Error (${resp.status})` };
  } catch (err) {
    console.error('LINE webhook error', (err as Error)?.name);
    return { ok: false, message: 'ส่งข้อความ LINE ไม่สำเร็จ' };
  }
}
