import { genId } from './ids';
import { nowBkk } from './time';

/** Returns the INSERT statement so callers can include it in a db.batch with the related write. */
export function logAudit(
  db: D1Database,
  e: { action: string; entity: string; entityId: string; detail: string; actor: string },
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO audit_log (id, action, entity, entity_id, detail, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(genId('AUD'), e.action, e.entity, e.entityId, e.detail, e.actor, nowBkk());
}
