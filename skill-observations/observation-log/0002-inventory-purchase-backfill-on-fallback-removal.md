---
id: 2
title: "Fiscal year inventory reports require purchase row backfilling when removing synthetic order fallbacks"
status: open
type: internal
skill: [database, gas-best-practices]
proposes_skill: []
target_file: ["cloudflare/src/api/reports.ts", "cloudflare/src/api/materials.ts"]
siblings_checked: "none"
area: "data integrity & accounting reconciliations"
date: 2026-10-19
session_context: "Reconciling opening balances vs purchases receipts in Cloudflare Workers and D1 database"
parked_until: ""
resolved: ""
resolution: ""
reference: ""
commands_verified: "run: npm test (190 passed), npx wrangler d1 execute ims_db --remote"
---

**Issue:** In inventory tracking systems with fiscal year boundaries, removing a self-healing fallback (e.g. deriving `PurchaseQty` from `materials.order_qty` when `purchases` rows are missing) without backfilling the underlying relational table causes legacy items to shift into `OpeningQty` (ยอดยกมา) instead of `PurchaseQty` (จำนวนรับ/ซื้อ), causing discrepancies between inventory ledger views and purchase account views.

**Suggested improvement:** When changing calculation models from synthetic fallbacks to strict relational queries (`purchases` table joins), always inspect and backfill historical records into the transaction table before removing the fallback, ensuring opening stock balances and purchase receipts remain semantically distinct.

**Principle:** Never enforce strict relational constraints or remove synthetic fallback calculations without an explicit historical data migration for preexisting records.
