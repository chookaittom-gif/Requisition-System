# Cloudflare Migration — Design (agreed 2026-10-12)

Decisions from the grilling session. Background: `cloudflare/docs/feature-inventory.md`, `cloudflare/docs/data-mapping.md`.

## Architecture
- One Cloudflare Worker with Static Assets serves `public/index.html` and `/api/*` on `*.workers.dev`. Custom domain later.
- D1 database `ims_db` (id `4c98cc16-6008-4880-9d38-99544c79b838`, account `17abb4914aa1cbfcf03edddedbaea672`).
- Cron Trigger `0 1 * * *` (08:00 Asia/Bangkok) replaces `notifyLowStock_`.
- Google is used only for Drive (images and attachments). Everything else leaves GAS. The source Sheet is already backed up and is not deleted.

## API contract
- The frontend keeps calling `api(fn, ...args)`. The Worker exposes `POST /api/rpc/:fn` with an explicit allowlist (role per function, as `FN_ACCESS` in `Code/code.gs:66-85`) and returns the same JSON shapes as the GAS functions (PascalCase keys, `{ok, message, code}`). This keeps `index.html` changes to the transport layer.
- `apiRunSchemaMigration` and `apiExportInventoryReportSheet` are dropped. `ensureSetup`, `initPasswordSalt`, `createDailyLowStockTrigger` are not ported.

## Data
- No `.xls` import (owner cleared it; only structure remains).
- One-time seed: Users (4 rows, keep `sha256$` hashes) and Settings (1 row). AuditLog is skipped.
- `settings.telegram_bot_token` is added back (stays UI-editable, as before). The API never returns it in full: it returns a mask such as `••••1234` and overwrites only when the admin enters a new value.

## Auth
- Server sessions in D1, 8 hours absolute from login, cookie `HttpOnly; Secure; SameSite=Lax`.
- Legacy `sha256$` hashes verify with secret `PW_SALT`; on successful login they are rehashed to PBKDF2-SHA256, 100,000 iterations.
- Guests may still create and track requests; guest request creation is rate-limited to 10 per minute per IP.

## Business rule changes
- Approval fails for the whole request when any item lacks stock (legacy clamped at 0). Bulk approval reports a result per request.
- `stock_applied` prevents double deduction. Leaving APPROVED restores stock (legacy behavior kept).

## Files
- Drive access through the folder owner's OAuth refresh token (secret).
- Browser uploads 5 MiB chunks directly to the Drive resumable session URL the Worker created with the page `Origin`; fall back to proxying through the Worker if CORS fails.
- Max 25 MB per file; images (jpg, png, webp), PDF, Word, Excel. Checked on client and on finalize.

## Frontend
- Keep `index.html`. Replace `api()` transport, cookie session instead of the token in storage, chunked upload instead of `fileToPayload`, XLSX built in the browser with SheetJS.

## Removed
- Email sending (`notify_email`, `users.email` columns stay for a later Gmail API add-on).

## Cutover
- Big-bang. Undeploy the GAS web app after the new system passes production testing.
- Every `--remote` command and every deploy needs separate explicit approval.

## Defaults chosen by the assistant
- Tests: Vitest with `@cloudflare/vitest-pool-workers`.
- Guest rate limit 10/min/IP via the Workers Rate Limiting binding.
