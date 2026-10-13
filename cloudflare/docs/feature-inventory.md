# Feature Inventory — ระบบเบิกจ่ายพัสดุ (GAS → Cloudflare)

เอกสารนี้สรุปทุกความสามารถของระบบเดิมจาก `Code/code.gs` (2284 บรรทัด) และ `Code/index.html` (4631 บรรทัด) ใช้เป็นเช็กลิสต์ว่าระบบใหม่ต้องไม่ตกหล่นฟีเจอร์ใด
การอ้างอิง `:NNN` หมายถึงบรรทัดใน `Code/code.gs` และ `index.html:NNN` หมายถึงบรรทัดใน `Code/index.html`

## สารบัญ
1. [Config และค่าคงที่](#1-config-และค่าคงที่)
2. [Access control เดิม](#2-access-control-เดิม)
3. [API Mapping](#3-api-mapping)
4. [Business rules](#4-business-rules)
5. [Auth และ Session](#5-auth-และ-session)
6. [Integrations](#6-integrations)
7. [ฟีเจอร์ฝั่ง Frontend](#7-ฟีเจอร์ฝั่ง-frontend)
8. [Hazards ที่ระบบใหม่ต้องแก้](#8-hazards-ที่ระบบใหม่ต้องแก้)

## 1. Config และค่าคงที่
| ค่า | ที่มา | ระบบใหม่ |
|---|---|---|
| `timeZone: Asia/Bangkok`, V8 | `appsscript.json` | คำนวณวันที่ใน Asia/Bangkok ฝั่ง Worker |
| `SHEET_ID` | `:11` | ใช้เป็นแหล่ง import เท่านั้น |
| `DRIVE_FOLDER_ID = 1kVDobdN0V1U7bqTHHFMEDrlUEhQAMG4U` | `:12` | Drive root เดิม (env var) |
| `SHEETS`, `HEADERS` | `:15-54` | ตาราง D1 ใน `migrations/0001_init.sql` |

## 2. Access control เดิม
- **`doPost` (`:87`)** รับ `{fn,args,token}` แล้วส่งต่อให้ `dispatch_` (`:99`) ซึ่งตรวจกับ allowlist `FN_ACCESS` (`:66-85`)
  - Rank ของ role คือ `ROLE_RANK = {admin:2, officer:1, staff:1}` (`:104`)
  - Token ถูกตรวจจาก CacheService ที่ key `tk_<token>`
- **Actor override:** `dispatch_` เขียนทับ `actor` ด้วยค่าจาก session (`:116-124`) ระบบใหม่ต้องทำแบบเดียวกัน คือห้ามเชื่อ actor ที่ client ส่งมา
- **ช่องโหว่ในโหมด GAS:** `google.script.run` (`index.html:662`) เรียกฟังก์ชัน global ได้ตรง ๆ โดยไม่ผ่าน `dispatch_` ระบบใหม่ปิดช่องนี้ด้วย REST route แบบ explicit

## 3. API Mapping
คอลัมน์ Access: P = public, O = officer ขึ้นไป, A = admin
Lock = ✓ หมายถึงฟังก์ชันใช้ `withLock_` (`:282`) ระบบใหม่ต้องใช้ D1 batch/atomic update แทน

| GAS function | บรรทัด | Access | อ่าน / เขียน | Lock | REST ที่เสนอ |
|---|---|---|---|---|---|
| apiGetBootstrap | 758 | P | R Settings (cache 600s) | | `GET /api/bootstrap` |
| apiLogin | 778 | P | R/W Users (rehash, staff→officer), AuditLog | | `POST /api/auth/login` |
| apiLogout | 797 | O | W AuditLog | | `POST /api/auth/logout` |
| apiGetMaterials | 969 | P | R Materials + StockState | | `GET /api/materials` |
| apiGetLowStock | 988 | P | StockState ≠ OK | | `GET /api/materials?state=low` |
| apiGetCategories | 847 | P | R Categories (เรียงแบบ th) | | `GET /api/categories` |
| apiCreateRequest | 1112 | P | R Materials; W Requests, RequestItems, AuditLog; Drive | ✓ | `POST /api/requests` |
| apiTrackRequest | 1201 | P | ค้นจาก DocNo/ID ตรงตัว หรือ FullName บางส่วน; สูงสุด 10 | | `GET /api/requests/track?q=` |
| apiGetMyRequests | 1186 | O | R Requests, RequestItems | | `GET /api/me/requests` |
| apiGetRequestForPrint | 1243 | O | R Requests, RequestItems | | `GET /api/requests/:id` |
| apiGetTeacherDashboard | 1407 | O | R Requests, RequestItems | | `GET /api/me/dashboard` |
| apiUpdateProfile | 942 | O | R/W Users (ห้ามแก้ Role/Email) | ✓ | `PATCH /api/me` |
| apiGetStockCard | 2150 | O | R Materials, OpeningBalances, StockMovements, Settings | | `GET /api/materials/:id/stock-card` |
| apiSaveMaterials | 996 | O | R/W Materials; W StockMovements, AuditLog; Drive | ✓ | `POST /api/materials/batch` |
| apiDeleteMaterials | 1061 | O | W Materials, AuditLog | ✓ | `DELETE /api/materials` (UI ไม่เรียก) |
| apiPurchaseMaterials | 1073 | O | R/W Materials; W Purchases, StockMovements, AuditLog | ✓ | `POST /api/purchases` |
| apiSaveCategory | 854 | O | W Categories, AuditLog | ✓ | `POST /api/categories` (UI ไม่เรียก) |
| apiGetRequests | 1164 | O | R Requests; filter status/from/to/q | | `GET /api/requests` |
| apiUpdateRequestStatus | 1272 | O | R/W Requests, Materials; W StockMovements, AuditLog | ✓ | `POST /api/requests/status` |
| apiDeleteRequests | 1303 | O | W Requests, RequestItems, Materials (คืนสต็อก), AuditLog | ✓ | `DELETE /api/requests` |
| apiGetStockMovements | 1322 | O | R StockMovements; filter; สูงสุด 1000 | | `GET /api/stock-movements` |
| apiGetAdminDashboard | 1367 | O | R Materials, Requests, RequestItems | | `GET /api/dashboard` |
| apiGetInventoryAccount | 1445 | O | R Materials, Purchases, Requests, RequestItems | | `GET /api/reports/account` |
| apiGetInventoryReport | 1609 | O | R + OpeningBalances, Settings | | `GET /api/reports/inventory` |
| apiSaveOpeningBalance | 1747 | O | upsert (MaterialID, FiscalYear); W AuditLog | ✓ | `PUT /api/opening-balances` |
| apiExportInventoryReportSheet | 1805 | O | สร้าง Google Sheet ชั่วคราว แล้วคืน XLSX base64 | | `GET /api/reports/inventory.xlsx` |
| apiExportCSV | 1510 | A | 6 ประเภท, UTF-8 BOM | | `GET /api/export/:type.csv` |
| apiGetUsers | 877 | A | R Users (ไม่ส่ง Password) | | `GET /api/users` |
| apiSaveUsers | 885 | A | R/W Users; Username ต้องไม่ซ้ำ | ✓ | `POST /api/users/batch` |
| apiDeleteUsers | 930 | A | W Users, AuditLog | ✓ | `DELETE /api/users` |
| apiGetSettings | 803 | A | R Settings | | `GET /api/settings` |
| apiSaveSettings | 808 | A | W Settings; Drive Logo/Banner; ล้าง `boot_v1` | ✓ | `PUT /api/settings` |
| apiGetAuditLog | 1345 | A | R AuditLog; สูงสุด 500 | | `GET /api/audit-log` |
| apiTestTelegram | 686 | A | ส่ง Telegram ทดสอบ | | `POST /api/settings/telegram/test` |
| apiRunSchemaMigration | 2083 | A | เติม header, แปลง staff→officer | ✓ | ไม่ย้ายมา (แทนด้วย D1 migrations) |

**ฟังก์ชัน global นอก allowlist** เรียกได้ผ่าน `google.script.run` เท่านั้น
- `ensureSetup` (`:388`): สร้าง sheet และ seed ข้อมูล ระบบใหม่แทนด้วย migration และ seed script
- `initPasswordSalt` (`:324`): ระบบใหม่ใช้ Secret `PW_SALT`
- `createDailyLowStockTrigger` (`:735`): ระบบใหม่ใช้ Cron Trigger

## 4. Business rules

### รหัสและเลขเอกสาร
- **`genId_` (`:291`):** `PREFIX-` ตามด้วย hex 8 ตัวตัวใหญ่ prefix ที่ใช้คือ `U, M, CAT, R, RI, P, SM, AUD, OB`
- **`genDocNo_` (`:295`):** `REQ-yyyyMMdd-NNNN` โดย NNNN = จำนวนเอกสารของวันนั้น + 1
  - ระบบใหม่ใช้ตาราง `doc_counters` แบบ atomic แทนการนับ

### วงจรใบขอเบิก
- **สร้าง (`:1112-1160`):** ปฏิเสธถ้า qty เกิน StockQty ขณะนั้น แต่ยังไม่ตัดสต็อก สถานะเริ่มต้น `PENDING`
- **เปลี่ยนสถานะ (`:1272-1300`):**
  - เปลี่ยนเข้า `APPROVED` → `adjustStockForRequest_(id,-1)` บันทึก OUT
  - เปลี่ยนออกจาก `APPROVED` → `+1` บันทึก IN
  - ตั้ง `ApprovedDate`/`ApprovedBy` ทุกครั้งที่เปลี่ยน
  - เก็บ `RejectReason` เฉพาะตอน `REJECTED`
- **ลบ (`:1303`):** ถ้าเคย APPROVED จะคืนสต็อกก่อน แล้วลบ items

### สต็อก
- **StockState:** `<=0` → `OUT`, `<=MinQty` → `LOW`, นอกนั้น `OK` (`computeStockState_`)
- **แก้ StockQty ในฟอร์ม:** บันทึก `ADJUST` qty=|diff| note `ปรับยอดจากฟอร์มแก้ไข`
- **สร้างพัสดุใหม่:** `OpeningQty = StockQty` และถ้ามียอด จะบันทึก `IN` note `เปิดยอดเริ่มต้น`
- **จัดซื้อ (`:1073`):** `StockQty += qty`, `Amount = qty*UnitPrice` (ราคาปัจจุบัน), `PurchaseDate` default วันนี้, บันทึก IN และ audit `PURCHASE`
- **Code ต้องไม่ซ้ำ** (ตรวจใน `apiSaveMaterials`)

### ปีงบประมาณ (`:1583`)
- FY (พ.ศ.) เริ่ม `(FY-543-1)-10-01` จบ `(FY-543)-09-30`
- ปีงบปัจจุบัน = ถ้าเดือน ≥ ตุลาคม ใช้ `year+543+1` ไม่งั้นใช้ `year+543`
- Frontend คำนวณแบบเดียวกันที่ `index.html:1944`, `:3766`

### ยอดยกมา
- ใช้แถว `OpeningBalances(MaterialID, FiscalYear)` ถ้ามี ไม่งั้น fallback เป็น `Materials.OpeningQty` (`:1649`, `:2171`)

### รายงาน
- **ทะเบียนวัสดุคงเหลือ (`:1609`):**
  - ช่วงเวลา: ต้นปีงบ ถึง `min(reportDate, สิ้นปีงบ)`
  - ยอดซื้อกรองตาม `PurchaseDate`
  - ยอดเบิกนับ items ของใบที่ APPROVED กรองตาม `RequestDate`
  - `Remain = max(0, opening + purchased − used)`
  - เรียงตามหมวด แล้วตามชื่อ (th) และสรุปยอดเงินต่อหมวด (หมวดว่างใช้ `อื่นๆ`)
- **บัญชีพัสดุ (`:1445`):** ยอดคงเหลือใช้ `StockQty` ปัจจุบัน และกรอง from/to ได้
- **Stock card (`:2150`):**
  - ยกยอดโดย replay `StockMovements` ก่อนวัน `from`: IN บวก, OUT ลบ, ADJUST ตั้งยอดเป็น `AfterQty`
  - ในช่วงเวลา ADJUST แสดงผลต่างเป็นรับหรือจ่าย
  - เรียงตาม `CreatedAt` (ดู `docs/superpowers/plans/2026-10-10-stock-card-design.md`)
- **Dashboard (`:1367`, `:1407`):** นับตามสถานะ, ยอดใช้ตามชื่อพัสดุ, Top 10, `remainValue = Σ StockQty*UnitPrice`
- **XLSX export (`:1805`):** 3 ชีต คือ `ทะเบียนวัสดุคงเหลือ`, `สรุปวัสดุคงเหลือ`, `Stock card` (ยอดจ่ายรายวันของเดือน)
- **CSV (`:1510`):** ประเภท materials, requests, stock_movements, audit, account, stock_card

## 5. Auth และ Session
- **Hash (`:331-334`):** `'sha256$' + hex(SHA-256(salt + '|' + pw))`
  - salt มาจาก Script Property `PW_SALT` ถ้าไม่มีใช้ `LEGACY_SALT` (`:315`)
  - **ระบบใหม่ต้องอ่าน `PW_SALT` จริงจาก Apps Script มาใส่เป็น Cloudflare Secret ก่อน ไม่งั้นผู้ใช้เดิม login ไม่ได้**
- **รหัสผ่าน plaintext เก่า:** ถ้าไม่มี prefix `sha256$` จะเทียบ plaintext ตรง ๆ และ rehash เมื่อ login สำเร็จ
- **Session เดิม:**
  - Server: CacheService `tk_<uuid>` เก็บ `{id,role,username}` TTL 6 ชั่วโมง (`:138-139`)
  - Client: บังคับหมดอายุ 8 ชั่วโมง (`index.html:560-646`)
  - ระบบใหม่ใช้ตาราง `sessions` TTL 8 ชั่วโมงฝั่ง server
- **Roles:** `admin`, `officer` (`staff` คือ role เดิมที่ถูกแปลงเป็น `officer`) ส่วน "guest" คือผู้ใช้ที่ไม่ login และใช้ได้เฉพาะ API public

## 6. Integrations
- **Telegram (`:551`):** `sendMessage` แบบ `parse_mode: HTML` ส่งเมื่อมีคำขอใหม่, เปลี่ยนสถานะ, สต็อกต่ำ และปุ่มทดสอบ
- **Email (`GmailApp`):**
  - คำขอใหม่และสต็อกต่ำ ส่งไปที่ `NotifyEmail`
  - เปลี่ยนสถานะ ส่งไปที่ `Users.Email` ของผู้ขอ
  - **Workers ไม่มี GmailApp** ต้องเลือกผู้ให้บริการอีเมลในเฟส API
- **Drive:**
  - Subfolder `Logo`, `Banner`, `MaterialImages`, `MaterialFiles`, `RequestAttachments` ภายใต้ root
  - แชร์แบบ `ANYONE_WITH_LINK`/`VIEW`
  - URL รูปเป็น `https://lh3.googleusercontent.com/d/<id>`
- **Trigger:** `notifyLowStock_` ทุกวัน 08:00 ระบบใหม่ใช้ Cron `0 1 * * *` (UTC)
- **Cache เดิม:** sheet cache 300s และ `boot_v1` 600s ระบบใหม่ cache เฉพาะ bootstrap

## 7. ฟีเจอร์ฝั่ง Frontend
- **API bridge:** เรียกผ่าน wrapper เดียว `api(fn, ...args)` (`index.html:648-702`) เปลี่ยนเป็น `fetch('/api/...')` same-origin
- **QR code:**
  - `createQRCode` (`index.html:434`) เข้ารหัสข้อความแบบ `"code | name"`
  - `parseScanCode` (`index.html:2689`) แยกรหัสออกมา
  - `openScanner` (`index.html:2703`) สแกนผ่านกล้อง
- **พิมพ์ A4** (`doPrint` ที่ `index.html:4506`) มีฟอร์ม:
  - ใบขอเบิก
  - รายการพัสดุ
  - สต็อกต่ำ
  - บัญชีพัสดุ
  - ทะเบียนวัสดุคงเหลือ
  - Stock card (`index.html:3929`)
- **Upload:** `fileToPayload` (`index.html:799`) ส่ง base64 ทั้งไฟล์ ระบบใหม่เปลี่ยนเป็น resumable chunk upload
- **ข้อมูลที่ cache ฝั่ง browser:** bootstrap ใน localStorage และ token ใน localStorage/sessionStorage

## 8. Hazards ที่ระบบใหม่ต้องแก้
| ปัญหาเดิม | ที่มา | วิธีแก้ในระบบใหม่ |
|---|---|---|
| `google.script.run` ข้าม auth | `index.html:662` | REST route ที่ตรวจสิทธิ์ทุก route |
| อนุมัติซ้ำแล้วตัดสต็อกซ้ำ; อนุมัติเกินยอดแล้ว clamp เป็น 0 | `:1263`, `:1282` | `requests.stock_applied` + `UPDATE … WHERE stock_qty >= ?` และปฏิเสธถ้าไม่พอ |
| DocNo ชนกันได้ | `:295` | `doc_counters` + `UNIQUE(doc_no)` |
| รูปแบบวันที่ปนกัน (`T` กับช่องว่าง) | `nowIso_`, `cellVal_` | normalize ตอน import และใช้รูปแบบเดียว |
| actor ว่างใน delete | `:1061`, `:1303` | actor มาจาก session เสมอ |
| Telegram token เก็บ plaintext ใน Settings | `HEADERS.Settings` | Secret `TELEGRAM_BOT_TOKEN` |
| สร้าง temp spreadsheet ตอน export แล้วไม่ลบ | `:1805` | สร้าง XLSX ใน Worker เอง |
| เทียบรหัสผ่านด้วย `===` | `checkPw_` | เทียบแบบ constant-time และ rehash เป็น PBKDF2 |
| สร้างใบขอเบิกแบบ public พร้อม `UserID='GUEST'` | `:1112` | คงไว้ (เป็นฟีเจอร์เดิม) แต่เพิ่ม rate limit และ validation |
