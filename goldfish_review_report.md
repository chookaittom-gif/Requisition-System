# Goldfish Annotated Review Report

**Target:** `docs/designs/monthly_stock_alert_notification.md` (Lines 1–291, Full File)  
**Status:** In Review  
**Date:** 2026-11-10  

---

## Reviewer Status

| Reviewer | Persona | Status | Findings |
| :--- | :--- | :--- | :--- |
| `egm-design` | Hostile Design Critic | Completed | 2 Blockers, 3 Majors, 1 Nit |
| `egm-structural` | Structural Layout Validator | Completed | 3 Majors, 3 Nits |
| `egm-implementation-readiness` | Implementation Readiness Lead | Completed | 2 Blockers, 3 Majors, 2 Nits |

---

## Prioritized Findings & AI Suggestions

### 1. [TypeScript Interface Breakage in `NotifyConfig`] [`egm-implementation-readiness`] - Severity: 🔴 Blocker
* **Affected Scope:** Lines 118–128 (Section 3: Settings Retrieval & Notification Config Expansion)
* **Discrepancy Description:** The proposed `NotifyConfig` snippet drops existing fields `onNewRequest: boolean` and `onStatusChange: boolean`, which are actively required by `notifyHooks` in `cloudflare/src/api/admin.ts`. Applying it directly will cause TypeScript build errors.
* **Rationale:** Preserving backward compatibility in configuration objects is mandatory to avoid breaking admin notifications.
* ***AI Suggestion:*** `PROPOSE FIX`
* ***Justification:** Fully valid finding. Retain all existing fields in `NotifyConfig` and add only the new `lineToken` and `lineTo` properties.
* ***Proposed Edit:***
  * Location: Section 3 (Lines 118–128)
  * Change: Update `NotifyConfig` to include `onNewRequest: boolean;` and `onStatusChange: boolean;`.

---

### 2. [LINE Flex URI Action Button Causes Runtime API Error] [`egm-implementation-readiness`] - Severity: 🔴 Blocker
* **Affected Scope:** Lines 154–155, 248–249 (Section 4.2 & Detailed Plan 3)
* **Discrepancy Description:** The design specifies a Footer URI Action button `"เปิดดูทะเบียนพัสดุ"` pointing to system URL. However, the system does not have an absolute public domain configured in `Env`, and LINE Messaging API strictly rejects non-absolute URIs with HTTP 400 Bad Request, crashing the dispatch. Existing flex cards in `lineFlex.ts` omit footer URI buttons.
* **Rationale:** A bad payload prevents message delivery entirely.
* ***AI Suggestion:*** `PROPOSE FIX`
* ***Justification:** Fully valid finding. Omit the URI Action footer button to keep `lowStockFlex` robust, lightweight, and consistent with other cards in `lineFlex.ts`.
* ***Proposed Edit:***
  * Location: Section 4.2 and Detailed Plan 3
  * Change: Remove the Footer URI Action button; let the card be a clean notification bubble with header and body.

---

### 3. [Missing Bangkok Day-25 Guard in Cron Execution] [`egm-design`] - Severity: 🔴 Blocker
* **Affected Scope:** Lines 101–110, 160–193 (Section 2 & Section 5)
* **Discrepancy Description:** The cron expression `"0 22 24 * *"` runs at 22:00 UTC on the 24th of each month (= 05:00 UTC+7 on the 25th). However, if triggered manually or via staging with different schedules, without a runtime day-check guard (`if (bkkDay !== 25) return;`), false alerts could be dispatched.
* **Rationale:** Multi-environment reliability and prevention of duplicate/spurious runs.
* ***AI Suggestion:*** `PROPOSE FIX`
* ***Justification:** Fully valid finding. Add an explicit Bangkok day check (`const day = parseInt(nowBkk().slice(8, 10), 10); if (day !== 25) return;`) in `runLowStockCron`.
* ***Proposed Edit:***
  * Location: Section 2 and Section 5
  * Change: Add day guard logic to the cron handler specification.

---

### 4. [LINE Flex Message Payload Size & Truncation Threshold Conflict] [`egm-design`, `egm-structural`, `egm-implementation-readiness`] - Severity: 🟡 Major
* **Affected Scope:** Lines 43–45, 138, 235, 246 (Open Questions, Section 4.1, Detailed Plan)
* **Discrepancy Description:** 
  1. Internal contradiction: Section 4.1 specifies 20 items, while Detailed Plan specifies 15 items. Existing test in `admin.test.ts:454` expects truncation after 15 items.
  2. LINE Messaging API enforces a strict 30KB payload limit. 15–20 complex nested boxes with Thai Unicode can approach this limit.
