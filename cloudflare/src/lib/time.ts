const BKK_OFFSET_MS = 7 * 3600_000;

const bkkIso = (at: Date): string => new Date(at.getTime() + BKK_OFFSET_MS).toISOString();

/** 'YYYY-MM-DD HH:MM:SS' in Asia/Bangkok (UTC+7, no DST). */
export function nowBkk(at: Date = new Date()): string {
  return bkkIso(at).slice(0, 19).replace('T', ' ');
}

/** 'YYYY-MM-DD' in Asia/Bangkok. */
export function todayBkk(at: Date = new Date()): string {
  return bkkIso(at).slice(0, 10);
}

/** Buddhist-era fiscal year; starts 1 Oct (Bangkok), so Oct-Dec belong to the next year. */
export function currentFiscalYear(at: Date = new Date()): number {
  const year = Number(bkkIso(at).slice(0, 4));
  const month = Number(bkkIso(at).slice(5, 7));
  return year + 543 + (month >= 10 ? 1 : 0);
}

/** Gregorian day range of a B.E. fiscal year: 1 Oct (fy-544) .. 30 Sep (fy-543). */
export function fiscalYearRange(fy: number): { from: string; to: string } {
  return { from: `${fy - 544}-10-01`, to: `${fy - 543}-09-30` };
}
