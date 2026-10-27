import type { Env } from './env';
import { listMaterials } from './api/materials';
import { getNotifyConfig, lowStockText, sendTelegram } from './lib/telegram';
import type { Ctx } from './rpc';

/** Daily low-stock Telegram message (legacy notifyLowStock_). Errors are logged, never thrown. */
export async function runLowStockCron(env: Env): Promise<void> {
  try {
    const cfg = await getNotifyConfig(env);
    if (!cfg.notifyTelegram || !cfg.onLowStock || !cfg.token || !cfg.chatId) return;
    const low = (await listMaterials({ env } as Ctx)).filter((m) => m.StockState !== 'OK');
    if (!low.length) return;
    const res = await sendTelegram(cfg.token, cfg.chatId, lowStockText(low));
    if (!res.ok) console.error('low-stock telegram failed', res.message);
  } catch (err) {
    console.error('low-stock cron failed', (err as Error)?.name);
  }
}
