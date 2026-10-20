# Cloudflare Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GAS + Sheets backend of ระบบเบิกจ่ายพัสดุ with one Cloudflare Worker on D1 `ims_db`, keeping `index.html` and every legacy feature, with Drive kept only for files.

**Architecture:** A TypeScript Worker serves `public/index.html` as a static asset and exposes `POST /api/rpc/:fn`, an allowlisted RPC that returns the same JSON shapes as the GAS functions, so the frontend only swaps its transport. Data lives in D1 (schema in `cloudflare/migrations/`); stock changes run as one D1 `batch()` (atomic) guarded by `requests.stock_applied`. Uploads go browser → Drive resumable session created by the Worker.

**Tech Stack:** Cloudflare Workers + Static Assets, D1, Workers Rate Limiting binding, Cron Triggers, TypeScript, Vitest + `@cloudflare/vitest-pool-workers`, Google Drive API v3 (OAuth refresh token), SheetJS (browser, cdnjs `xlsx/0.18.5`).

**Spec:** `docs/superpowers/specs/2026-10-12-cloudflare-migration-design.md`. Legacy behavior reference: `cloudflare/docs/feature-inventory.md`, `cloudflare/docs/data-mapping.md`, and the GAS source `Code/code.gs`.

## Global Constraints
- All new code lives under `cloudflare/`. Never modify `Code/` (the GAS source stays as the reference and backup).
- Every RPC returns the legacy shape of the GAS function it replaces: same keys (PascalCase), `{ ok: false, message }` on failure, `code: 'AUTH'` when the session is missing/expired, `code: 'FORBIDDEN'` on role failure. Error messages stay in Thai, copied from `code.gs` where one exists.
- Role ranks: `admin: 2`, `officer: 1`, `staff: 1`. Function access levels exactly as `FN_ACCESS` (`Code/code.gs:66-85`), minus `apiRunSchemaMigration` and `apiExportInventoryReportSheet`.
- Actor is always the session username; any `actor`, `ID` (profile), `UserID` sent by the client is overwritten as `dispatch_` does (`Code/code.gs:116-131`). Guest requests store `user_id = NULL`, actor = `FullName` or `'ผู้ขอเบิก (บุคคลทั่วไป)'`.
- Times: Asia/Bangkok (UTC+7, no DST). Stored as `YYYY-MM-DD HH:MM:SS`; day fields as `YYYY-MM-DD`.
- Session: cookie `ims_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`, 8 h absolute (28,800 s). Token = 32 random bytes base64url; D1 stores only its SHA-256 hex.
- Passwords: verify `sha256$` = `'sha256$' + hex(SHA-256(PW_SALT + '|' + pw))`; plaintext legacy values compare directly; new hashes `pbkdf2$100000$<salt b64>$<hash b64>` (PBKDF2-SHA256, 32-byte key). Constant-time comparison. Rehash to PBKDF2 after any successful non-PBKDF2 login.
- Secrets (never in git or frontend): `PW_SALT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. Vars: `DRIVE_ROOT_FOLDER_ID = "1kVDobdN0V1U7bqTHHFMEDrlUEhQAMG4U"`.
- `settings.telegram_bot_token` is never sent to the browser in full: return `'••••' + last 4 chars` (empty string if unset); a save with an empty or masked value keeps the stored token.
- Uploads: max 25 MB (26,214,400 bytes); MIME allowlist `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Chunk size 5 MiB (5,242,880). Drive subfolders: `Logo`, `Banner`, `MaterialImages`, `MaterialFiles`, `RequestAttachments`. Sharing `anyone`/`reader`. Image URL `https://lh3.googleusercontent.com/d/<id>`, other files `https://drive.google.com/file/d/<id>/view`.
- Guest `apiCreateRequest` rate limit: 10 per 60 s per `CF-Connecting-IP`.
- No email sending. Telegram only (`sendMessage`, `parse_mode: 'HTML'`, `disable_web_page_preview: true`).
- No `--remote` command and no `wrangler deploy` without explicit owner approval at that moment.
- Commit only files under `cloudflare/` and `docs/superpowers/`. Never commit `.dev.vars` or `cloudflare/seeds/`.

