import type { Env } from '../env';
import { fail } from '../http';
import { logAudit } from '../lib/audit';
import { genId, nextDocNo } from '../lib/ids';
import { toLegacy } from '../lib/rows';
import { movementStmt } from '../lib/stock';
import { nowBkk, todayBkk } from '../lib/time';
import { registerRpc, type Ctx } from '../rpc';

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => String(v ?? '').trim();

class ValidationError extends Error {}

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
const MAX_ITEMS = 50;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Set by Task 7 (notifications). Called through ctx.exec.waitUntil; failures never reach the RPC result. */
export const notifyHooks: {
  onNewRequest?: (env: Env, req: Record<string, unknown>) => Promise<void>;
  onStatusChange?: (env: Env, req: Record<string, unknown>, newStatus: string, rejectReason: string) => Promise<void>;
} = {};

function runHook(ctx: Ctx, fn: () => Promise<void>): void {
  try {
    ctx.exec.waitUntil(fn().catch((err) => console.error('notify hook failed', err)));
  } catch (err) {
    console.error('notify hook failed', err);
  }
}

async function guarded(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message, 'VALIDATION');
    const msg = String((err as Error)?.message ?? err);
    if (/UNIQUE constraint/i.test(msg)) return fail('ข้อมูลซ้ำกับที่มีอยู่แล้วในระบบ');
    if (/CHECK constraint/i.test(msg)) return fail('ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบจำนวนและสถานะ', 'VALIDATION');
    if (/FOREIGN KEY constraint/i.test(msg)) return fail('ไม่พบข้อมูลที่อ้างอิง');
    console.error('requests rpc failed', err);
    return fail('เกิดข้อผิดพลาดในการบันทึกข้อมูล');
  }
}

/* ============================== STOCK ============================== */
export type Shortage = { Code: string; Name: string; StockQty: number; Qty: number };
export type ApplyResult = { ok: true } | { ok: false; shortages: Shortage[] };

interface ItemRow {
  material_id: string | null;
  qty: number;
  effective_qty?: number;
}

/**
 * Atomically (one db.batch) move a request's stock and run extraStmts. direction -1 deducts and
 * marks the request stock_applied=1 (and status APPROVED, required by the table CHECK); +1 returns
 * the stock and clears stock_applied. Guarded by a fresh stock_txn so repeats are no-ops.
 * A stock_qty CHECK failure rolls back the whole batch and is reported as shortages.
 */
