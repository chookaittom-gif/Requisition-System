import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no type declarations
import { planReconcile } from '../../scripts/reconcile-lots.mjs';

const mat = (id: string, stock: number, price = 10) => ({ id, code: id, name: id, stock_qty: stock, unit_price: price });
const lot = (id: string, m: string, remaining: number, price = 10, status = 'ACTIVE') => ({
  id, material_id: m, remaining_qty: remaining, unit_price: price, status,
});

describe('planReconcile', () => {
  it('reports nothing when lot totals equal stock', () => {
    expect(planReconcile([mat('A', 5)], [lot('L1', 'A', 5)])).toEqual([]);
  });

  it('too little in lots: tops up the latest lot', () => {
    const plan = planReconcile([mat('A', 9)], [lot('L1', 'A', 4), lot('L2', 'A', 3, 20)]);
    expect(plan).toEqual([
      { materialId: 'A', code: 'A', stock: 9, lotTotal: 7, diff: 2, action: 'ADD_TO_LOT', lotId: 'L2', newRemaining: 5 },
    ]);
  });

  it('too much in lots: takes the surplus from the latest lot first', () => {
    const plan = planReconcile([mat('A', 4)], [lot('L1', 'A', 3), lot('L2', 'A', 3, 20)]);
    expect(plan).toEqual([
      { materialId: 'A', code: 'A', stock: 4, lotTotal: 6, diff: -2, action: 'TRIM_LOTS', changes: [{ lotId: 'L2', newRemaining: 1 }] },
    ]);
  });

  it('surplus larger than the latest lot spills into the previous one', () => {
    const [p] = planReconcile([mat('A', 1)], [lot('L1', 'A', 3), lot('L2', 'A', 2, 20)]);
    expect(p.changes).toEqual([
      { lotId: 'L2', newRemaining: 0 },
      { lotId: 'L1', newRemaining: 1 },
    ]);
  });

  it('stock but no lots at all: creates one at the material price', () => {
    expect(planReconcile([mat('A', 3, 15)], [])).toEqual([
      { materialId: 'A', code: 'A', stock: 3, lotTotal: 0, diff: 3, action: 'CREATE_LOT', unitPrice: 15 },
    ]);
  });

  it('zero stock with leftover lots drains them', () => {
    const [p] = planReconcile([mat('A', 0)], [lot('L1', 'A', 2)]);
    expect(p).toMatchObject({ action: 'TRIM_LOTS', changes: [{ lotId: 'L1', newRemaining: 0 }] });
  });

  it('ignores depleted lots when totalling', () => {
    expect(planReconcile([mat('A', 2)], [lot('L0', 'A', 0, 5, 'DEPLETED'), lot('L1', 'A', 2)])).toEqual([]);
  });
});