## Review Focus
1. **Two officers approve two requests for the same last units at the same moment:** exactly one succeeds; stock never goes negative; the other gets the shortage message. Test in Task 5.
2. **Fiscal-year boundary on 30 Sep / 1 Oct between 00:00 and 07:00 Bangkok (still the previous day in UTC):** the new fiscal year is used. Test in Task 2.
3. **Approve → reject → approve the same request:** stock goes down, up, down exactly once each, with matching IN/OUT movements. Test in Task 5.
4. **Session expires (8 h) while the user is on a page:** the next RPC returns `code: 'AUTH'` and the existing `forceLogout_()` flow runs. Test in Task 3.
5. **CSV export opened in Excel shows Thai correctly:** content starts with the UTF-8 BOM `﻿`. Test in Task 6.

---

### Task 1: Worker scaffold, config, RPC dispatcher shell

**Files:**
- Modify: `cloudflare/wrangler.jsonc`, `cloudflare/package.json`, `cloudflare/.gitignore`
- Create: `cloudflare/migrations/0002_settings_token_stock_txn.sql`, `cloudflare/tsconfig.json`, `cloudflare/vitest.config.ts`, `cloudflare/test/apply-migrations.ts`, `cloudflare/test/env.d.ts`, `cloudflare/src/index.ts`, `cloudflare/src/env.ts`, `cloudflare/src/http.ts`, `cloudflare/src/rpc.ts`, `cloudflare/public/.gitkeep`, `cloudflare/.dev.vars.example`
- Test: `cloudflare/test/rpc.test.ts`

**Interfaces:**
- Produces:
  - `interface Env { DB: D1Database; ASSETS: Fetcher; GUEST_LIMITER: RateLimit; PW_SALT: string; GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string; GOOGLE_REFRESH_TOKEN: string; DRIVE_ROOT_FOLDER_ID: string }` in `src/env.ts`
  - `type Access = 'public' | 'officer' | 'admin'`
  - `interface Ctx { env: Env; req: Request; exec: ExecutionContext; session: Session | null; ip: string }`
  - `type RpcHandler = (ctx: Ctx, args: unknown[]) => Promise<unknown>`
  - `registerRpc(fn: string, access: Access, handler: RpcHandler): void` and `handleRpc(fn: string, ctx: Ctx, args: unknown[]): Promise<Response>` in `src/rpc.ts`
  - `json(body: unknown, init?: ResponseInit): Response`, `fail(message: string, code?: 'AUTH' | 'FORBIDDEN' | 'RATE_LIMIT' | 'VALIDATION'): { ok: false; message: string; code?: string }` in `src/http.ts`
  - Worker `fetch` routes `POST /api/rpc/:fn` → `handleRpc`, `/api/*` else → 404 JSON, everything else → `env.ASSETS.fetch(req)`; `scheduled` calls `runLowStockCron(env)` (stub until Task 7).

- [ ] **Step 1: Config.** `wrangler.jsonc`: `database_name: "ims_db"`, `main: "src/index.ts"`, `assets: { directory: "public", binding: "ASSETS", run_worker_first: ["/api/*"] }`, `triggers: { crons: ["0 1 * * *"] }`, `vars: { DRIVE_ROOT_FOLDER_ID: "1kVDobdN0V1U7bqTHHFMEDrlUEhQAMG4U" }`, `ratelimits: [{ name: "GUEST_LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } }]`, `observability: { enabled: true }`. `package.json`: add devDependencies `typescript`, `vitest`, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types` (versions the pool-workers README pairs; lockfile pins them) and scripts `test: "vitest run"`, `typecheck: "tsc --noEmit"`, `dev: "wrangler dev"`. `.gitignore` adds `seeds/`. `.dev.vars.example` lists the four secrets with empty values.

- [ ] **Step 2: Migration `0002_settings_token_stock_txn.sql`.**

```sql
ALTER TABLE settings ADD COLUMN telegram_bot_token TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN stock_txn TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 3: Write failing tests** in `test/rpc.test.ts` (use `SELF.fetch`, migrations applied in `test/apply-migrations.ts` via `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`):
  - `unknown function returns legacy not-found`: `POST /api/rpc/apiNope` → status 404, body `{ ok: false, message: 'ไม่พบฟังก์ชัน' }`.
  - `GET on rpc is rejected`: `GET /api/rpc/apiGetBootstrap` → 405.
  - `officer function without session returns AUTH`: register a test-only officer fn; body `code === 'AUTH'`, message `'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'`.
  - `non-api path serves index`: `GET /` → status 200 (put a placeholder `public/index.html` in the test).
  - `body args must be an array`: body `{ args: 'x' }` → `{ ok: false, code: 'VALIDATION' }`.

