# Data Mapping — Google Sheets → D1

ใช้คู่กับ `migrations/0001_init.sql` ทุกคอลัมน์ใน `HEADERS` (`Code/code.gs:29-53`) ต้องมีปลายทางใน D1 หรือมีเหตุผลกำกับว่าทำไมไม่มี

## กฎทั่วไปสำหรับ importer
- **Map ตามชื่อ header ไม่ใช่ตามตำแหน่ง** เพราะลำดับคอลัมน์ใน sheet จริงต่างจาก `HEADERS` (ดูตาราง Users และ Materials ด้านล่าง)
  - ข้อยกเว้นคือ Users ที่ header ใน sheet ไม่ครบ ดูหัวข้อ Users
- **Primary key ใช้ `ID` เดิม** และเขียนแบบ `INSERT … ON CONFLICT(id) DO UPDATE` จึง import ซ้ำได้โดยไม่เกิดแถวซ้ำ
- **ข้ามแถวที่ `ID` ว่าง** เหมือน `readAll_` (`code.gs:230`)
- **วันที่:**
  - แปลง `YYYY-MM-DDTHH:MM:SS` ให้เป็น `YYYY-MM-DD HH:MM:SS`
  - ค่า Date ของ Sheets ให้ format ใน Asia/Bangkok
  - คอลัมน์วันล้วน (`request_date`, `purchase_date`) ใช้ `YYYY-MM-DD`
- **ตัวเลข:** ค่าว่างหรือไม่ใช่ตัวเลขเป็น `0` เหมือน `cellVal_` (`code.gs:168`)
- **ข้อความ:** trim และแทน ` ` ด้วยช่องว่างปกติ
- **บันทึกการ import:** บันทึก `import_runs` ต่อ sheet (rows_read / rows_written) แล้วเทียบจำนวนแถวก่อนและหลัง
- **ห้ามแก้ไขต้นฉบับ:** อ่านจากไฟล์ export ของ `SHEET_ID` เท่านั้น ไม่เขียนกลับไปที่ Sheet

## ลำดับ import (ตาม foreign key)
`users` → `categories` → `materials` → `requests` → `request_items` → `purchases` → `stock_movements` → `opening_balances` → `audit_log` → `settings`

## Users
**ปัญหา:** header ใน sheet จริงมี 8 ชื่อ (`ID, Username, Password, FullName, Role, Position, CreatedAt, UpdatedAt`) แต่ข้อมูลมี 10 ค่าตาม `HEADERS.Users` ถ้า map ตาม header ใน sheet วันที่จะเลื่อนผิดช่อง
**วิธีแก้:** สำหรับ sheet นี้ให้ map **ตามลำดับ `HEADERS.Users`** และตรวจด้วยมือก่อน import จริง

| Sheet (HEADERS) | D1 `users` | หมายเหตุ |
|---|---|---|
| ID | id | |
| Username | username | trim; UNIQUE แบบตรงตัวพิมพ์ |
| Password | password_hash | เก็บ `sha256$…` ตามเดิม ถ้าเป็น plaintext ให้ hash ด้วย `PW_SALT` ก่อน import ห้ามเก็บ plaintext |
| FullName | full_name | |
| Role | role | `staff` → `officer` เหมือน `apiRunSchemaMigration` |
| Position | position | |
| Department | department | |
| Email | email | |
| CreatedAt | created_at | |
| UpdatedAt | updated_at | |

## Categories
| Sheet | D1 `categories` |
|---|---|
| ID, Name, CreatedAt | id, name (UNIQUE), created_at |

ชื่อหมวดที่ซ้ำกันต้องรวมก่อน import ถ้ามีหมวดที่ใช้ใน `Materials.Category` แต่ไม่อยู่ใน Categories ให้รายงานไว้ ไม่ต้องสร้างให้อัตโนมัติ

