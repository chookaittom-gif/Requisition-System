import { fail } from '../http';
import { logAudit } from '../lib/audit';
import { toLegacy } from '../lib/rows';
import { nowBkk } from '../lib/time';
import { registerRpc, type Ctx } from '../rpc';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asObj = (v: unknown): Obj => (isObj(v) ? v : {});
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
    console.error('personnel rpc failed', err);
    return fail('เกิดข้อผิดพลาดในการบันทึกข้อมูลบุคลากร');
  }
}

const actorOf = (ctx: Ctx): string => ctx.session?.username ?? '';

registerRpc('apiLookupPersonnel', 'public', (ctx, args) =>
  guarded(async () => {
    const code = str(args[0]);
    if (!code) return fail('กรุณาระบุรหัสบุคลากร');
    const row = await ctx.env.DB.prepare(
      'SELECT code, full_name, position, department FROM personnel WHERE LOWER(code) = LOWER(?) AND active = 1'
    )
      .bind(code)
      .first<{ code: string; full_name: string; position: string; department: string }>();

    if (!row) return fail('ไม่พบข้อมูลบุคลากรสำหรับรหัสดังกล่าว');
    return {
      ok: true,
      data: {
        Code: row.code,
        FullName: row.full_name,
        Position: row.position,
        Department: row.department,
      },
    };
  })
);

registerRpc('apiGetPersonnel', 'officer', async (ctx) => {
  const { results } = await ctx.env.DB.prepare(
    'SELECT code, full_name, position, department, active, created_at, updated_at FROM personnel ORDER BY code ASC'
  ).all<Obj>();
  const data = results.map((r) => toLegacy('personnel', r));
  return { ok: true, data };
});

registerRpc('apiSavePersonnel', 'admin', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const p = asObj(args[0]);
    const actor = actorOf(ctx);
    const code = str(p.Code);
    if (!code) return fail('กรุณาระบุรหัสบุคลากร');
    const fullName = str(p.FullName);
    if (!fullName) return fail('กรุณาระบุชื่อ-นามสกุลบุคลากร');
    const position = str(p.Position);
    const department = str(p.Department);
    const active = p.Active === 0 || p.Active === false || p.Active === '0' ? 0 : 1;
    const now = nowBkk();

    if (p.action === 'delete') {
      await db.batch([
        db.prepare('DELETE FROM personnel WHERE LOWER(code) = LOWER(?)').bind(code),
        logAudit(db, { action: 'DELETE', entity: 'Personnel', entityId: code, detail: fullName || code, actor }),
      ]);
      return { ok: true, message: 'ลบข้อมูลบุคลากรเรียบร้อยแล้ว' };
    }

    const existing = await db
      .prepare('SELECT code FROM personnel WHERE LOWER(code) = LOWER(?)')
      .bind(code)
      .first<{ code: string }>();

    if (p.action === 'create' && existing) {
      return fail(`รหัสบุคลากร "${code}" มีอยู่แล้วในระบบ`);
    }

    if (existing) {
      await db.batch([
        db
          .prepare(
            'UPDATE personnel SET full_name = ?, position = ?, department = ?, active = ?, updated_at = ? WHERE LOWER(code) = LOWER(?)'
          )
          .bind(fullName, position, department, active, now, code),
        logAudit(db, { action: 'UPDATE', entity: 'Personnel', entityId: code, detail: fullName, actor }),
      ]);
      return { ok: true, message: 'บันทึกข้อมูลบุคลากรเรียบร้อยแล้ว' };
    } else {
      await db.batch([
        db
          .prepare(
            'INSERT INTO personnel (code, full_name, position, department, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(code, fullName, position, department, active, now, now),
        logAudit(db, { action: 'CREATE', entity: 'Personnel', entityId: code, detail: fullName, actor }),
      ]);
      return { ok: true, message: 'เพิ่มข้อมูลบุคลากรเรียบร้อยแล้ว' };
    }
  })
);

registerRpc('apiDeletePersonnel', 'admin', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const codes = (Array.isArray(args[0]) ? args[0] : [args[0]]).map(str).filter(Boolean);
    if (!codes.length) return fail('ไม่พบรหัสบุคลากรที่ต้องการลบ');
    const actor = actorOf(ctx);
    const stmts: D1PreparedStatement[] = [];
    for (const code of codes) {
      stmts.push(db.prepare('DELETE FROM personnel WHERE LOWER(code) = LOWER(?)').bind(code));
      stmts.push(logAudit(db, { action: 'DELETE', entity: 'Personnel', entityId: code, detail: code, actor }));
    }
    await db.batch(stmts);
    return { ok: true, message: 'ลบข้อมูลบุคลากรเรียบร้อยแล้ว' };
  })
);

registerRpc('apiImportPersonnel', 'admin', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const rows = Array.isArray(args[0]) ? args[0].filter(isObj) : [];
    if (!rows.length) return fail('ไม่พบข้อมูลสำหรับนำเข้า');
    const actor = actorOf(ctx);
    const now = nowBkk();

    let count = 0;
    const CHUNK_SIZE = 40;
    let currentBatch: D1PreparedStatement[] = [];

    for (const r of rows) {
      const code = str(r.Code ?? r.code ?? r['รหัสบุคลากร'] ?? r['รหัส']);
      const fullName = str(r.FullName ?? r.fullName ?? r.full_name ?? r['ชื่อ-นามสกุล'] ?? r['ชื่อ-สกุล'] ?? r['ชื่อ']);
      if (!code || !fullName) continue;

      const position = str(r.Position ?? r.position ?? r['ตำแหน่ง']);
      const department = str(r.Department ?? r.department ?? r['หลักสูตร'] ?? r['ฝ่ายงาน'] ?? r['หลักสูตร/ฝ่ายงาน']);
      const rawActive = r.Active !== undefined ? r.Active : (r.active !== undefined ? r.active : 1);
      const active = rawActive === 0 || rawActive === false || rawActive === '0' || String(rawActive).toLowerCase() === 'inactive' ? 0 : 1;

      currentBatch.push(
        db.prepare(
          `INSERT INTO personnel (code, full_name, position, department, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(code) DO UPDATE SET
             full_name = excluded.full_name,
             position = excluded.position,
             department = excluded.department,
             active = excluded.active,
             updated_at = excluded.updated_at`
        ).bind(code, fullName, position, department, active, now, now)
      );
      count++;

      if (currentBatch.length >= CHUNK_SIZE) {
        await db.batch(currentBatch);
        currentBatch = [];
      }
    }

    if (currentBatch.length > 0) {
      await db.batch(currentBatch);
    }

    if (count > 0) {
      await db.batch([
        logAudit(db, {
          action: 'IMPORT',
          entity: 'Personnel',
          entityId: '',
          detail: `นำเข้าข้อมูลบุคลากรจำนวน ${count} รายการ`,
          actor,
        }),
      ]);
    }

    return { ok: true, message: `นำเข้าข้อมูลบุคลากรสำเร็จ ${count} รายการ`, count };
  })
);