* **Rationale:** Standardizing to 15 items satisfies the 30KB ceiling, preserves existing tests, and resolves document contradiction.
* ***AI Suggestion:*** `PROPOSE FIX`
* ***Justification:** Standardize the truncation limit across Telegram and LINE to **15 items** (prioritizing OUT items first, then LOW), mark Open Question 1 as resolved, and specify an overflow counter `... และอีก N รายการ`.
* ***Proposed Edit:***
  * Location: Lines 43–45, 138, 235, 246
  * Change: Update all references to 15 items uniformly.

---

### 5. [Missing Telegram HTML Tag-Safe Overflow Handling] [`egm-design`, `egm-implementation-readiness`] - Severity: 🟡 Major
* **Affected Scope:** Lines 132–139, 230–236 (Section 4.1 & Detailed Plan 2)
* **Discrepancy Description:** Telegram messages are limited to 4096 characters. Long item names can bloat the message, and arbitrary string slicing could cut open HTML tags (e.g. `<b>`, `<code>`), causing Telegram HTTP 400 Bad Request.
* **Rationale:** HTML formatting must be tag-safe and name-truncated before escaping.
* ***AI Suggestion:*** `PROPOSE FIX`
* ***Justification:** Specify that item names are clamped (`name.slice(0, 40)`) before escaping, and provide the exact canonical string template in the design.
* ***Proposed Edit:***
  * Location: Section 4.1
  * Change: Add the exact string template format and tag-safe name clamping rule.

---

### 6. [Missing Negative & Partial Failure Edge-Case CUJs] [`egm-structural`] - Severity: 🟡 Major
* **Affected Scope:** Lines 49–67 (Critical User Journeys)
* **Discrepancy Description:** The CUJ section only covers happy paths. It lacks testable acceptance criteria for when stock is healthy (0 low-stock items -> silent exit) or when one channel fails (channel isolation).
* **Rationale:** Clear CUJs guide comprehensive unit test implementation.
* ***AI Suggestion:*** `PROPOSE FIX`
* ***Justification:** Add `CUJ 3: Healthy Stock State (Silent Bypass)` and `CUJ 4: Channel Isolation & Graceful Error Handling`.
* ***Proposed Edit:***
  * Location: Section Critical User Journeys
  * Change: Append CUJ 3 and CUJ 4.

---

### 7. [Unresolved Open Question 2 on Admin Manual Trigger] [`egm-structural`, `egm-design`, `egm-implementation-readiness`] - Severity: 🟡 Major
* **Affected Scope:** Lines 45–46 (Open Questions)
* **Discrepancy Description:** Question 2 asks whether to add a preview/test button in Admin Settings UI. Leaving it open creates scope creep and backend vs frontend boundary ambiguity.
* **Rationale:** Design docs must be decisive. Frontend UI changes should be either explicitly budgeted or placed in Non-Goals.
* ***AI Suggestion:*** `PROPOSE FIX`
* ***Justification:** Move manual admin trigger UI to `## Non-Goals` for this phase (Backend Cron & Formatter), keeping the current scope lean and surgical.
* ***Proposed Edit:***
  * Location: Lines 45–46 and `## Non-Goals`
  * Change: Remove Open Question 2; add to Non-Goals: "ปุ่มทดสอบส่งการแจ้งเตือนในหน้า UI ผู้ดูแลระบบ (ตัดออกจากขอบเขตงานรอบนี้ เพื่อเน้นความปลอดภัยของ Cron ฝั่ง Backend ก่อน)".

---

### 8. [Mermaid Participant Special Characters & Minor Nits] [`egm-structural`, `egm-implementation-readiness`] - Severity: 🟢 Nit
* **Affected Scope:** Lines 77, 113, 278, 251
* **Discrepancy Description:**
  1. Mermaid participant label has unquoted special characters `(0 22 24 * *)`.
  2. Lingering alternative path `(หรือ cloudflare/src/lib/notify.ts)`.
  3. Extraneous `---` divider detaching Verification Plan at line 278.
  4. Missing explicit imports in `cron.ts` plan.
* **Rationale:** Clean formatting and unambiguous specification.
* ***AI Suggestion:*** `PROPOSE FIX`
* ***Proposed Edit:***
  * Location: Lines 77, 113, 278, and Detailed Plan 4
  * Change: Apply all 4 minor cleanups in batch.
