# Material Search Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เพิ่มช่องค้นหาพัสดุ (ชื่อ/รหัส) กรอง dropdown แบบ realtime ในฟอร์มขอเบิกใหม่และ Modal แก้ไขใบขอเบิก

**Architecture:** เก็บ native `<select>` เดิม เพิ่ม text input ค้นหาเหนือ select + helper `filterMats(mats, q)` กรองตาม `Name`/`Code` case-insensitive แล้ว re-render options ผ่าน `renderGroupedMaterialOptions` เดิม (คง optgroup, ก-ฮ, ซ่อนหมดสต็อก)

**Tech Stack:** Vanilla JS + Tailwind classes เดิม, Vitest static/execution tests

**Spec:** `docs/superpowers/specs/2026-11-07-material-search-combobox-design.md`

## Global Constraints

- Touch target ขั้นต่ำ 44px ทุก input ใหม่ (AGENTS.md Rule 2)
- ห้าม Horizontal Overflow; ไม่เปลี่ยน Sheet/headers/schema
- ไม่เพิ่ม dependency ใหม่; แก้เฉพาะ `cloudflare/public/index.html` + `cloudflare/test/node/frontend.test.ts`
- ห้ามลบ comment เดิมที่ไม่เกี่ยวข้อง
- เสร็จและเทสผ่าน 100% → Rule 7: HANDOFF → Conventional Commit → push origin main → ตรวจ deploy

## Review Focus

- ค่าที่เลือกไว้หายเมื่อพิมพ์ค้นหา → ต้อง restore selection ถ้ายังตรง filter (test: Task 1 Step 1)
- พิมพ์ค้นหาแล้ว optgroup/การเรียง ก-ฮ เพี้ยน → re-render ต้องผ่าน `renderGroupedMaterialOptions` เสมอ (test: Task 1 Step 1)
- ช่องค้นหาใน Modal แก้ไขกรองรายการที่เคยเลือกไว้ออก (onlyInStock:false ต้องคงรายการเดิม) → `selectedCode` path ต้องผ่าน filter (test: Task 2 Step 1)
- filter ไม่ trim/case-insensitive ทำให้ค้นไม่เจอ → test filterMats ตรง ๆ (test: Task 1 Step 1)
- Draft auto-save (30 นาที) จับค่า select เดิมหลัง re-render ผิด → wiring ต้องคง `data-sel` id และ listener เดิม

---

### Task 1: filterMats helper + ช่องค้นหาใน addItemRow

**Files:**
- Modify: `cloudflare/public/index.html` (helper ใกล้ `renderGroupedMaterialOptions` L1211; `addItemRow` L9147)
- Test: `cloudflare/test/node/frontend.test.ts`

**Interfaces:**
- Produces: `filterMats(mats: Array<{ID, Code, Name, ...}>, q: string) -> filtered array` (ใช้ซ้ำ Task 2); ช่องค้นหา attribute `data-mq="<i>"` คู่กับ `data-sel="<i>"`

- [ ] **Step 1: Write the failing test** — เพิ่มใน describe `public/index.html static checks`:
  - extract ซอร์ส `function filterMats...` จาก `html` ด้วย regex แล้ว `new Function` รัน: กรองได้ตาม Name (กรณีตัวพิมพ์ผสม), ตาม Code, q เว้นว่าง → คืน input เดิม, ไม่ trim → ไม่เจอ
  - static assertions: `html` มี `function filterMats`, มี `data-mq="${i}"`, `addItemRow` มี input ค้นหา placeholder `ค้นหาพัสดุ (ชื่อหรือรหัส)` และ re-render ผ่าน `renderGroupedMaterialOptions(filterMats(`
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run test/node/frontend.test.ts` ใน `cloudflare/` → FAIL
- [ ] **Step 3: Implement** — เพิ่ม `filterMats` เหนือ `renderGroupedMaterialOptions`; ใน `addItemRow` เพิ่ม input `data-mq` (min-h-[44px], class เดิม rounded-2xl/border-slate-200) + listener input: re-render `sel.innerHTML = renderGroupedMaterialOptions(filterMats(mats, q), sel.value, { onlyInStock: true })` คง selection ถ้ายังอยู่ในผลลัพธ์
- [ ] **Step 4: Run test to verify it passes** — คำสั่งเดิม → PASS
- [ ] **Step 5: Commit** — `git add` 2 ไฟล์, `git commit -m "feat(requisition): add realtime material search filter in request form"`

### Task 2: ช่องค้นหาใน openEditReqModal + เทสรวม + Delivery pipeline

**Files:**
- Modify: `cloudflare/public/index.html` (`openEditReqModal` รอบ L3531)
- Modify: `docs/HANDOFF.md`
- Test: `cloudflare/test/node/frontend.test.ts`

**Interfaces:**
- Consumes: `filterMats` (Task 1), `renderGroupedMaterialOptions(mats, selectedId, { onlyInStock:false, includeCodeInLabel:true, selectedCode })`

- [ ] **Step 1: Write the failing test** — static assertions: `openEditReqModal` เรียก `renderGroupedMaterialOptions(filterMats(activeMats, ..., { onlyInStock: false` path และมีช่องค้นหาของตัวเอง (`data-eqsearch`), คง `includeCodeInLabel`/`selectedCode` เดิม
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run test/node/frontend.test.ts` → FAIL
- [ ] **Step 3: Implement** — ใน `openEditReqModal` เพิ่ม input ค้นหาเหนือ select รายการพัสดุ ใช้ `filterMats(activeMats, q)` ต่อ `renderGroupedMaterialOptions(..., { onlyInStock: false, includeCodeInLabel: true, selectedCode })` คง selection เดิม
- [ ] **Step 4: Run full suite** — `npm test` ใน `cloudflare/` → ผ่าน 100% + `tsc --noEmit` 0 errors
- [ ] **Step 5: Update HANDOFF + Commit** — เพิ่มหัวข้อ session ใหม่ใน `docs/HANDOFF.md`; commit `feat(requisition): add material search filter to edit request modal`
- [ ] **Step 6: Push + Deploy check** — `git push origin main`, ตรวจ GitHub Actions deploy ผ่าน; `graft build` refresh graph