## Materials
**ปัญหา:** ลำดับ header ใน sheet คือ `…Category, ImageUrl, FileUrl, CreatedAt, UpdatedAt, (ว่าง), MaterialType, SizeSpec, StorageLocation` ซึ่งต่างจาก `HEADERS` และคอลัมน์ N ไม่มีชื่อ **ให้ map ตามชื่อ** และข้ามคอลัมน์ที่ไม่มีชื่อ

| Sheet | D1 `materials` | หมายเหตุ |
|---|---|---|
| ID | id | |
| Code | code | UNIQUE; ถ้าว่างต้องสร้างใหม่ |
| Name | name | |
| Unit | unit | |
| UnitPrice | unit_price | ≥ 0 |
| StockQty | stock_qty | ≥ 0; ถ้าติดลบต้องรายงาน ห้าม clamp เงียบ ๆ |
| MinQty | min_qty | |
| OpeningQty | opening_qty | |
| Category | category | เก็บเป็นชื่อหมวด (TEXT) ไม่มี FK |
| MaterialType | material_type | |
| SizeSpec | size_spec | |
| StorageLocation | storage_location | |
| ImageUrl | image_url | URL Drive เดิมยังใช้ได้ |
| FileUrl | file_url | |
| CreatedAt, UpdatedAt | created_at, updated_at | |

## Requests
| Sheet | D1 `requests` | หมายเหตุ |
|---|---|---|
| ID, DocNo | id, doc_no | DocNo ต้องไม่ซ้ำ ถ้าซ้ำ (เกิดได้จาก `genDocNo_`) ต้องรายงานและแก้ด้วยมือ |
| RequestDate | request_date | `YYYY-MM-DD` |
| UserID | user_id | `GUEST` หรือ id ที่ไม่มีใน users → `NULL` |
| FullName, Position, Department, Purpose, Note, AttachUrl | ชื่อเดียวกันแบบ snake_case | snapshot ของผู้ขอ |
| Status | status | ต้องเป็น `PENDING` / `APPROVED` / `REJECTED` เท่านั้น |
| RejectReason, ApprovedDate, ApprovedBy | reject_reason, approved_date, approved_by | |
| TotalAmount, ItemCount | total_amount, item_count | |
| — | stock_applied | `1` ถ้า Status = `APPROVED` ไม่งั้น `0` |
| CreatedAt, UpdatedAt | created_at, updated_at | |

## RequestItems
| Sheet | D1 `request_items` | หมายเหตุ |
|---|---|---|
| ID, RequestID | id, request_id | item ที่ request ไม่มีอยู่ (orphan) ต้องรายงานและข้าม |
| MaterialID | material_id | id ที่ไม่มีใน materials → `NULL` (ยังมี snapshot code/name) |
| Code, Name, Unit, Qty, UnitPrice, TotalPrice, Remark | code, name, unit, qty, unit_price, total_price, remark | qty > 0 |

## Purchases
`ID, MaterialID, Code, Name, Qty, UnitPrice, Amount, PurchaseDate, Note, Actor, CreatedAt` → ชื่อเดียวกันแบบ snake_case โดย `purchase_date` เป็น `YYYY-MM-DD` และ MaterialID ที่ไม่มีอยู่ → `NULL`

## StockMovements
`ID, MaterialID, Code, Name, Type, Qty, BeforeQty, AfterQty, RefDoc, Note, Actor, CreatedAt` → snake_case โดย Type ต้องเป็น `IN` / `OUT` / `ADJUST`

## OpeningBalances
`ID, MaterialID, FiscalYear, OpeningQty, SetBy, CreatedAt, UpdatedAt` → snake_case
- `fiscal_year` เป็นเลข พ.ศ.
- `(material_id, fiscal_year)` ต้องไม่ซ้ำ

## AuditLog
`ID, Action, Entity, EntityID, Detail, Actor, CreatedAt` → snake_case (append-only)

## Settings
Sheet มีแถวเดียว (แถว 2) import เข้า `settings` ที่ `id = 1`

