// Reconciles material_lots with materials.stock_qty (AGENTS.md rule 4: lot totals are the source of value).
//
// Usage (run from cloudflare/):
//   node scripts/reconcile-lots.mjs --local            dry-run on the local D1  (default, writes nothing)
//   node scripts/reconcile-lots.mjs --remote           dry-run on production    (writes nothing)
//   node scripts/reconcile-lots.mjs --remote --apply   apply the printed plan
//
// BEFORE --apply: take a backup and keep the file.
//   npx wrangler d1 export ims_db --remote --output backup-before-reconcile.sql
// ROLLBACK: wipe the affected tables and re-import that file (npx wrangler d1 execute DB --remote --file backup-before-reconcile.sql --yes).
//
// Rule per material (only when sum(ACTIVE remaining) != stock_qty):
//   short  -> add the difference to the latest lot (or create a lot at the material price if none)
//   excess -> remove it from the latest lot first, then older ones
// It never touches stock_qty, purchases, movements or requests: stock is the truth, lots follow it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EPS = 1e-9;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** Pure planner: materials [{id, code, name, stock_qty, unit_price}], lots in creation order [{id, material_id, remaining_qty, unit_price, status}]. */
export function planReconcile(materials, lots) {
  const byMat = new Map();
  for (const l of lots) {
    if (!byMat.has(l.material_id)) byMat.set(l.material_id, []);
    byMat.get(l.material_id).push(l);
  }
  const plan = [];
  for (const m of materials) {
    const ml = byMat.get(m.id) ?? [];
    const live = ml.filter((l) => l.status === 'ACTIVE' && l.remaining_qty > 0);
    const lotTotal = sum(live.map((l) => Number(l.remaining_qty)));
    const stock = Number(m.stock_qty);
    const diff = stock - lotTotal;
    if (Math.abs(diff) < EPS) continue;
    const base = { materialId: m.id, code: m.code, stock, lotTotal, diff };
    if (diff > 0) {
      if (ml.length === 0) {
        plan.push({ ...base, action: 'CREATE_LOT', unitPrice: Number(m.unit_price) });
      } else {
        const last = ml[ml.length - 1];
        plan.push({ ...base, action: 'ADD_TO_LOT', lotId: last.id, newRemaining: Number(last.remaining_qty) + diff });
      }
    } else {
      let excess = -diff;
      const changes = [];
      for (let i = live.length - 1; i >= 0 && excess > EPS; i--) {
        const take = Math.min(Number(live[i].remaining_qty), excess);
        changes.push({ lotId: live[i].id, newRemaining: Number(live[i].remaining_qty) - take });
        excess -= take;
      }
      plan.push({ ...base, action: 'TRIM_LOTS', changes });
    }
  }
  return plan;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** SQL for a plan. Lot ids for created lots are derived from the material id so reruns are idempotent. */
export function planToSql(plan, now) {
  const out = [];
  for (const p of plan) {
    if (p.action === 'CREATE_LOT') {
      out.push(
        `INSERT OR IGNORE INTO material_lots (id, material_id, purchase_id, unit_price, initial_qty, remaining_qty, status, created_at) VALUES (${q('LOT-RECON-' + p.materialId)}, ${q(p.materialId)}, NULL, ${p.unitPrice}, ${p.stock}, ${p.stock}, 'ACTIVE', ${q(now)});`,
      );
    } else if (p.action === 'ADD_TO_LOT') {
      out.push(`UPDATE material_lots SET remaining_qty = ${p.newRemaining}, status = 'ACTIVE' WHERE id = ${q(p.lotId)};`);
    } else {
      for (const c of p.changes) {
        out.push(
          `UPDATE material_lots SET remaining_qty = ${c.newRemaining}, status = ${c.newRemaining > 0 ? "'ACTIVE'" : "'DEPLETED'"} WHERE id = ${q(c.lotId)};`,
        );
      }
    }
  }
  return out.join('\n');
}

function wrangler(args) {
  // Run wrangler's JS entry with node directly: no shell, so SQL arguments with spaces are passed intact on Windows too.
  return execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function query(target, sql) {
  const out = wrangler(['d1', 'execute', 'DB', target, '--json', '--command', sql]);
  return JSON.parse(out)[0].results;
}

function main(argv) {
  const remote = argv.includes('--remote');
  const apply = argv.includes('--apply');
  const target = remote ? '--remote' : '--local';

  const materials = query(target, 'SELECT id, code, name, stock_qty, unit_price FROM materials ORDER BY code');
  const lots = query(
    target,
    'SELECT id, material_id, remaining_qty, unit_price, status FROM material_lots ORDER BY material_id, created_at ASC, rowid ASC',
  );
  const plan = planReconcile(materials, lots);

  console.log(`${remote ? 'REMOTE' : 'LOCAL'} D1: ${materials.length} materials, ${lots.length} lots, ${plan.length} mismatch(es)`);
  for (const p of plan) {
    console.log(` - ${p.code}: stock ${p.stock} vs lots ${p.lotTotal} (${p.diff > 0 ? '+' : ''}${p.diff}) -> ${p.action}`);
  }
  if (plan.length === 0) return;
  if (!apply) {
    console.log('\nDry-run only. Nothing was written. Back up first, then re-run with --apply to apply this plan.');
    return;
  }

  const now = new Date(Date.now() + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  try {
    const file = join(dir, 'reconcile.sql');
    writeFileSync(file, planToSql(plan, now));
    wrangler(['d1', 'execute', 'DB', target, '--file', file, '--yes']);
    console.log('\nApplied. Re-run without --apply to confirm 0 mismatches.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