- [ ] **Step 4: Run** `npm test` → FAIL (modules missing).

- [ ] **Step 5: Implement** `src/env.ts`, `src/http.ts`, `src/rpc.ts`, `src/index.ts`. The request body is `{ args: unknown[] }` (fn comes from the path). `handleRpc` resolves the session (stub returning `null` until Task 3 replaces it via `getSession(ctx)`), checks the rank, overwrites actor fields per Global Constraints, catches thrown errors as `{ ok: false, message: String(err.message) }` and logs them with `console.error`.

- [ ] **Step 6: Run** `npm test` and `npm run typecheck` → PASS. Run `npm run db:migrate:local` → `0002` applies.

- [ ] **Step 7: Commit** `feat(cloudflare): worker scaffold with allowlisted rpc`.

---

### Task 2: Time, ids, fiscal year, row mapping

**Files:**
- Create: `cloudflare/src/lib/time.ts`, `cloudflare/src/lib/ids.ts`, `cloudflare/src/lib/rows.ts`
- Test: `cloudflare/test/lib.test.ts`

**Interfaces:**
- Produces:
  - `nowBkk(at?: Date): string` → `'YYYY-MM-DD HH:MM:SS'`; `todayBkk(at?: Date): string` → `'YYYY-MM-DD'`
  - `currentFiscalYear(at?: Date): number` (B.E.); `fiscalYearRange(fy: number): { from: string; to: string }`
  - `genId(prefix: 'U'|'M'|'CAT'|'R'|'RI'|'P'|'SM'|'AUD'|'OB'|'F'): string` → `PREFIX-` + 8 uppercase hex
  - `nextDocNo(db: D1Database, at?: Date): Promise<string>` → `REQ-yyyyMMdd-NNNN` using `doc_counters` (`INSERT … ON CONFLICT(day) DO UPDATE SET seq = seq + 1 RETURNING seq`)
  - `toLegacy(table: TableName, row: Record<string, unknown>): Record<string, unknown>` and `fromLegacy(table: TableName, obj: Record<string, unknown>): Record<string, unknown>` — column maps from `cloudflare/docs/data-mapping.md` (e.g. `stock_qty` ↔ `StockQty`, `user_id` ↔ `UserID`, `entity_id` ↔ `EntityID`; `users.password_hash` is never emitted)
  - `computeStockState(stockQty: number, minQty: number): 'OUT' | 'LOW' | 'OK'`

- [ ] **Step 1: Write failing tests:**
  - `nowBkk(new Date('2026-09-30T17:30:00Z')) === '2026-10-01 00:30:00'`
  - `currentFiscalYear(new Date('2026-09-30T17:30:00Z')) === 2570` and `currentFiscalYear(new Date('2026-09-30T16:59:59Z')) === 2569`
  - `fiscalYearRange(2569)` deep-equals `{ from: '2025-10-01', to: '2026-09-30' }`
  - `genId('M')` matches `/^M-[0-9A-F]{8}$/`
  - two `nextDocNo(env.DB, new Date('2026-10-12T03:00:00Z'))` calls return `'REQ-20261012-0001'` then `'REQ-20261012-0002'`
  - `toLegacy('materials', { stock_qty: 5, min_qty: 2, … })` has `StockQty: 5`; `toLegacy('users', row)` has no `Password`/`password_hash` key
  - `computeStockState(0, 2) === 'OUT'`, `(2, 2) === 'LOW'`, `(3, 2) === 'OK'`

- [ ] **Step 2: Run** `npx vitest run test/lib.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three files. `nowBkk` = `new Date(at.getTime() + 7 * 3600_000).toISOString()` sliced to 19 chars with `T` → space.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cloudflare): bangkok time, ids, docno counter, row mapping`.

---

### Task 3: Auth — passwords, sessions, login/logout/bootstrap/profile

