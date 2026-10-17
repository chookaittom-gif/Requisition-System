---
id: 1
title: "Dual-stack GAS and Cloudflare master-detail auto-fill pattern"
status: open
type: internal
skill: [gas-best-practices]
proposes_skill: []
target_file: []
siblings_checked: "none"
area: "architecture and schema sync"
date: 2026-10-17
session_context: "Adding Shops entity with auto-fill in Material Modal across GAS and Cloudflare D1"
parked_until: ""
resolved: ""
resolution: ""
reference: ""
commands_verified: "run: npm test (183 passed)"
---

**Issue:** In dual-stack web applications where both Google Apps Script (Spreadsheet as DB) and Cloudflare Workers (D1 SQLite as DB) coexist, introducing a new entity (such as Shops/Vendors) requires updating both schemas, data seeding, and API contracts in lockstep. Furthermore, `Code/index.html` and `cloudflare/public/index.html` must remain bit-for-bit identical to satisfy CI/test constraints.

**Suggested improvement:** Always write a D1 migration file alongside Google Apps Script `ensureSetup()` auto-table creation, create corresponding RPC handlers on both ends, and automatically mirror `Code/index.html` into `cloudflare/public/index.html`.

**Principle:** For dual-stack architectures, treat schema, seed migrations, and frontend assets as unified atomic pairs; never modify one runtime's contract without immediately mirroring it in the other.
