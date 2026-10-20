import { fail } from '../http';
import { logAudit } from '../lib/audit';
import { genId } from '../lib/ids';
import { toLegacy } from '../lib/rows';
import { nowBkk } from '../lib/time';
import { registerRpc, type Ctx } from '../rpc';

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => String(v ?? '').trim();

class ValidationError extends Error {}

/** Run a mutating handler: Thai user errors and D1 constraint failures never leak raw SQLite text. */
async function guarded(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message, 'VALIDATION');
    const msg = String((err as Error)?.message ?? err);
    if (/UNIQUE constraint/i.test(msg)) return fail('ข้อมูลซ้ำกับที่มีอยู่แล้วในระบบ');
    console.error('shops rpc failed', err);
    return fail('เกิดข้อผิดพลาดในการบันทึกข้อมูล');
  }
}

const actorOf = (ctx: Ctx): string => ctx.session?.username ?? '';

export async function ensureShopExists(
  db: D1Database,
  shop: { name: string; taxId?: string; address?: string; phone?: string; actor?: string }
): Promise<void> {
  const name = str(shop.name);
  if (!name) return;
  const existing = await db.prepare('SELECT id FROM shops WHERE LOWER(name) = LOWER(?)').bind(name).first();
  if (!existing) {
    const id = genId('SHP');
    const now = nowBkk();
    await db.batch([
      db
        .prepare(
          'INSERT INTO shops (id, name, tax_id, address, phone, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(id, name, str(shop.taxId), str(shop.address), str(shop.phone), '', now, now),
      logAudit(db, {
        action: 'CREATE',
        entity: 'Shop',
        entityId: id,
        detail: `สร้างร้านค้าใหม่อัตโนมัติจากพัสดุ: ${name}`,
        actor: shop.actor ?? '',
      }),
    ]);
  }
}

registerRpc('apiGetShops', 'officer', async (ctx) => {
  const { results } = await ctx.env.DB.prepare('SELECT * FROM shops').all<Obj>();
  const data = results
    .map((r) => toLegacy('shops', r))
    .sort((a, b) => String(a.Name ?? '').localeCompare(String(b.Name ?? ''), 'th'));
  return { ok: true, data };
});

registerRpc('apiSaveShop', 'officer', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const p = asObj(args[0]);
    const actor = actorOf(ctx);
    const name = str(p.Name);
    if (!name) return fail('กรุณาระบุชื่อร้านค้า');
    const id = str(p.ID);

    if (p.action === 'delete') {
      await db.batch([
        db.prepare('DELETE FROM shops WHERE id = ?').bind(id),
        logAudit(db, { action: 'DELETE', entity: 'Shop', entityId: id, detail: name, actor }),
      ]);
      return { ok: true, message: 'ลบข้อมูลร้านค้าเรียบร้อยแล้ว' };
    }

    const dupName = await db
      .prepare('SELECT id FROM shops WHERE LOWER(name) = LOWER(?) AND id != ?')
      .bind(name, id || '')
      .first();
    if (dupName) return fail(`ชื่อร้านค้า "${name}" มีอยู่แล้วในระบบ`);

    const taxId = str(p.TaxId);
    const address = str(p.Address);
    const phone = str(p.Phone);
    const note = str(p.Note);
    const now = nowBkk();

    if (p.action === 'update' || (id && p.action !== 'create')) {
      await db.batch([
        db
          .prepare(
            'UPDATE shops SET name = ?, tax_id = ?, address = ?, phone = ?, note = ?, updated_at = ? WHERE id = ?'
          )
          .bind(name, taxId, address, phone, note, now, id),
        logAudit(db, { action: 'UPDATE', entity: 'Shop', entityId: id, detail: name, actor }),
      ]);
      return { ok: true, message: 'บันทึกข้อมูลร้านค้าเรียบร้อยแล้ว' };
    } else {
      const newId = genId('SHP');
      await db.batch([
        db
          .prepare(
            'INSERT INTO shops (id, name, tax_id, address, phone, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(newId, name, taxId, address, phone, note, now, now),
        logAudit(db, { action: 'CREATE', entity: 'Shop', entityId: newId, detail: name, actor }),
      ]);
      return { ok: true, message: 'เพิ่มร้านค้าเรียบร้อยแล้ว', id: newId };
    }
  })
);

registerRpc('apiDeleteShop', 'officer', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const id = str(args[0]);
    if (!id) return fail('ไม่พบรหัสร้านค้า');
    const actor = actorOf(ctx);
    const row = await db.prepare('SELECT name FROM shops WHERE id = ?').bind(id).first<{ name: string }>();
    const name = row?.name ?? id;

    await db.batch([
      db.prepare('DELETE FROM shops WHERE id = ?').bind(id),
      logAudit(db, { action: 'DELETE', entity: 'Shop', entityId: id, detail: name, actor }),
    ]);
    return { ok: true, message: 'ลบข้อมูลร้านค้าเรียบร้อยแล้ว' };
  })
);
