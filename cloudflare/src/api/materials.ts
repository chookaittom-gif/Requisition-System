import { fail } from '../http';
import { logAudit } from '../lib/audit';
import { genId } from '../lib/ids';
import { computeStockState, toLegacy } from '../lib/rows';
import { movementStmt } from '../lib/stock';
import { currentFiscalYear, nowBkk, todayBkk } from '../lib/time';
import { registerRpc, type Ctx } from '../rpc';
import { ensureShopExists } from './shops';

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => String(v ?? '').trim();

class ValidationError extends Error {}
class UserError extends Error {}

function fiscalYearOfDate(dateStr?: string): number {
  if (dateStr && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    const y = Number(dateStr.slice(0, 4));
    const m = Number(dateStr.slice(5, 7));
    return y + 543 + (m >= 10 ? 1 : 0);
  }
  return currentFiscalYear();
}

const NUM_MSG = 'ตัวเลขต้องเป็นจำนวนที่ไม่ติดลบ';

/** Number(v || 0); NaN / negative -> VALIDATION. */
function num(v: unknown, label: string): number {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${label}${NUM_MSG}`);
  return n;
}

function urlField(v: unknown, label: string): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || !/^https?:\/\/\S+$/i.test(v.trim())) {
    throw new ValidationError(`${label}ต้องเป็นลิงก์ (http/https) หรือว่างเปล่า`);
  }
  return v.trim();
}

/** Run a mutating handler: Thai user errors and D1 constraint failures never leak raw SQLite text. */
async function guarded(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message, 'VALIDATION');
    if (err instanceof UserError) return fail(err.message);
    const msg = String((err as Error)?.message ?? err);
    if (/UNIQUE constraint/i.test(msg)) return fail('ข้อมูลซ้ำกับที่มีอยู่แล้วในระบบ');
    if (/CHECK constraint/i.test(msg)) return fail(`ข้อมูลไม่ถูกต้อง: ${NUM_MSG}`, 'VALIDATION');
    if (/FOREIGN KEY constraint/i.test(msg)) return fail('ไม่พบข้อมูลที่อ้างอิง');
    console.error('materials rpc failed', err);
    return fail('เกิดข้อผิดพลาดในการบันทึกข้อมูล');
  }
}

const actorOf = (ctx: Ctx): string => ctx.session?.username ?? '';

/* ============================== CATEGORIES ============================== */
const DEFAULT_CAT_CODES: Record<string, string> = {
  'หมวดงานเอกสารและกระดาษ': 'DOC',
  'หมวดเครื่องเขียนและอุปกรณ์ตัด': 'PEN',
  'หมวดอุปกรณ์ยึดติดและเทป': 'TAP',
  'หมวดอุปกรณ์ไอทีและวัสดุคอมพิวเตอร์': 'IT',
  'หมวดงานบ้านงานครัวสำนักงาน': 'HOM',
};

registerRpc('apiGetCategories', 'public', async (ctx) => {
  const { results } = await ctx.env.DB.prepare('SELECT * FROM categories').all<Obj>();
  const data = results
    .map((r) => {
      const c = toLegacy('categories', r);
      if (!c.Code && c.Name && DEFAULT_CAT_CODES[String(c.Name)]) {
        c.Code = DEFAULT_CAT_CODES[String(c.Name)];
      }
      return c;
    })
    .sort((a, b) => String(a.Name).localeCompare(String(b.Name), 'th'));
  return { ok: true, data };
});

registerRpc('apiSaveCategory', 'officer', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const p = asObj(args[0]);
    const actor = actorOf(ctx);
    const name = str(p.Name);
    if (!name) return fail('กรุณาระบุชื่อหมวดหมู่');
    const id = str(p.ID);
    if (p.action === 'delete') {
      await db.batch([
        db.prepare('DELETE FROM categories WHERE id = ?').bind(id),
        logAudit(db, { action: 'DELETE', entity: 'Category', entityId: id, detail: name, actor }),
      ]);
      return { ok: true, message: 'ลบหมวดหมู่เรียบร้อยแล้ว' };
    }

    const rawCode = str(p.Code || p.code).toUpperCase().trim();
    if (rawCode && !/^[A-Z0-9_-]{2,10}$/.test(rawCode)) {
      return fail('รหัสย่อหมวดหมู่ต้องเป็นตัวอักษรภาษาอังกฤษหรือตัวเลข 2-10 ตัวอักษร', 'VALIDATION');
    }

    const dupName = await db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').bind(name, id || '').first();
    if (dupName) return fail(`ชื่อหมวดหมู่ "${name}" มีอยู่แล้วในระบบ`);

    if (rawCode) {
      const dupCode = await db.prepare('SELECT id FROM categories WHERE UPPER(code) = ? AND id != ?').bind(rawCode, id || '').first();
      if (dupCode) return fail(`รหัสย่อหมวดหมู่ "${rawCode}" มีอยู่แล้วในระบบ`);
    }

    if (p.action === 'update') {
      const setCode = rawCode || null;
      await db.batch([
        db.prepare('UPDATE categories SET name = ?, code = COALESCE(?, code) WHERE id = ?').bind(name, setCode, id),
        logAudit(db, { action: 'UPDATE', entity: 'Category', entityId: id, detail: `${name} (${rawCode})`, actor }),
      ]);
    } else {
      const catCode = rawCode || null;
      await db.batch([
        db.prepare('INSERT INTO categories (id, name, code, created_at) VALUES (?, ?, ?, ?)').bind(genId('CAT'), name, catCode, nowBkk()),
        logAudit(db, { action: 'CREATE', entity: 'Category', entityId: '', detail: `${name} (${rawCode})`, actor }),
      ]);
    }
    return { ok: true, message: 'บันทึกหมวดหมู่เรียบร้อยแล้ว' };
  }),
);

/* ============================== MATERIALS ============================== */
export async function listMaterials(ctx: Ctx): Promise<Obj[]> {
  const db = ctx.env.DB;
  const { results } = await db.prepare('SELECT * FROM materials').all<Obj>();
  const { results: lots } = await db
    .prepare("SELECT material_id, unit_price, remaining_qty FROM material_lots WHERE status = 'ACTIVE' AND remaining_qty > 0 ORDER BY created_at ASC, rowid ASC")
    .all<{ material_id: string; unit_price: number; remaining_qty: number }>();
  const lotsByMat = new Map<string, { unit_price: number; remaining_qty: number }[]>();
  for (const l of lots) {
    const arr = lotsByMat.get(l.material_id) || [];
    arr.push(l);
    lotsByMat.set(l.material_id, arr);
  }

  return results
    .map((r) => {
      const m = toLegacy('materials', r);
      const stockQty = Number(m.StockQty || 0);
      const minQty = Number(m.MinQty || 0);
      const matLots = lotsByMat.get(String(r.id)) || [];
      const currentPrice = Number(m.UnitPrice || 0);
      const nextLot = matLots.find((l) => Number(l.unit_price) !== currentPrice);
      const nextLotPrice = nextLot ? Number(nextLot.unit_price) : null;
      const nextLotQty = nextLot
        ? matLots.filter((l) => Number(l.unit_price) === nextLotPrice).reduce((sum, l) => sum + Number(l.remaining_qty), 0)
        : null;
      const lotRemainAmount = matLots.reduce((sum, l) => sum + Number(l.remaining_qty) * Number(l.unit_price), 0);

      return {
        ID: m.ID,
        Code: m.Code,
        Name: m.Name,
        Unit: m.Unit,
        UnitPrice: currentPrice,
        StockQty: stockQty,
        MinQty: minQty,
        OpeningQty: Number(m.OpeningQty || 0),
        Category: m.Category || '',
        MaterialType: m.MaterialType || m.Category || '',
        SizeSpec: m.SizeSpec || '',
        StorageLocation: m.StorageLocation || '',
        ImageUrl: m.ImageUrl || '',
        FileUrl: m.FileUrl || '',
        ShopName: m.ShopName || '',
        ShopAddress: m.ShopAddress || '',
        ShopPhone: m.ShopPhone || '',
        ShopTaxId: m.ShopTaxId || '',
        BudgetSource: m.BudgetSource || 'งบประมาณแผ่นดิน',
        AcquiredDate: m.AcquiredDate || '',
        OrderQty: Number(m.OrderQty || 0),
        StockState: computeStockState(stockQty, minQty),
        NextLotPrice: nextLotPrice,
        NextLotQty: nextLotQty,
        RemainAmount: matLots.length > 0 && stockQty > 0 ? lotRemainAmount : stockQty * currentPrice,
      };
    })
    .sort((a, b) => String(a.Code).localeCompare(String(b.Code)));
}

registerRpc('apiGetMaterials', 'public', async (ctx) => ({ ok: true, data: await listMaterials(ctx) }));

registerRpc('apiGetLowStock', 'public', async (ctx) => ({
  ok: true,
  data: (await listMaterials(ctx)).filter((m) => m.StockState !== 'OK'),
}));

interface MatRow {
  id: string;
  code: string;
  stock_qty: number;
}

registerRpc('apiSaveMaterials', 'officer', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const list = args[0];
    if (!Array.isArray(list)) return fail('รูปแบบข้อมูลไม่ถูกต้อง', 'VALIDATION');
    const actor = actorOf(ctx);
    const { results } = await db.prepare('SELECT id, code, stock_qty FROM materials').all<MatRow>();
    const byId = new Map(results.map((r) => [r.id, { code: r.code, stock: r.stock_qty }]));
    const codeOwner = new Map(results.map((r) => [r.code, r.id]));
    const stmts: D1PreparedStatement[] = [];
    const now = nowBkk();

    for (const raw of list) {
      const item = asObj(raw);
      const id = str(item.ID);
      if (item.action === 'delete') {
        const cur = byId.get(id);
        stmts.push(
          db.prepare('DELETE FROM materials WHERE id = ?').bind(id),
          logAudit(db, { action: 'DELETE', entity: 'Material', entityId: id, detail: str(item.Code) || cur?.code || '', actor }),
        );
        if (cur) {
          byId.delete(id);
          if (codeOwner.get(cur.code) === id) codeOwner.delete(cur.code);
        }
        continue;
      }

      const code = str(item.Code);
      const owner = codeOwner.get(code);
      if (owner !== undefined && owner !== id) return fail(`รหัสพัสดุ "${code}" มีอยู่แล้วในระบบ`);

      const img = asObj(item.imageFile);
      const doc = asObj(item.docFile);
      if (img.base64 || doc.base64) {
        return fail('รูปแบบไฟล์แนบไม่ถูกต้อง ต้องอัปโหลดไฟล์แล้วส่งลิงก์', 'VALIDATION');
      }
      const imageUrl = urlField(item.ImageUrl, 'ลิงก์รูปภาพ');
      const fileUrl = urlField(item.FileUrl, 'ลิงก์ไฟล์แนบ');
      const name = str(item.Name);
      const unit = str(item.Unit);
      const unitPrice = num(item.UnitPrice, 'ราคาต่อหน่วย');
      const newStock = num(item.StockQty, 'จำนวนคงเหลือ');
      const minQty = num(item.MinQty, 'จำนวนขั้นต่ำ');
      const category = str(item.Category);
      const materialType = str(item.MaterialType || item.Category);
      const sizeSpec = str(item.SizeSpec);
      const storageLoc = str(item.StorageLocation);
      const shopName = str(item.ShopName);
      const shopAddress = str(item.ShopAddress);
      const shopPhone = str(item.ShopPhone);
      const shopTaxId = str(item.ShopTaxId);
      const budgetSource = str(item.BudgetSource || 'งบประมาณแผ่นดิน');
      const acquiredDate = str(item.AcquiredDate);
      const orderQty = num(item.OrderQty || 0, 'จำนวนที่สั่งซื้อ');
      const openingSent = item.OpeningQty !== undefined && item.OpeningQty !== null && item.OpeningQty !== '';
      const openingQtyVal = openingSent ? num(item.OpeningQty, 'ยอดยกมา') : null;

      if (item.action === 'update') {
        const cur = byId.get(id);
        if (!cur) return fail('ไม่พบข้อมูลพัสดุที่ต้องการแก้ไข');
        const stockSent = item.StockQty !== undefined && item.StockQty !== null;
        // Movement first: its SELECT must read the pre-update stock; it is skipped in SQL when unchanged.
        if (stockSent) {
          stmts.push(
            movementStmt(db, {
              materialId: id,
              type: 'ADJUST',
              qty: newStock,
              refDoc: '',
              note: 'ปรับยอดจากฟอร์มแก้ไข',
              actor,
            }),
          );
        }
        stmts.push(
          db
            .prepare(
              'UPDATE materials SET code = ?, name = ?, unit = ?, unit_price = ?, stock_qty = COALESCE(?, stock_qty), min_qty = ?, opening_qty = COALESCE(?, opening_qty), category = ?, material_type = ?, size_spec = ?, storage_location = ?, image_url = ?, file_url = ?, shop_name = ?, shop_address = ?, shop_phone = ?, shop_tax_id = ?, budget_source = ?, acquired_date = ?, order_qty = ?, updated_at = ? WHERE id = ?',
            )
            .bind(code, name, unit, unitPrice, stockSent ? newStock : null, minQty, openingQtyVal, category, materialType, sizeSpec, storageLoc, imageUrl, fileUrl, shopName, shopAddress, shopPhone, shopTaxId, budgetSource, acquiredDate, orderQty, now, id),
          logAudit(db, { action: 'UPDATE', entity: 'Material', entityId: id, detail: code, actor }),
        );
        if (openingSent && openingQtyVal !== null) {
          const fy = fiscalYearOfDate(acquiredDate);
          stmts.push(
            db
              .prepare(
                'INSERT INTO opening_balances (id, material_id, fiscal_year, opening_qty, set_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(material_id, fiscal_year) DO UPDATE SET opening_qty = excluded.opening_qty, set_by = excluded.set_by, updated_at = excluded.updated_at',
              )
              .bind(genId('OB'), id, fy, openingQtyVal, actor, now, now),
          );
        }
        if (cur.code !== code) {
          if (codeOwner.get(cur.code) === id) codeOwner.delete(cur.code);
          cur.code = code;
        }
        if (stockSent) cur.stock = newStock;
        codeOwner.set(code, id);
      } else {
        const newId = genId('M');
        const initialOrderQty = orderQty > 0 ? orderQty : 0;
        const openingQty = openingSent && openingQtyVal !== null ? openingQtyVal : Math.max(0, newStock - initialOrderQty);
        stmts.push(
          db
            .prepare(
              'INSERT INTO materials (id, code, name, unit, unit_price, stock_qty, min_qty, opening_qty, category, material_type, size_spec, storage_location, image_url, file_url, shop_name, shop_address, shop_phone, shop_tax_id, budget_source, acquired_date, order_qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(newId, code, name, unit, unitPrice, newStock, minQty, openingQty, category, materialType, sizeSpec, storageLoc, imageUrl, fileUrl, shopName, shopAddress, shopPhone, shopTaxId, budgetSource, acquiredDate, orderQty, now, now),
        );
        if (openingSent && openingQtyVal !== null) {
          const fy = fiscalYearOfDate(acquiredDate);
          stmts.push(
            db
              .prepare(
                'INSERT INTO opening_balances (id, material_id, fiscal_year, opening_qty, set_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(material_id, fiscal_year) DO UPDATE SET opening_qty = excluded.opening_qty, set_by = excluded.set_by, updated_at = excluded.updated_at',
              )
              .bind(genId('OB'), newId, fy, openingQty, actor, now, now),
          );
        }
        if (newStock > 0) {
          if (initialOrderQty > 0) {
            stmts.push(
              db
                .prepare(
                  "INSERT INTO stock_movements (id, material_id, code, name, type, qty, before_qty, after_qty, ref_doc, note, actor, created_at) VALUES (?, ?, ?, ?, 'IN', ?, ?, ?, '', 'จัดซื้อ', ?, ?)",
                )
                .bind(genId('SM'), newId, code, name, initialOrderQty, openingQty, newStock, actor, now),
            );
          }
          stmts.push(
            db
              .prepare(
                'INSERT INTO material_lots (id, material_id, purchase_id, unit_price, initial_qty, remaining_qty, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              )
              .bind(genId('LOT'), newId, null, unitPrice, newStock, newStock, 'ACTIVE', now),
          );
        }
        if (initialOrderQty > 0) {
          stmts.push(
            db
              .prepare(
                'INSERT INTO purchases (id, material_id, code, name, qty, unit_price, amount, purchase_date, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              )
              .bind(genId('P'), newId, code, name, initialOrderQty, unitPrice, initialOrderQty * unitPrice, acquiredDate || todayBkk(), 'จัดซื้อรับเข้า (สร้างพัสดุ)', actor, now),
          );
        }
        stmts.push(logAudit(db, { action: 'CREATE', entity: 'Material', entityId: newId, detail: code, actor }));
        byId.set(newId, { code, stock: newStock });
        codeOwner.set(code, newId);
      }
    }

    if (stmts.length) await db.batch(stmts);

    for (const raw of list) {
      const item = asObj(raw);
      if (item.action === 'delete') continue;
      const sName = str(item.ShopName);
      if (sName) {
        await ensureShopExists(db, {
          name: sName,
          taxId: str(item.ShopTaxId),
          address: str(item.ShopAddress),
          phone: str(item.ShopPhone),
          actor,
        });
      }
    }

    return { ok: true, message: 'บันทึกข้อมูลพัสดุเรียบร้อยแล้ว' };
  }),
);

registerRpc('apiDeleteMaterials', 'officer', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const actor = actorOf(ctx);
    const ids = Array.isArray(args[0]) ? args[0].map((x) => str(x)) : [];
    const stmts: D1PreparedStatement[] = [];
    for (const id of ids) {
      stmts.push(
        db.prepare('DELETE FROM materials WHERE id = ?').bind(id),
        logAudit(db, { action: 'DELETE', entity: 'Material', entityId: id, detail: '', actor }),
      );
    }
    if (stmts.length) await db.batch(stmts);
    return { ok: true, message: 'ลบข้อมูลพัสดุเรียบร้อยแล้ว' };
  }),
);

registerRpc('apiPurchaseMaterials', 'officer', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const list = args[0];
    if (!Array.isArray(list)) return fail('รูปแบบข้อมูลไม่ถูกต้อง', 'VALIDATION');
    const actor = actorOf(ctx);
    const { results } = await db.prepare('SELECT id, code, name, unit_price, stock_qty FROM materials').all<Obj>();
    const byId = new Map(results.map((r) => [String(r.id), r]));
    const stmts: D1PreparedStatement[] = [];
    const now = nowBkk();

    for (const raw of list) {
      const item = asObj(raw);
      const m = byId.get(str(item.MaterialID));
      if (!m) continue;
      const qty = num(item.Qty, 'จำนวนที่จัดซื้อ');
      if (!(qty > 0)) continue;
      const purchaseDate = str(item.PurchaseDate) || todayBkk();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw new ValidationError('รูปแบบวันที่จัดซื้อไม่ถูกต้อง');
      const inputPrice = item.UnitPrice !== undefined && item.UnitPrice !== null && item.UnitPrice !== '' ? Number(item.UnitPrice) : null;
      const unitPrice = inputPrice !== null && !isNaN(inputPrice) && inputPrice >= 0 ? inputPrice : Number(m.unit_price || 0);
      const note = String(item.Note ?? '');
      const id = String(m.id);
      const code = String(m.code);
      const purchaseId = genId('P');
      const auditDetail = unitPrice !== Number(m.unit_price || 0) ? `${code} +${qty} @ ${unitPrice}` : `${code} +${qty}`;
      stmts.push(
        db
          .prepare(
            'INSERT INTO purchases (id, material_id, code, name, qty, unit_price, amount, purchase_date, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(purchaseId, id, code, String(m.name), qty, unitPrice, qty * unitPrice, purchaseDate, note, actor, now),
        db
          .prepare(
            'INSERT INTO material_lots (id, material_id, purchase_id, unit_price, initial_qty, remaining_qty, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(genId('LOT'), id, purchaseId, unitPrice, qty, qty, 'ACTIVE', now),
        movementStmt(db, { materialId: id, type: 'IN', qty, refDoc: '', note: note || 'จัดซื้อเพิ่ม', actor }),
        db.prepare('UPDATE materials SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ?').bind(qty, now, id),
        logAudit(db, { action: 'PURCHASE', entity: 'Material', entityId: id, detail: auditDetail, actor }),
      );
      if (Number(m.stock_qty || 0) === 0) {
        stmts.push(db.prepare('UPDATE materials SET unit_price = ? WHERE id = ?').bind(unitPrice, id));
      }
    }

    if (stmts.length) await db.batch(stmts);
    return { ok: true, message: 'บันทึกการจัดซื้อพัสดุเรียบร้อยแล้ว' };
  }),
);

/* ============================== OPENING BALANCES ============================== */
registerRpc('apiSaveOpeningBalance', 'officer', (ctx, args) =>
  guarded(async () => {
    const db = ctx.env.DB;
    const p = asObj(args[0]);
    const actor = actorOf(ctx);
    const materialId = str(p.MaterialID);
    const fiscalYearText = str(p.FiscalYear);
    if (!materialId || !fiscalYearText) return fail('กรุณาระบุรหัสพัสดุและปีงบประมาณ');
    const fiscalYear = Number(fiscalYearText);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2500 || fiscalYear > 2700) {
      throw new ValidationError('ปีงบประมาณไม่ถูกต้อง');
    }
    const openingQty = num(p.OpeningQty, 'ยอดยกมา');
    const exists = await db.prepare('SELECT 1 AS x FROM materials WHERE id = ?').bind(materialId).first();
    if (!exists) throw new UserError('ไม่พบพัสดุที่ระบุ');
    const now = nowBkk();
    const { results: moves } = await db
      .prepare('SELECT type, qty, after_qty FROM stock_movements WHERE material_id = ? ORDER BY created_at ASC, rowid ASC')
      .bind(materialId)
      .all<{ type: string; qty: number; after_qty: number }>();

    let calcStock = openingQty;
    for (const m of moves) {
      const q = Number(m.qty || 0);
      if (m.type === 'IN') calcStock += q;
      else if (m.type === 'OUT') calcStock -= q;
      else if (m.type === 'ADJUST') calcStock = Number(m.after_qty || 0);
    }

    await db.batch([
      db
        .prepare(
          'INSERT INTO opening_balances (id, material_id, fiscal_year, opening_qty, set_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(material_id, fiscal_year) DO UPDATE SET opening_qty = excluded.opening_qty, set_by = excluded.set_by, updated_at = excluded.updated_at',
        )
        .bind(genId('OB'), materialId, fiscalYear, openingQty, actor, now, now),
      db
        .prepare('UPDATE materials SET stock_qty = ?, opening_qty = ?, updated_at = ? WHERE id = ?')
        .bind(Math.max(0, calcStock), openingQty, now, materialId),
      logAudit(db, {
        action: 'UPDATE',
        entity: 'OpeningBalance',
        entityId: materialId,
        detail: `ยกยอดปี ${fiscalYear} = ${openingQty}`,
        actor,
      }),
    ]);
    return { ok: true, message: 'บันทึกยอดยกมาเรียบร้อยแล้ว' };
  }),
);