**Files:**
- Create: `cloudflare/src/auth/password.ts`, `cloudflare/src/auth/session.ts`, `cloudflare/src/api/auth.ts`, `cloudflare/src/lib/audit.ts`
- Modify: `cloudflare/src/rpc.ts` (use real `getSession`), `cloudflare/src/index.ts` (import `src/api/auth.ts` to register)
- Test: `cloudflare/test/auth.test.ts`

**Interfaces:**
- Consumes: `registerRpc`, `Ctx`, `nowBkk`, `genId`, `toLegacy` (Tasks 1-2)
- Produces:
  - `verifyPassword(stored: string, pw: string, salt: string): Promise<{ ok: boolean; needsRehash: boolean }>`; `hashPassword(pw: string): Promise<string>` (PBKDF2 format from Global Constraints)
  - `createSession(env: Env, user: { id: string; role: string }): Promise<{ token: string; cookie: string }>`; `getSession(ctx: Ctx): Promise<Session | null>`; `destroySession(ctx: Ctx): Promise<string /* clearing cookie */>`
  - `interface Session { id: string; role: 'admin'|'officer'|'staff'; username: string; tokenHash: string }`
  - `logAudit(db: D1Database, e: { action: string; entity: string; entityId: string; detail: string; actor: string }): D1PreparedStatement` (returns the statement so callers can put it in a `batch`)
  - RPCs: `apiGetBootstrap` (public, `Code/code.gs:758`, Settings without token), `apiLogin` (public, `:778`), `apiLogout` (officer, `:797`), `apiUpdateProfile` (officer, `:942`). A handler that must set a cookie returns `{ body, headers }`; `handleRpc` applies those headers.

- [ ] **Step 1: Write failing tests:**
  - `legacy sha256 hash verifies and asks for rehash`: stored = `'sha256$' + hex(sha256('SALT|1234'))`, `verifyPassword(stored, '1234', 'SALT')` → `{ ok: true, needsRehash: true }`; wrong password → `ok: false`.
  - `plaintext legacy verifies and asks for rehash`: `verifyPassword('1234', '1234', 'SALT')` → `{ ok: true, needsRehash: true }`.
  - `pbkdf2 round trip`: `verifyPassword(await hashPassword('x'), 'x', '')` → `{ ok: true, needsRehash: false }`.
  - `login sets HttpOnly cookie and rehashes`: seed a user with a sha256 hash and role `staff`; `apiLogin({ username: 'u', password: '1234' })` → body `ok: true`, `user.Role === 'officer'`, no `Password` key, response `Set-Cookie` contains `ims_session=`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=28800`; DB `password_hash` now starts with `pbkdf2$`; an `audit_log` row with action `LOGIN` exists.
  - `wrong password gives legacy message`: `ok: false` with the message `apiLogin` returns in `code.gs`.
  - `expired session returns AUTH`: insert a session with `expires_at` 1 s in the past; officer RPC with that cookie → `code: 'AUTH'`.
  - `logout deletes the session row and clears cookie` (`Max-Age=0`).
  - `profile update cannot change role or email`: officer sends `{ Role: 'admin', Email: 'x@y', FullName: 'N' }` → full_name changes, role/email do not.
  - `bootstrap never exposes telegram token`: settings row with token `'123:ABC'` → body has no `TelegramBotToken`.

- [ ] **Step 2: Run** `npx vitest run test/auth.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Session lookup: cookie → SHA-256 hex → `SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE token_hash = ? AND expires_at > ?` (now in `nowBkk`). Login also deletes that user's expired sessions. `staff` role is migrated to `officer` on login (legacy `:778`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cloudflare): sessions, password migration, login/logout/profile`.

---

### Task 4: Materials, categories, purchases, opening balances

