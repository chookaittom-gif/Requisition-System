# AGENTS.md — ระบบเบิกจ่ายพัสดุ

## Purpose & Boundaries
คำแนะนำเฉพาะสำหรับโปรเจกต์ "ระบบเบิกจ่ายพัสดุ" (Google Apps Script / HTML / JS / Sheets)
ยึดหลักเกณฑ์และกระบวนการทำงานหลักตาม Global Rule (Senior GAS + UX Full-Stack)

## Project-Specific Rules
1. **Google Apps Script & Sheets:**
   - ตรวจสอบ `appsscript.json`, scopes, triggers และ spreadsheet access ก่อนแก้พฤติกรรม
   - ห้ามเปลี่ยนชื่อ Sheet, ลำดับคอลัมน์, หัวตาราง (Headers), รหัสระบุ (IDs) หรือ Date format เว้นแต่ได้รับอนุมัติ
   - ใช้ `LockService` ป้องกัน Concurrency ในการเขียนข้อมูลลง Sheets และต้องปล่อย Lock ในบล็อก `finally` เสมอ
   - โค้ดฝั่ง Client ต้องเรียก `google.script.run` โดยมีทั้ง `.withSuccessHandler()` และ `.withFailureHandler()` เสมอ

2. **UI & Interaction:**
   - Touch Target ขนาดไม่ต่ำกว่า 44px (เหมาะกับการใช้งานบนมือถือ)
   - ป้องกัน Horizontal Overflow ทุกหน้าจอ
   - มี Loading / Disabled State ป้องกัน Double Submit ในจุดที่ส่งคำร้อง/บันทึกข้อมูล และต้องคืนสถานะกลับเสมอเมื่อเสร็จสิ้นหรือเกิด Error

3. **Session Continuity & Handoff:**
   - หากต้องส่งต่องาน ให้บันทึกความคืบหน้าที่ `docs/HANDOFF.md` เสมอ

## Project Context
- **เทคโนโลยี:** Google Apps Script (HTMLService, SpreadsheetApp, LockService), JavaScript, CSS
- **ทางเข้าหลัก:** `Index.html`, โค้ดฝั่ง Server `.gs`
- **การ Deploy:** ทดสอบผ่าน Test Deployment / Clasp ก่อน Deploy Production เสมอ

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
