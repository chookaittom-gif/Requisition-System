import { genId } from './ids';
import { nowBkk } from './time';

export interface MovementInput {
  materialId: string;
  type: 'IN' | 'OUT' | 'ADJUST';
  /** IN/OUT: quantity moved. ADJUST: the NEW absolute stock (qty column becomes |new - before|). */
  qty: number;
  refDoc: string;
  note: string;
  actor: string;
  guardRequestId?: string;
  guardTxn?: string;
}

/**
 * INSERT ... SELECT from materials so before_qty/after_qty reflect the row at execution time.
 * In a db.batch this MUST come before the UPDATE of the same material. When a guard is given the
 * row is only written if the request still carries the same stock_txn (Task 5 idempotency).
 */
export function movementStmt(db: D1Database, m: MovementInput): D1PreparedStatement {
  if ((m.guardRequestId === undefined) !== (m.guardTxn === undefined)) {
    throw new Error('movementStmt: guardRequestId and guardTxn must be given together');
  }
  const qtyExpr = m.type === 'ADJUST' ? 'ABS(? - stock_qty)' : '?';
  const afterExpr = m.type === 'IN' ? 'stock_qty + ?' : m.type === 'OUT' ? 'stock_qty - ?' : '?';
  const guard = m.guardRequestId !== undefined ? ' AND EXISTS (SELECT 1 FROM requests WHERE id = ? AND stock_txn = ?)' : '';
  const sql =
    'INSERT INTO stock_movements (id, material_id, code, name, type, qty, before_qty, after_qty, ref_doc, note, actor, created_at) ' +
    `SELECT ?, id, code, name, ?, ${qtyExpr}, stock_qty, ${afterExpr}, ?, ?, ?, ? FROM materials WHERE id = ?${m.type === 'ADJUST' ? ' AND stock_qty <> ?' : ''}${guard}`;
  const binds: unknown[] = [genId('SM'), m.type, m.qty, m.qty, m.refDoc, m.note, m.actor, nowBkk(), m.materialId];
  if (m.type === 'ADJUST') binds.push(m.qty);
  if (m.guardRequestId !== undefined) binds.push(m.guardRequestId, m.guardTxn ?? '');
  return db.prepare(sql).bind(...binds);
}
