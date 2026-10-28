import { todayBkk } from './time';

export type IdPrefix = 'U' | 'M' | 'CAT' | 'R' | 'RI' | 'P' | 'SM' | 'AUD' | 'OB' | 'F' | 'SHP' | 'LOT';

/** '<PREFIX>-' + 8 uppercase hex chars, like legacy genId_. */
export function genId(prefix: IdPrefix): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex.toUpperCase()}`;
}

/** Atomic per-Bangkok-day sequence: 'REQ-yyyyMMdd-NNNN'. */
export async function nextDocNo(db: D1Database, at: Date = new Date()): Promise<string> {
  const day = todayBkk(at).replace(/-/g, '');
  const row = await db
    .prepare(
      'INSERT INTO doc_counters (day, seq) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET seq = seq + 1 RETURNING seq',
    )
    .bind(day)
    .first<{ seq: number }>();
  if (!row) throw new Error('doc_counters upsert returned no row');
  return `REQ-${day}-${String(row.seq).padStart(4, '0')}`;
}
