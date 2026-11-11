// Removes two known test purchases whose material was already deleted (material_id IS NULL).
// They own no lot and no stock, so deleting them changes no inventory value or stock level.
//
// Usage (run from cloudflare/):
//   node scripts/cleanup-test-purchases.mjs --remote            dry-run on production (default, writes nothing)
//   node scripts/cleanup-test-purchases.mjs --remote --apply    delete the listed rows
//
// BEFORE --apply: take a backup and keep the file.
//   npx wrangler d1 export ims_db --remote --output backup-before-cleanup-purchases.sql
// ROLLBACK: re-insert the rows printed by the dry-run (or re-import the backup file).
//
// Safety: only the explicit ids below are eligible, and each DELETE re-checks material_id IS NULL and that no lot points at it.
import { execFileSync } from 'node:child_process';

const TARGET_IDS = ['P-61A10492', 'P-B79526DF'];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function wrangler(args) {
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
  const idList = TARGET_IDS.map(q).join(', ');

  const rows = query(
    target,
    `SELECT p.id, p.name, p.qty, p.unit_price, p.amount, p.purchase_date, p.actor, p.material_id,
            (SELECT COUNT(*) FROM material_lots l WHERE l.purchase_id = p.id) AS lots
     FROM purchases p WHERE p.id IN (${idList}) ORDER BY p.purchase_date`,
  );
  console.log(`${remote ? 'REMOTE' : 'LOCAL'} D1: ${rows.length}/${TARGET_IDS.length} target purchase(s) found`);
  for (const r of rows) {
    const ok = r.material_id === null && Number(r.lots) === 0;
    console.log(` - ${r.id} ${r.purchase_date} "${r.name}" qty ${r.qty} @${r.unit_price} = ${r.amount} by ${r.actor} -> ${ok ? 'eligible' : 'SKIP (has material or lot)'}`);
  }
  const eligible = rows.filter((r) => r.material_id === null && Number(r.lots) === 0);
  if (eligible.length === 0) return;
  if (!apply) {
    console.log('\nDry-run only. Nothing was written. Back up first, then re-run with --apply to delete the eligible rows.');
    return;
  }
  const ids = eligible.map((r) => q(r.id)).join(', ');
  wrangler([
    'd1', 'execute', 'DB', target, '--yes', '--command',
    `DELETE FROM purchases WHERE id IN (${ids}) AND material_id IS NULL AND NOT EXISTS (SELECT 1 FROM material_lots l WHERE l.purchase_id = purchases.id)`,
  ]);
  console.log('\nApplied. Re-run without --apply to confirm 0 rows remain.');
}

main(process.argv.slice(2));