| Sheet | D1 `settings` | หมายเหตุ |
|---|---|---|
| SchoolName, Affiliation, LogoUrl, Address, Phone, BannerUrl | snake_case | |
| UpdatedAt | updated_at | |
| NotifyEmail | notify_email | คั่นด้วยจุลภาค |
| TelegramChatId | telegram_chat_id | |
| NotifyOnNewRequest, NotifyOnStatusChange, NotifyLowStock | notify_on_new_request, notify_on_status_change, notify_low_stock | ค่าที่ไม่ใช่ `YES` → `NO` |
| **TelegramBotToken** | **ไม่มีใน D1** | ย้ายไปเป็น Secret `TELEGRAM_BOT_TOKEN` ด้วย `wrangler secret put`; หน้า Settings เดิมให้ admin แก้ token ได้ **ระบบใหม่ต้องตัดสินใจ flow นี้ก่อนทำ API** |

## ตารางใหม่ (ไม่มีใน sheet)
| ตาราง | ใช้ทำ |
|---|---|
| `sessions` | Session ฝั่ง server เก็บ SHA-256 ของ token, TTL 8 ชั่วโมง |
| `doc_counters` | เลข DocNo รายวันแบบ atomic |
| `drive_files` | Metadata ของไฟล์ใน Drive (ไม่เก็บ binary) |
| `import_runs` | บันทึกจำนวนแถวต่อการ import |

## `ทะเบียนวัสดุคงเหลือ 2569.xls` (ข้อมูลพัสดุจริงแบบเก่า)
ไฟล์นี้ไม่ได้อยู่ในรูปแบบ `HEADERS` จึงต้องมี importer แยก
- **ตำแหน่ง header:** ชีตรายหมวด (วัสดุสำนักงาน, วัสดุคอมพิวเตอร์, วัสดุงานช่าง, วัสดุงานบ้าน งานครัว, วัสดุการเกษตร, วัสดุจราจร) มี header ที่**แถว 5** ดังนี้
  `ลำดับที่, ประเภทวัสดุ, ชนิดวัสดุ, รหัสวัสดุ, รายการวัสดุ, ขนาด/ลักษณะ, หน่วยนับ, ราคาต่อหน่วย, ยอดยกมา, จำนวนรับ, จำนวนเบิก, ยอดคงเหลือ, จำนวนเงิน, สถานที่จัดเก็บ`
- **Mapping ที่เสนอ:**
  - ชนิดวัสดุ → `category`
  - ประเภทวัสดุ → `material_type`
  - รายการวัสดุ → `name`
  - ขนาด/ลักษณะ → `size_spec`
  - หน่วยนับ → `unit`
  - ราคาต่อหน่วย → `unit_price`
  - ยอดคงเหลือ → `stock_qty`
  - ยอดยกมา → `opening_balances.opening_qty`
  - สถานที่จัดเก็บ → `storage_location`
- **รหัสวัสดุว่างทุกแถว** ต้องกำหนดรูปแบบ code ใหม่ (เช่นใช้ prefix ตามหมวด) **ต้องให้เจ้าของระบบอนุมัติ**
- **ปีงบในแต่ละชีตไม่ตรงกัน** (2567 / 2568) ต้องยืนยันว่าใช้ปีไหนเป็นยอดยกมา
- **ชีต `Stock card`** มี header 2 ชั้น (แถว 3-4) และยอดจ่ายรายวัน ใช้เป็นข้อมูลอ้างอิงเท่านั้น ไม่ต้อง import เป็น movements

## Backup / Rollback (ก่อน import ลง D1 remote)
1. Backup: `npx wrangler d1 export DB --remote --output backups/pre-import-<date>.sql`
2. Import เข้า local ก่อน แล้วตรวจจำนวนแถวและ `PRAGMA foreign_key_check`
3. Import เข้า remote
4. Rollback: ใช้ D1 Time Travel `npx wrangler d1 time-travel restore DB --timestamp=<ก่อน import>` หรือ restore จากไฟล์ backup
