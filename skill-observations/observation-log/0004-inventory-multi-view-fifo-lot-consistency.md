---
id: 4
title: "Multi-view inventory calculations require unified lot-based remaining value and live stock alert alignment"
status: actioned
type: open-source
skill: [database, gas-best-practices]
proposes_skill: []
target_file: [AGENTS.md, cloudflare/src/api/reports.ts, cloudflare/src/api/materials.ts]
siblings_checked: "none"
area: "inventory FIFO lot accounting & multi-view synchronization"
date: 2026-10-28
session_context: "Syncing inventory value and low-stock indicators across dashboard, account, materials, and inventory report"
parked_until: ""
resolved: 2026-10-28
resolution: "Added lot-based RemainAmount to materials and inventory report, synchronized lowStock to live stock state, documented in AGENTS.md rule 4"
reference: ""
commands_verified: "npm test --prefix cloudflare (197 passed)"
---

**Issue:**
When introducing FIFO lot tracking (`material_lots`), independent views calculate remaining stock values differently: the dashboard and account views summed active lots, while the materials management view multiplied single master unit price by stock quantity, and the annual inventory report multiplied fiscal-year remaining quantity by master unit price. This caused three divergent totals (28,081 THB vs 27,831 THB vs 27,895 THB) and conflicting low-stock alert counts (10 vs 8).

**Suggested improvement:**
When implementing multi-lot or FIFO accounting, enforce a single source of truth across all read-side views. All summary cards and tables displaying total inventory value must aggregate from remaining lots (`material_lots`) when active lots exist. Low-stock alert counters must consistently reflect current live on-hand quantity (`stock_qty <= min_qty`) rather than period-specific balances unless explicitly filtered by historical date range.

**Principle:**
Multi-view aggregations of inventory value must share the same pricing valuation model (lot-based FIFO vs single unit price) across all overview, reporting, and management surfaces to avoid accounting discrepancies.