**Files:**
- Create: `cloudflare/src/api/materials.ts`, `cloudflare/src/lib/stock.ts`
- Test: `cloudflare/test/materials.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3
- Produces:
  - `movementStmt(db: D1Database, m: { materialId: string; type: 'IN'|'OUT'|'ADJUST'; qty: number; refDoc: string; note: string; actor: string; guardRequestId?: string; guardTxn?: string }): D1PreparedStatement` — `INSERT INTO stock_movements … SELECT … FROM materials WHERE id = ?` computing `before_qty = stock_qty` and `after_qty` from it, with `AND EXISTS (SELECT 1 FROM requests WHERE id = ? AND stock_txn = ?)` appended when a guard is given. Must be placed **before** the matching material `UPDATE` in a batch.
  - RPCs (legacy lines in `Code/code.gs`): `apiGetMaterials` (public, 969, adds `StockState`), `apiGetLowStock` (public, 988), `apiGetCategories` (public, 847, sorted with `localeCompare(…, 'th')`), `apiSaveCategory` (officer, 854), `apiSaveMaterials` (officer, 996), `apiDeleteMaterials` (officer, 1061), `apiPurchaseMaterials` (officer, 1073), `apiSaveOpeningBalance` (officer, 1747).
  - `apiSaveMaterials` accepts `ImageUrl`/`FileUrl` strings produced by the Task 8 upload flow; a legacy base64 payload object in those fields → `{ ok: false, code: 'VALIDATION' }`.

- [ ] **Step 1: Write failing tests:**
  - `create material logs opening IN`: save `{ action: 'create', Code: 'A-1', Name: 'ปากกา', StockQty: 5, … }` → `opening_qty = 5`, one `IN` movement with note `'เปิดยอดเริ่มต้น'`, `before_qty 0`, `after_qty 5`.
  - `duplicate code rejected` with the legacy message.
  - `editing stock logs ADJUST |diff|`: 5 → 3 gives `ADJUST`, `qty 2`, note `'ปรับยอดจากฟอร์มแก้ไข'`, `before 5`, `after 3`.
  - `purchase adds stock`: purchase 4 at UnitPrice 10 → `stock_qty 7`, purchases row `amount 40`, `purchase_date` today Bangkok, `IN` movement, audit `PURCHASE`.
  - `low stock list`: material with stock 1, min 2 → in `apiGetLowStock` with `StockState: 'LOW'`.
  - `opening balance upsert`: two saves for (M, 2569) → one row, latest qty.
  - `actor comes from session`: client sends `actor: 'hacker'` → movement/audit actor is the session username.
  - `deleting a material keeps history`: movement `material_id` becomes NULL, code/name snapshot kept.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (each mutating RPC is one `db.batch([...])` including its `logAudit` statement). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cloudflare): materials, categories, purchases, opening balances`.

---

### Task 5: Requests and atomic stock

**Files:**
- Create: `cloudflare/src/api/requests.ts`
- Test: `cloudflare/test/requests.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4 (`movementStmt`, `nextDocNo`, `logAudit`, `GUEST_LIMITER`)
- Produces:
  - `applyRequestStock(env: Env, requestId: string, direction: -1 | 1, actor: string, extraStmts: D1PreparedStatement[]): Promise<{ ok: true } | { ok: false; shortages: { Code: string; Name: string; StockQty: number; Qty: number }[] }>`
  - `notifyHooks: { onNewRequest?: (env: Env, req: Record<string, unknown>) => Promise<void>; onStatusChange?: (...) => Promise<void> }` — set by Task 7, called through `ctx.exec.waitUntil`.
  - RPCs: `apiCreateRequest` (public, 1112), `apiTrackRequest` (public, 1201), `apiGetMyRequests` (officer, 1186), `apiGetRequestForPrint` (officer, 1243), `apiGetRequests` (officer, 1164), `apiUpdateRequestStatus` (officer, 1272), `apiDeleteRequests` (officer, 1303).

`applyRequestStock` algorithm (the tests do not determine it):
1. `txn = crypto.randomUUID()`.
2. Batch, in order: (a) `UPDATE requests SET stock_applied = ?, stock_txn = ?, … WHERE id = ? AND stock_applied = ?` (for −1: sets 1 where 0; for +1: sets 0 where 1); (b) for each item, `movementStmt(... guardRequestId, guardTxn: txn)` then `UPDATE materials SET stock_qty = stock_qty + (? * qty) WHERE id = ? AND EXISTS (SELECT 1 FROM requests WHERE id = ? AND stock_txn = ?)`; (c) `extraStmts` (status fields, audit).
3. The `CHECK (stock_qty >= 0)` makes the whole batch fail when stock is short; catch an error containing `CHECK constraint failed`, re-read the items and current stock, and return `shortages`. If (a) matched no row, nothing else changes.

- [ ] **Step 1: Write failing tests:**
  - `create checks stock but does not deduct`: qty > stock → legacy rejection message; valid request → `Status 'PENDING'`, `DocNo` matches `/^REQ-\d{8}-\d{4}$/`, stock unchanged.
  - `guest request stores null user`: no session → `user_id IS NULL`, actor = FullName.
  - `guest rate limit`: 11th guest create within the test's mocked limiter → `{ ok: false, code: 'RATE_LIMIT' }` (mock `env.GUEST_LIMITER.limit` to return `{ success: false }`).
  - `approve deducts once`: approve → stock 10 → 7, one `OUT` movement `ref_doc = DocNo`; approving again → stock still 7.
  - `approve fails whole request when short`: items A (enough) and B (short) → `ok: false`, message lists B's `Code`/`Name`, A's stock unchanged, status still `PENDING`.
  - `bulk approve reports per request`: two requests, one short → result array has one `ok: true`, one `ok: false`.
  - `concurrent approvals never go negative` (Review Focus 1): stock 3, requests X and Y each qty 3, `Promise.all` both approvals → exactly one `ok: true`, stock 0.
  - `approve → reject → approve` (Review Focus 3): stock 10 → 7 → 10 → 7; movements OUT, IN, OUT.
  - `reject keeps RejectReason only when REJECTED`; `ApprovedDate`/`ApprovedBy` set on every change (legacy).
  - `delete approved request restores stock and cascades items`.
  - `track by DocNo exact or FullName substring, max 10`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cloudflare): requests with atomic stock application`.

