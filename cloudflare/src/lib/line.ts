export interface LineResult {
  ok: boolean;
  message?: string;
}

/**
 * Send notification via LINE Notify API.
 * Never throws; returns { ok, message }.
 */
export async function sendLineNotify(token: string, message: string): Promise<LineResult> {
  const trimmed = String(token || '').trim();
  if (!trimmed) return { ok: false, message: 'กรุณาระบุ LINE Notify Token' };

  try {
    const body = new URLSearchParams();
    body.append('message', message);

    const resp = await fetch('https://notify-api.line.me/api/notify', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${trimmed}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (resp.status >= 200 && resp.status < 300) {
      return { ok: true, message: 'ส่งข้อความสำเร็จ' };
    }

    let errMsg = `LINE API Error (${resp.status})`;
    const content = await resp.text().catch(() => '');
    try {
      const parsed = JSON.parse(content) as { message?: string } | null;
      if (parsed?.message) errMsg += `: ${parsed.message}`;
    } catch {
      if (content) errMsg += `: ${content.substring(0, 100)}`;
    }
    return { ok: false, message: errMsg };
  } catch (err) {
    console.error('LINE notify error', (err as Error)?.name);
    return { ok: false, message: 'ส่งข้อความ LINE ไม่สำเร็จ' };
  }
}
