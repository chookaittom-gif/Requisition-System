import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { currentFiscalYear, fiscalYearRange, nowBkk, todayBkk } from '../src/lib/time';
import { genId, nextDocNo } from '../src/lib/ids';
import { computeStockState, fromLegacy, toLegacy } from '../src/lib/rows';

describe('time', () => {
  it('nowBkk / todayBkk shift to UTC+7', () => {
    const at = new Date('2026-09-30T17:30:00Z');
    expect(nowBkk(at)).toBe('2026-10-01 00:30:00');
    expect(todayBkk(at)).toBe('2026-10-01');
  });
  it('fiscal year flips at Bangkok midnight on 1 Oct', () => {
    expect(currentFiscalYear(new Date('2026-09-30T17:30:00Z'))).toBe(2570);
    expect(currentFiscalYear(new Date('2026-09-30T16:59:59Z'))).toBe(2569);
  });
  it('fiscalYearRange', () => {
    expect(fiscalYearRange(2569)).toEqual({ from: '2025-10-01', to: '2026-09-30' });
  });
});

describe('ids', () => {
  it('genId format', () => {
    expect(genId('M')).toMatch(/^M-[0-9A-F]{8}$/);
    expect(genId('CAT')).toMatch(/^CAT-[0-9A-F]{8}$/);
  });
  it('nextDocNo increments per Bangkok day', async () => {
    const at = new Date('2026-10-12T03:00:00Z');
    expect(await nextDocNo(env.DB, at)).toBe('REQ-20261012-0001');
    expect(await nextDocNo(env.DB, at)).toBe('REQ-20261012-0002');
    expect(await nextDocNo(env.DB, new Date('2026-10-12T17:00:00Z'))).toBe('REQ-20261013-0001');
  });
});

describe('rows', () => {
  it('materials maps to legacy keys', () => {
    const out = toLegacy('materials', { id: 'M-1', stock_qty: 5, min_qty: 2, size_spec: 'A4' });
    expect(out).toMatchObject({ ID: 'M-1', StockQty: 5, MinQty: 2, SizeSpec: 'A4' });
  });
  it('users never emits password', () => {
    const out = toLegacy('users', { id: 'U-1', username: 'a', password_hash: 'sha256$x', full_name: 'N' });
    expect(out).toEqual({ ID: 'U-1', Username: 'a', FullName: 'N' });
  });
  it('irregular names', () => {
    expect(toLegacy('requests', { user_id: 'U-1', stock_applied: 1, stock_txn: 't' })).toEqual({ UserID: 'U-1' });
    expect(toLegacy('audit_log', { entity_id: 'E' })).toEqual({ EntityID: 'E' });
    expect(toLegacy('request_items', { request_id: 'R', material_id: 'M' })).toEqual({ RequestID: 'R', MaterialID: 'M' });
    expect(toLegacy('settings', { id: 1, telegram_bot_token: 'secret', school_name: 'S' })).toEqual({ SchoolName: 'S' });
  });
  it('fromLegacy inverts and drops unknown keys', () => {
    expect(fromLegacy('materials', { StockQty: 5, Bogus: 1 })).toEqual({ stock_qty: 5 });
    expect(fromLegacy('users', { Password: 'x', Username: 'a' })).toEqual({ password_hash: 'x', username: 'a' });
  });
  it('computeStockState', () => {
    expect(computeStockState(0, 2)).toBe('OUT');
    expect(computeStockState(2, 2)).toBe('LOW');
    expect(computeStockState(3, 2)).toBe('OK');
  });
});