---

### Task 6: Reports, dashboards, stock card, CSV, audit log

**Files:**
- Create: `cloudflare/src/api/reports.ts`
- Test: `cloudflare/test/reports.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5
- Produces RPCs with legacy shapes: `apiGetStockMovements` (officer, 1322, max 1000, filters `materialId/type/from/to/q`), `apiGetAdminDashboard` (officer, 1367), `apiGetTeacherDashboard` (officer, 1407), `apiGetInventoryAccount` (officer, 1445), `apiGetInventoryReport` (officer, 1609), `apiGetStockCard` (officer, 2150), `apiExportCSV` (admin, 1510, types `materials|requests|stock_movements|audit|account|stock_card`, base64 of `'﻿' + csv`), `apiGetAuditLog` (admin, 1345, max 500).
- Do the filtering/aggregation in SQL where it is a plain filter or sum; keep the legacy formulas exactly: report `Remain = max(0, opening + purchased − used)`; opening from `opening_balances` else `materials.opening_qty`; stock card replays movements before `from` (IN +, OUT −, ADJUST sets `after_qty`) and sorts by `created_at` ascending.

- [ ] **Step 1: Write failing tests** with one fixed dataset (2 categories, 3 materials, purchases and approved/pending requests spanning FY 2569 and 2570):
  - `inventory report FY 2569` → exact per-row `Opening/Purchased/Used/Remain` numbers and category totals for the fixture (compute by hand in the test file).
  - `pending requests are not counted as used`.
  - `opening balance overrides materials.opening_qty`.
  - `stock card opening replays movements before from` incl. one ADJUST.
  - `CSV starts with BOM` (Review Focus 5): decode base64 → first char `'﻿'`, header row equals legacy header for `materials`.
  - `admin-only`: officer calling `apiExportCSV` → `code: 'FORBIDDEN'`.
  - `admin dashboard remainValue = Σ stock_qty × unit_price`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cloudflare): reports, dashboards, stock card, csv export`.

---

### Task 7: Users, settings, Telegram, low-stock cron

