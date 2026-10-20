// Negative schema checks: each statement must be rejected by a constraint on the local D1.
// Usage: node tests/run-negative.mjs   (after `npm run db:migrate:local`)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const now = "'2026-10-12 09:00:00'";
const cases = [
  ['negative stock_qty', `INSERT INTO materials (id, code, name, stock_qty, created_at, updated_at) VALUES ('M-NEG1', 'NEG-1', 'x', -1, ${now}, ${now})`],
  ['unknown request status', `INSERT INTO requests (id, doc_no, request_date, status, created_at, updated_at) VALUES ('R-NEG1', 'REQ-NEG-1', '2026-10-12', 'CANCELLED', ${now}, ${now})`],
  ['duplicate doc_no', `INSERT INTO requests (id, doc_no, request_date, created_at, updated_at) VALUES ('R-NEG2', 'REQ-NEG-2', '2026-10-12', ${now}, ${now}), ('R-NEG3', 'REQ-NEG-2', '2026-10-12', ${now}, ${now})`],
  ['stock_applied on PENDING', `INSERT INTO requests (id, doc_no, request_date, status, stock_applied, created_at, updated_at) VALUES ('R-NEG4', 'REQ-NEG-4', '2026-10-12', 'PENDING', 1, ${now}, ${now})`],
  ['unknown role', `INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('U-NEG1', 'neg', 'x', 'guest', ${now}, ${now})`],
  ['item for missing request', `INSERT INTO request_items (id, request_id, qty) VALUES ('RI-NEG1', 'R-MISSING', 1)`],
  ['second settings row', `INSERT INTO settings (id, updated_at) VALUES (2, ${now})`],
  ['duplicate opening balance', `INSERT INTO materials (id, code, name, created_at, updated_at) VALUES ('M-NEG2', 'NEG-2', 'x', ${now}, ${now}); INSERT INTO opening_balances (id, material_id, fiscal_year, created_at, updated_at) VALUES ('OB-N1', 'M-NEG2', 2569, ${now}, ${now}), ('OB-N2', 'M-NEG2', 2569, ${now}, ${now})`],
];

// Run wrangler's JS entry directly (no shell), so SQL quoting survives on Windows.
const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const d1 = (sql) => spawnSync(process.execPath, [wranglerBin,
  'd1', 'execute', 'DB', '--local', '--command', sql], { encoding: 'utf8' });

let failed = 0;
for (const [label, sql] of cases) {
  const r = d1(sql);
  const rejected = r.status !== 0 && /constraint|CHECK|UNIQUE|FOREIGN KEY/i.test(r.stdout + r.stderr);
  console.log(`${rejected ? 'PASS' : 'FAIL'}  ${label}`);
  if (!rejected) failed++;
}

// Clean up anything a non-atomic case may have left behind.
d1("DELETE FROM opening_balances WHERE material_id LIKE 'M-NEG%'; DELETE FROM materials WHERE id LIKE 'M-NEG%'; DELETE FROM requests WHERE id LIKE 'R-NEG%'");

process.exit(failed ? 1 : 0);