export async function applyRequestStock(
  env: Env,
  requestId: string,
  direction: -1 | 1,
  actor: string,
  extraStmts: D1PreparedStatement[],
): Promise<ApplyResult> {
  const db = env.DB;
  const req = await db.prepare('SELECT doc_no FROM requests WHERE id = ?').bind(requestId).first<{ doc_no: string }>();
  const docNo = req?.doc_no ?? '';
  const { results: items } = await db
    .prepare('SELECT material_id, qty, COALESCE(approved_qty, qty) AS effective_qty FROM request_items WHERE request_id = ? AND material_id IS NOT NULL')
    .bind(requestId)
    .all<ItemRow>();
  const txn = crypto.randomUUID();
  const now = nowBkk();
  const from = direction === -1 ? 0 : 1;
  const to = direction === -1 ? 1 : 0;
  const note = direction === -1 ? 'ตัดสต็อกจากใบขอเบิก' : 'คืนสต็อกจากใบขอเบิก';
  const type = direction === -1 ? 'OUT' : 'IN';

  const stmts: D1PreparedStatement[] = [
    direction === -1
      ? db
          .prepare(
            "UPDATE requests SET stock_applied = ?, stock_txn = ?, status = 'APPROVED', updated_at = ? WHERE id = ? AND stock_applied = ?",
          )
          .bind(to, txn, now, requestId, from)
      : db
          .prepare('UPDATE requests SET stock_applied = ?, stock_txn = ?, updated_at = ? WHERE id = ? AND stock_applied = ?')
          .bind(to, txn, now, requestId, from),
  ];
  for (const it of items) {
    const effQty = Number(it.effective_qty ?? it.qty);
    if (effQty <= 0) continue;
    const materialId = it.material_id as string;
    stmts.push(
      movementStmt(db, {
        materialId,
        type,
        qty: effQty,
        refDoc: docNo,
        note,
        actor,
        guardRequestId: requestId,
        guardTxn: txn,
      }),
      db
        .prepare(
          'UPDATE materials SET stock_qty = stock_qty + (? * ?), updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM requests WHERE id = ? AND stock_txn = ?)',
        )
        .bind(direction, effQty, now, materialId, requestId, txn),
    );
  }

  if (direction === -1) {
    for (const it of items) {
      const effQty = Number(it.effective_qty ?? it.qty);
      if (effQty <= 0) continue;
      const materialId = it.material_id as string;
      const { results: lots } = await db
        .prepare(
          "SELECT id, unit_price, remaining_qty FROM material_lots WHERE material_id = ? AND status = 'ACTIVE' AND remaining_qty > 0 ORDER BY created_at ASC, rowid ASC",
        )
        .bind(materialId)
        .all<{ id: string; unit_price: number; remaining_qty: number }>();

      if (lots.length > 0) {
        let needed = effQty;
        let firstLotDepleted = false;
        let activePriceAfter: number | null = null;

        for (let i = 0; i < lots.length; i++) {
          const lot = lots[i];
          if (needed <= 0) {
            if (activePriceAfter === null) activePriceAfter = lot.unit_price;
            break;
          }
          if (lot.remaining_qty <= needed) {
            stmts.push(
              db.prepare("UPDATE material_lots SET remaining_qty = 0, status = 'DEPLETED' WHERE id = ?").bind(lot.id),
            );
            needed -= lot.remaining_qty;
            if (i === 0) firstLotDepleted = true;
          } else {
            stmts.push(
              db.prepare('UPDATE material_lots SET remaining_qty = remaining_qty - ? WHERE id = ?').bind(needed, lot.id),
            );
            activePriceAfter = lot.unit_price;
            needed = 0;
            break;
          }
        }

        if (firstLotDepleted) {
          const targetPrice = activePriceAfter !== null ? activePriceAfter : lots[lots.length - 1].unit_price;
          stmts.push(db.prepare('UPDATE materials SET unit_price = ? WHERE id = ?').bind(targetPrice, materialId));
        }
      }
    }
  } else {
    for (const it of items) {
      const effQty = Number(it.effective_qty ?? it.qty);
      if (effQty <= 0) continue;
      const materialId = it.material_id as string;
      const lastLot = await db
        .prepare('SELECT id FROM material_lots WHERE material_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
        .bind(materialId)
        .first<{ id: string }>();
      if (lastLot) {
        stmts.push(
          db
            .prepare("UPDATE material_lots SET remaining_qty = remaining_qty + ?, status = 'ACTIVE' WHERE id = ?")
            .bind(effQty, lastLot.id),
        );
      }
    }
  }
  stmts.push(...extraStmts);

  try {
    await db.batch(stmts);
    return { ok: true };
  } catch (err) {
    if (direction === -1 && /CHECK constraint failed:\s*stock_qty/i.test(String((err as Error)?.message ?? err))) {
      return { ok: false, shortages: await findShortages(db, items) };
    }
    throw err;
  }
}

async function findShortages(db: D1Database, items: ItemRow[]): Promise<Shortage[]> {
  const need = new Map<string, number>();
  for (const it of items) {
    const q = Number(it.effective_qty ?? it.qty);
    if (q > 0) need.set(it.material_id as string, (need.get(it.material_id as string) ?? 0) + q);
  }
  const out: Shortage[] = [];
  for (const [id, qty] of need) {
    const m = await db
      .prepare('SELECT code, name, stock_qty FROM materials WHERE id = ?')
      .bind(id)
      .first<{ code: string; name: string; stock_qty: number }>();
    if (m && m.stock_qty < qty) out.push({ Code: m.code, Name: m.name, StockQty: m.stock_qty, Qty: qty });
  }
  return out;
}

const shortageMessage = (s: Shortage[]): string =>
  s.length
    ? s.map((x) => `สต็อกไม่พอ: ${x.Code} ${x.Name} คงเหลือ ${x.StockQty} ขอ ${x.Qty}`).join('\n')
    : 'สต็อกไม่พอสำหรับใบขอเบิกนี้ กรุณาลองใหม่อีกครั้ง';

/* ============================== MAPPERS ============================== */
export function mapRequest(row: Obj): Obj {
  const r = toLegacy('requests', row);
  r.Status = String(r.Status || 'PENDING').toUpperCase();
  r.TotalAmount = Number(r.TotalAmount || 0);
  r.ItemCount = Number(r.ItemCount || 0);
  r.IsPartial = Number(row.is_partial || 0) === 1;
  return r;
}

const actorOf = (ctx: Ctx): string => ctx.session?.username ?? '';

/* ============================== CREATE ============================== */
registerRpc('apiCreateRequest', 'public', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    if (!ctx.session) {
      const { success } = await ctx.env.GUEST_LIMITER.limit({ key: ctx.ip });
      if (!success) return fail('ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'RATE_LIMIT');
    }
    const p = asObj(args[0]);
    const rawItems = Array.isArray(p.items) ? p.items : [];
    if (!rawItems.length) return fail('ไม่พบรายการพัสดุที่ถูกต้อง');
    if (rawItems.length > MAX_ITEMS) throw new ValidationError(`ขอเบิกได้ไม่เกิน ${MAX_ITEMS} รายการต่อใบ`);

    for (const k of ['attach', 'attachFile']) {
      if (asObj(p[k]).base64) {
        throw new ValidationError('ระบบยังไม่รองรับการแนบไฟล์ในใบขอเบิก กรุณาแนบเป็นลิงก์ (http/https)');
      }
    }
    if (p.AttachUrl !== undefined && p.AttachUrl !== null && typeof p.AttachUrl !== 'string') {
      throw new ValidationError('ไฟล์แนบต้องเป็นลิงก์ (http/https) หรือว่างเปล่า');
    }
    const attachUrl = str(p.AttachUrl);
    if (attachUrl && !/^https?:\/\/\S+$/i.test(attachUrl)) {
      throw new ValidationError('ไฟล์แนบต้องเป็นลิงก์ (http/https) หรือว่างเปล่า');
    }
    const requestDate = p.RequestDate ? str(p.RequestDate) : todayBkk();
    if (!DAY_RE.test(requestDate)) throw new ValidationError('รูปแบบวันที่ไม่ถูกต้อง');

    const wanted = rawItems.map((raw) => {
      const it = asObj(raw);
      const qty = typeof it.Qty === 'string' && it.Qty.trim() === '' ? NaN : Number(it.Qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new ValidationError('จำนวนที่ขอเบิกต้องเป็นตัวเลขที่มากกว่า 0');
      return { materialId: str(it.MaterialID), qty, remark: str(it.Remark) };
    });
    const ids = [...new Set(wanted.map((w) => w.materialId))];
    const { results: mats } = await db
      .prepare(
        `SELECT id, code, name, unit, unit_price, stock_qty FROM materials WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
      .bind(...ids)
      .all<{ id: string; code: string; name: string; unit: string; unit_price: number; stock_qty: number }>();
    const byId = new Map(mats.map((m) => [m.id, m]));

    const asked = new Map<string, number>();
    const items = wanted.map((w) => {
      const m = byId.get(w.materialId);
      if (!m) throw new ValidationError('ไม่พบรายการพัสดุที่ถูกต้อง');
      const sum = (asked.get(m.id) ?? 0) + w.qty;
      asked.set(m.id, sum);
      if (sum > m.stock_qty) {
        throw new ValidationError(`จำนวนที่ขอเบิก "${m.name}" เกินจำนวนคงเหลือในสต็อก (${m.stock_qty} ${m.unit})`);
      }
      return { m, qty: w.qty, remark: w.remark, totalPrice: w.qty * m.unit_price };
    });
    const total = items.reduce((s, i) => s + i.totalPrice, 0);

    const reqId = genId('R');
    const docNo = await nextDocNo(db);
    const now = nowBkk();
    const userId = ctx.session ? ctx.session.id : null;
    let fullName = str(p.FullName);
    let position = str(p.Position);
    let department = str(p.Department);
    const personnelCode = str(p.PersonnelCode);
    if (personnelCode) {
      const pRow = await db
        .prepare('SELECT full_name, position, department FROM personnel WHERE LOWER(code) = LOWER(?) AND active = 1')
        .bind(personnelCode)
        .first<{ full_name: string; position: string; department: string }>();
      if (!pRow) throw new ValidationError('ไม่พบรหัสบุคลากรนี้ในระบบ');
      fullName = pRow.full_name;
      position = pRow.position || position;
      department = pRow.department || department;
    }
    const purpose = str(p.Purpose);
    const note = str(p.Note);

    await db.batch([
      db
        .prepare(
          "INSERT INTO requests (id, doc_no, request_date, user_id, full_name, position, department, purpose, note, attach_url, status, reject_reason, approved_date, approved_by, total_amount, item_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', '', '', '', ?, ?, ?, ?)",
        )
        .bind(reqId, docNo, requestDate, userId, fullName, position, department, purpose, note, attachUrl, total, items.length, now, now),
      ...items.map((i) =>
        db
          .prepare(
            'INSERT INTO request_items (id, request_id, material_id, code, name, unit, qty, unit_price, total_price, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(genId('RI'), reqId, i.m.id, i.m.code, i.m.name, i.m.unit, i.qty, i.m.unit_price, i.totalPrice, i.remark),
      ),
      logAudit(db, { action: 'CREATE', entity: 'Request', entityId: reqId, detail: docNo, actor: str(p.actor) }),
    ]);

    const hook = notifyHooks.onNewRequest;
    if (hook) {
      const snapshot = {
        ID: reqId,
        DocNo: docNo,
        FullName: fullName,
        Position: position,
        Department: department,
        Purpose: purpose,
        Note: note,
        AttachUrl: attachUrl,
        RequestDate: requestDate,
        ItemCount: items.length,
        TotalAmount: total,
        Items: items.map((i) => ({
          MaterialID: i.m.id,
          Code: i.m.code,
          Name: i.m.name,
          Unit: i.m.unit,
          Qty: i.qty,
          UnitPrice: i.m.unit_price,
          TotalPrice: i.totalPrice,
          Remark: i.remark,
        })),
      };
      runHook(ctx, () => hook(ctx.env, snapshot));
    }
    return { ok: true, message: `บันทึกใบขอเบิกพัสดุเรียบร้อยแล้ว เลขที่ ${docNo}` };
  }),
);

/* ============================== READS ============================== */
/** Filtered request list (legacy apiGetRequests); shared with the CSV export. */
export async function listRequests(env: Env, filter: unknown): Promise<Obj[]> {
  const f = asObj(filter);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.status) {
    where.push('status = ?');
    binds.push(String(f.status).toUpperCase());
  }
  if (f.from) {
    where.push('request_date >= ?');
    binds.push(String(f.from));
  }
  if (f.to) {
    where.push('request_date <= ?');
    binds.push(String(f.to));
  }
  if (f.q) {
    const q = String(f.q).toLowerCase();
    where.push(
      '(instr(lower(doc_no), ?) > 0 OR instr(lower(full_name), ?) > 0 OR instr(lower(department), ?) > 0 OR instr(lower(purpose), ?) > 0)',
    );
    binds.push(q, q, q, q);
  }
  const sql = `SELECT * FROM requests${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, doc_no DESC`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all<Obj>();
  return results.map(mapRequest);
}

registerRpc('apiGetRequests', 'officer', async (ctx, args) => ({ ok: true, data: await listRequests(ctx.env, args[0]) }));

registerRpc('apiGetMyRequests', 'officer', async (ctx, args) => {
  const db = ctx.env.DB;
  const userId = str(args[0]);
  const { results } = await db
    .prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY created_at DESC, doc_no DESC')
    .bind(userId)
    .all<Obj>();
  const { results: items } = await db
    .prepare('SELECT i.* FROM request_items i JOIN requests r ON r.id = i.request_id WHERE r.user_id = ?')
    .bind(userId)
    .all<Obj>();
  const data = results.map((row) => {
    const r = mapRequest(row);
    r.Items = items
      .filter((it) => it.request_id === row.id)
      .map((it) => {
        const l = toLegacy('request_items', it);
        return {
          MaterialID: l.MaterialID,
          Code: l.Code,
          Name: l.Name,
          Unit: l.Unit,
          Qty: Number(l.Qty || 0),
          UnitPrice: Number(l.UnitPrice || 0),
          TotalPrice: Number(l.TotalPrice || 0),
          Remark: l.Remark,
        };
      });
    return r;
  });
  return { ok: true, data };
});

registerRpc('apiTrackRequest', 'public', async (ctx, args) => {
  const raw = args[0];
  if (!raw || !String(raw).trim()) return fail('กรุณาระบุเลขที่ใบขอเบิก หรือชื่อผู้ขอเบิก');
  const q = String(raw).trim().toLowerCase();
  const db = ctx.env.DB;
  const { results } = await db
    .prepare(
      'SELECT * FROM requests WHERE lower(doc_no) = ? OR lower(id) = ? OR instr(lower(full_name), ?) > 0 ORDER BY created_at DESC, doc_no DESC LIMIT 10',
    )
    .bind(q, q, q)
    .all<Obj>();
  if (!results.length) return fail(`ไม่พบข้อมูลใบขอเบิกที่ตรงกับคำค้นหา: ${raw}`);
  const data = [];
  for (const row of results) {
    const r = mapRequest(row);
    const { results: items } = await db.prepare('SELECT * FROM request_items WHERE request_id = ?').bind(row.id).all<Obj>();
    const myItems = items.map((it) => ({
      Name: it.name,
      Qty: Number(it.qty || 0),
      Unit: it.unit,
      Remark: it.remark || '',
    }));
    data.push({
      ID: r.ID,
      DocNo: r.DocNo,
      RequestDate: r.RequestDate,
      FullName: r.FullName,
      Department: r.Department,
      Purpose: r.Purpose,
      Status: r.Status,
      RejectReason: r.RejectReason || '',
      ApprovedDate: r.ApprovedDate || '',
      ApprovedBy: r.ApprovedBy || '',
      ItemCount: r.ItemCount || myItems.length,
      TotalAmount: r.TotalAmount || 0,
      Items: myItems,
    });
  }
  return { ok: true, data };
});

registerRpc('apiGetRequestForPrint', 'officer', async (ctx, args) => {
  const db = ctx.env.DB;
  const id = str(args[0]);
  const row = await db.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first<Obj>();
  if (!row) return fail('ไม่พบใบขอเบิกนี้');
  const { results } = await db.prepare('SELECT * FROM request_items WHERE request_id = ?').bind(id).all<Obj>();
  const items = results.map((it) => {
    const l = toLegacy('request_items', it);
    return {
      ID: str(it.id),
      Code: l.Code,
      Name: l.Name,
      Unit: l.Unit,
      Qty: Number(l.Qty || 0),
      UnitPrice: Number(l.UnitPrice || 0),
      TotalPrice: Number(l.TotalPrice || 0),
      ...(it.approved_qty !== null && it.approved_qty !== undefined ? { ApprovedQty: Number(it.approved_qty) } : {}),
    };
  });
  return { ok: true, data: { request: mapRequest(row), items, printedAt: nowBkk() } };
});

/* ============================== STATUS / DELETE ============================== */
interface StatusResult {
  ID: string;
  DocNo: string;
  ok: boolean;
  message: string;
  unchanged?: boolean;
  shortages?: Shortage[];
}

registerRpc('apiUpdateRequestStatus', 'officer', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const list = Array.isArray(args[0]) ? args[0] : args[0] ? [args[0]] : [];
    const results: StatusResult[] = [];
    for (const raw of list) {
      const item = asObj(raw);
      const id = str(item.ID);
      const actor = actorOf(ctx);
      const r = await db.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first<Obj & { doc_no: string; status: string }>();
      if (!r) {
        results.push({ ID: id, DocNo: '', ok: false, message: 'ไม่พบใบขอเบิกนี้' });
        continue;
      }
      const prev = String(r.status).toUpperCase();
      const next = String(item.Status ?? '').toUpperCase();
      const base = { ID: id, DocNo: r.doc_no };
      if (!(STATUSES as readonly string[]).includes(next)) {
        results.push({ ...base, ok: false, message: 'สถานะไม่ถูกต้อง' });
        continue;
      }
      if (prev === next) {
        results.push({ ...base, ok: true, unchanged: true, message: 'สถานะไม่เปลี่ยนแปลง' });
        continue;
      }
      const reason = next === 'REJECTED' ? str(item.RejectReason) : '';
      const now = nowBkk();
      const partialItems = Array.isArray(item.Items) ? item.Items : Array.isArray(item.items) ? item.items : null;
      let isPartial = 0;
      let approvedTotal = 0;
      let approvedCount = 0;

      if (next === 'APPROVED' && partialItems) {
        const { results: dbItems } = await db.prepare('SELECT id, code, qty, unit_price FROM request_items WHERE request_id = ?').bind(id).all<{ id: string; code: string; qty: number; unit_price: number }>();
        const mapReqItem = new Map(dbItems.map((x) => [x.id, x]));
        const mapReqCode = new Map(dbItems.map((x) => [x.code, x]));

        for (const pIt of partialItems) {
          const rawIt = asObj(pIt);
          const itId = str(rawIt.ID || rawIt.id);
          const itCode = str(rawIt.Code || rawIt.code);
          const orig = mapReqItem.get(itId) || mapReqCode.get(itCode);
          if (!orig) continue;
          let aQty = Number(rawIt.ApprovedQty ?? rawIt.approved_qty ?? orig.qty);
          if (isNaN(aQty) || aQty < 0) aQty = 0;
          if (aQty > orig.qty) aQty = orig.qty;
          if (aQty < orig.qty) isPartial = 1;
          if (aQty > 0) {
            approvedCount++;
            approvedTotal += aQty * orig.unit_price;
          }
          await db.prepare('UPDATE request_items SET approved_qty = ? WHERE id = ?').bind(aQty, orig.id).run();
        }
      }

      const extra = [
        db
          .prepare(
            next === 'APPROVED' && partialItems
              ? 'UPDATE requests SET status = ?, reject_reason = ?, approved_date = ?, approved_by = ?, is_partial = ?, total_amount = ?, item_count = ?, updated_at = ? WHERE id = ?'
              : 'UPDATE requests SET status = ?, reject_reason = ?, approved_date = ?, approved_by = ?, is_partial = ?, updated_at = ? WHERE id = ?',
          )
          .bind(
            ...(next === 'APPROVED' && partialItems
              ? [next, reason, now, actor, isPartial, approvedTotal, approvedCount, now, id]
              : [next, reason, now, actor, 0, now, id]),
          ),
        logAudit(db, { action: 'STATUS', entity: 'Request', entityId: id, detail: `${r.doc_no} → ${next}${isPartial ? ' (อนุมัติบางส่วน)' : ''}`, actor }),
        ...(next !== 'APPROVED' ? [db.prepare('UPDATE request_items SET approved_qty = NULL WHERE request_id = ?').bind(id)] : []),
      ];
      // Every non-approve move also goes through applyRequestStock(+1): it is a guarded no-op when
      // stock_applied=0, and returns stock if a concurrent approval slipped in after our read.
      const res = await applyRequestStock(ctx.env, id, next === 'APPROVED' ? -1 : 1, actor, extra);
      if (!res.ok) {
        results.push({ ...base, ok: false, message: shortageMessage(res.shortages), shortages: res.shortages });
        continue;
      }
      results.push({ ...base, ok: true, message: 'อัปเดตสถานะเรียบร้อยแล้ว' });
      const hook = notifyHooks.onStatusChange;
      if (hook) {
        const { results: finalItems } = await db.prepare('SELECT * FROM request_items WHERE request_id = ?').bind(id).all<Obj>();
        const mappedItems = finalItems.map((it) => {
          const l = toLegacy('request_items', it);
          return {
            ID: l.ID,
            Code: l.Code,
            Name: l.Name,
            Unit: l.Unit,
            Qty: Number(l.Qty || 0),
            ApprovedQty: it.approved_qty !== null && it.approved_qty !== undefined ? Number(it.approved_qty) : Number(l.Qty || 0),
            UnitPrice: Number(l.UnitPrice || 0),
            TotalPrice: Number(l.TotalPrice || 0),
          };
        });
        const mapped = {
          ...mapRequest(r),
          Status: next,
          IsPartial: isPartial === 1,
          TotalAmount: next === 'APPROVED' && partialItems ? approvedTotal : Number(r.total_amount || 0),
          ItemCount: next === 'APPROVED' && partialItems ? approvedCount : Number(r.item_count || 0),
          Items: mappedItems,
        };
        runHook(ctx, () => hook(ctx.env, mapped, next, reason));
      }
    }
    const failed = results.filter((x) => !x.ok);
    if (!failed.length) return { ok: true, message: 'อัปเดตสถานะใบขอเบิกเรียบร้อยแล้ว', results };
    const message =
      results.length === 1 ? failed[0].message : failed.map((x) => `${x.DocNo || x.ID}: ${x.message}`).join('\n');
    return { ok: false, message, results };
  }),
);

registerRpc('apiDeleteRequests', 'officer', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const actor = actorOf(ctx);
    const ids = Array.isArray(args[0]) ? args[0].map(str) : [];
    for (const id of ids) {
      const r = await db.prepare('SELECT doc_no FROM requests WHERE id = ?').bind(id).first<{ doc_no: string }>();
      if (!r) continue;
      // Always via applyRequestStock(+1): restores stock only if stock_applied=1, atomically with the delete.
      await applyRequestStock(ctx.env, id, 1, actor, [
        db.prepare('DELETE FROM requests WHERE id = ?').bind(id),
        logAudit(db, { action: 'DELETE', entity: 'Request', entityId: id, detail: r.doc_no, actor }),
      ]);
    }
    return { ok: true, message: 'ลบใบขอเบิกเรียบร้อยแล้ว' };
  }),
);