**Files:**
- Create: `cloudflare/src/api/admin.ts`, `cloudflare/src/lib/telegram.ts`, `cloudflare/src/cron.ts`
- Modify: `cloudflare/src/index.ts` (scheduled → `runLowStockCron`)
- Test: `cloudflare/test/admin.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5 (`notifyHooks`, `hashPassword`)
- Produces:
  - `sendTelegram(token: string, chatId: string, html: string): Promise<{ ok: boolean; message?: string }>`
  - `runLowStockCron(env: Env): Promise<void>` — sends the low-stock message when `notify_low_stock = 'YES'` and at least one material is not `OK` (text format from `notifyLowStock_` in `code.gs`).
  - RPCs: `apiGetUsers` (admin, 877), `apiSaveUsers` (admin, 885; passwords stored with `hashPassword`), `apiDeleteUsers` (admin, 930; cannot delete self), `apiGetSettings` (admin, 803; token masked), `apiSaveSettings` (admin, 808; token rule from Global Constraints; LogoUrl/BannerUrl come from Task 8 uploads), `apiTestTelegram` (admin, 686; when the token argument is masked or empty, use the stored token).
  - Sets `notifyHooks.onNewRequest` / `onStatusChange` with the legacy message texts (`notifyNewRequest_`, `notifyStatusChange_`).

- [ ] **Step 1: Write failing tests** (stub `fetch` to `api.telegram.org` with `vi.spyOn(globalThis, 'fetch')` or `fetchMock`):
  - `settings token is masked`: stored `'123456:ABCDEFG'` → `TelegramBotToken === '••••DEFG'`.
  - `saving masked or empty token keeps stored token`; `saving a new token replaces it`.
  - `new user password is pbkdf2`; `duplicate username rejected`; `admin cannot delete self`.
  - `cron sends one Telegram message when low stock and enabled`; `cron sends nothing when NotifyLowStock is 'NO'`.
  - `new request triggers telegram when NotifyOnNewRequest is 'YES'` (assert the fetch body contains the DocNo).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cloudflare): users, settings, telegram, low-stock cron`.

---

### Task 8: Google Drive resumable upload

**Files:**
- Create: `cloudflare/src/lib/drive.ts`, `cloudflare/src/api/uploads.ts`
- Modify: `cloudflare/src/index.ts` (route `POST /api/uploads/:id/chunk` for the proxy fallback)
- Test: `cloudflare/test/uploads.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3
- Produces:
  - `getAccessToken(env: Env): Promise<string>` (refresh-token grant at `https://oauth2.googleapis.com/token`, cached in module scope until 60 s before expiry)
  - `ensureSubfolder(env: Env, name: FolderName): Promise<string>` (`files.list` with `q = "'<root>' in parents and name = '<name>' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"`, create if missing)
  - RPC `apiStartUpload({ purpose: 'material_image'|'material_file'|'request_attachment'|'logo'|'banner', fileName: string, mimeType: string, size: number })` → `{ ok: true, uploadId: string, uploadUrl: string, chunkSize: 5242880 }`. Access: `request_attachment` public (guest form, rate-limited by `GUEST_LIMITER`); material purposes officer; logo/banner admin. Creates the session with `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,mimeType,size` and headers `X-Upload-Content-Type`, `X-Upload-Content-Length`, `Origin: <request origin>`; stores a pending row in `drive_files` (`drive_file_id = 'pending:' + uploadId`).
  - RPC `apiFinishUpload({ uploadId: string, driveFileId: string })` → verifies via `files.get` that the file's parent is the expected subfolder, size ≤ 25 MB and MIME allowed (else deletes it and fails), sets permission `{ role: 'reader', type: 'anyone' }`, updates the `drive_files` row, returns `{ ok: true, url, driveFileId }`.
  - `POST /api/uploads/:uploadId/chunk` (proxy fallback): forwards the body and `Content-Range` to the stored session URL; same access as the start call; returns Google's status (308 → `{ ok: true, range }`).

