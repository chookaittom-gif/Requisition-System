export interface LineResult {
  ok: boolean;
  message?: string;
}

/**
 * Push a text message through the LINE Messaging API (LINE Notify has been shut down).
 * `token` is the Channel access token and `to` a Group ID or User ID; both are secrets and are never logged.
 * Never throws; returns { ok, message }.
 */
export async function sendLinePush(token: string, to: string, text: string): Promise<LineResult> {
  const t = String(token || '').trim();
  const dest = String(to || '').trim();
  if (!t) return { ok: false, message: 'กรุณาระบุ LINE Channel access token' };
  if (!dest) return { ok: false, message: 'กรุณาระบุ LINE Group ID หรือ User ID' };

  try {
    const resp = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ to: dest, messages: [{ type: 'text', text }] }),
    });
    if (resp.status >= 200 && resp.status < 300) return { ok: true, message: 'ส่งข้อความสำเร็จ' };

    let msg = `LINE API Error (${resp.status})`;
    const content = await resp.text().catch(() => '');
    try {
      const parsed = JSON.parse(content) as { message?: string } | null;
      if (parsed?.message) msg += `: ${parsed.message}`;
    } catch {
      /* non-JSON body: keep the status only */
    }
    return { ok: false, message: msg };
  } catch (err) {
    console.error('LINE push error', (err as Error)?.name);
    return { ok: false, message: 'ส่งข้อความ LINE ไม่สำเร็จ' };
  }
}