- [ ] **Step 1: Write failing tests** with a fetch mock for Google endpoints:
  - `start rejects size over 25 MB` → `code: 'VALIDATION'`.
  - `start rejects disallowed MIME` (`application/zip`).
  - `start returns Google session URL and chunkSize 5242880`, and passes the `Origin` header.
  - `guest may start only request_attachment`; guest `material_image` → `code: 'AUTH'`.
  - `finish sets anyone-reader permission and returns lh3 URL for images`.
  - `finish deletes a file whose real size exceeds the limit`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cloudflare): drive resumable upload`.

---

### Task 9: Frontend transport, upload, XLSX

**Files:**
- Create: `cloudflare/public/index.html` (copy of `Code/index.html`, then edit the copy only)
- Test: manual + `cloudflare/test/frontend.test.ts` (static checks)

**Interfaces:**
- Consumes: every RPC above, `apiStartUpload`/`apiFinishUpload`, the chunk proxy route.
- Changes in the copy:
  - `api(fn, ...args)` (`index.html:648-702`): remove the `IN_GAS` branch and `GAS_URL`; `fetch('/api/rpc/' + fn, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args }) })`; keep the 8 h client expiry check, the `code === 'AUTH'` → `forceLogout_()` flow and the Thai network-error messages; stop reading or writing `supply_token`.
  - New `uploadFile(file: File, purpose: string, onProgress: (pct: number) => void): Promise<{ url: string; driveFileId: string }>`: client-side size/MIME check with the Global Constraints values, `apiStartUpload`, then `PUT` each `file.slice` chunk with `Content-Range: bytes a-b/total` to `uploadUrl`; on a CORS/network failure switch to `/api/uploads/:id/chunk`; on 308 continue from the returned `Range`; retry a chunk up to 3 times; final 200/201 response gives the file id → `apiFinishUpload`. Show a progress bar inside the existing SweetAlert loading dialog.
  - Every `fileToPayload` call site (`index.html:799` and its callers: material image/file, request attachment, logo, banner) uses `uploadFile` first and sends the returned `url` in the existing field.
  - `apiExportInventoryReportSheet` call (`index.html:2148`) is replaced by `exportInventoryXlsx(data)` using SheetJS loaded from `https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js`, building the same three sheets (`ทะเบียนวัสดุคงเหลือ`, `สรุปวัสดุคงเหลือ`, `Stock card`) from `apiGetInventoryReport` data.

- [ ] **Step 1: Write failing static tests** (read `public/index.html` as text in Node, run with plain vitest in a separate `vitest.node.config.ts`):
  - no occurrence of `google.script.run`, `GAS_URL`, `supply_token`, `fileToPayload(`, `apiExportInventoryReportSheet`.
  - contains `'/api/rpc/'` and `uploadFile(`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Edit the copy.** **Step 4: Run** → PASS.
- [ ] **Step 5: Manual check** with `npm run dev` and a seeded local DB (Task 10): login/logout, add material with image, guest request with attachment (progress bar moves), approve/reject, stock card print, inventory report XLSX opens in Excel with Thai text, mobile width 375 px has no horizontal scroll. Record the result of each item.
- [ ] **Step 6: Commit** `feat(cloudflare): frontend uses worker rpc and chunked drive upload`.

---

### Task 10: Legacy seed, docs, final verification

**Files:**
- Create: `cloudflare/scripts/seed-legacy.mjs`, `cloudflare/README.md`
- Modify: `cloudflare/package.json` (devDependency `xlsx`, script `seed:build`)
- Test: `cloudflare/test/seed.test.ts` (Node config)

**Interfaces:**
- `node scripts/seed-legacy.mjs <path-to-exported.xlsx>` writes `seeds/legacy-seed.sql` (gitignored) with `INSERT … ON CONFLICT(id) DO UPDATE` for Users (mapped by **`HEADERS.Users` order**, not the sheet header — see `cloudflare/docs/data-mapping.md`; role `staff` → `officer`; values without `sha256$` are refused, not imported as plaintext) and Settings (`id = 1`, including `telegram_bot_token`). Prints row counts read/written.

- [ ] **Step 1: Write failing tests** with a small in-memory workbook built by `xlsx` in the test: users header with 8 names and rows with 10 values → SQL maps `Department`, `Email`, `CreatedAt`, `UpdatedAt` by `HEADERS` order; a plaintext password row is reported and skipped; running the generated SQL twice on local D1 leaves 4 users.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: README** (Thai): local setup, secrets (`wrangler secret put PW_SALT` etc., where to read `PW_SALT` in Apps Script → Project Settings → Script Properties), how to obtain the Google OAuth refresh token with scope `https://www.googleapis.com/auth/drive`, migration/seed/deploy commands, backup (`wrangler d1 export ims_db --remote --output …`) and rollback (`wrangler d1 time-travel restore ims_db --timestamp=…`, redeploy previous version with `wrangler rollback`), GAS undeploy step after acceptance.
- [ ] **Step 6: Full verification:** `npm run typecheck`, `npm test`, `npm run db:migrate:local`, `npm run db:smoke:local`, `npm run db:negative:local` → all PASS.
- [ ] **Step 7: Commit** `feat(cloudflare): legacy seed script and deployment guide`.

Remote steps (remote migration apply, seed import, secrets, deploy) are listed in the README and run only after the owner approves each one.
