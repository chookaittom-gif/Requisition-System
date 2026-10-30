# Handoff: ระบบเบิกจ่ายพัสดุ (2026-10-30)

**Written for:** Agent หรือ Developer ที่จะรับช่วงต่องานใน repository `D:\Webapp\ระบบเบิกจ่ายพัสดุ` (Cloudflare Workers + D1 Database + Static Frontend SPA)
**Repository:** https://github.com/chookaittom-gif/Requisition-System
**Branch:** `main`
**Latest Deployment:** Live at https://supply-requisition.chookait-tom.workers.dev

---

## 1. ข้อมูลสถาปัตยกรรมและโครงสร้างระบบ (Architecture Overview)

- **Production Stack:** Cloudflare Workers + Cloudflare D1 Database (SQLite at edge) + Single-Page Static Frontend
  - **Worker Name:** `supply-requisition` (Account ID: `17abb4914aa1cbfcf03edddedbaea672`)
  - **D1 Database:** `ims_db` (Database ID: `4c98cc16-6008-4880-9d38-99544c79b838`)
  - **Frontend UI:** `cloudflare/public/index.html` ไฟล์เดียว (Tailwind CSS CDN, Vanilla JS, FontAwesome, SheetJS/ExcelJS)
  - **Backend API:** `cloudflare/src/index.ts` และโมดูล RPC ใน `cloudflare/src/api/*.ts`
- **CI/CD Pipeline (GitHub Actions):**
  - Workflow: `.github/workflows/deploy.yml` ทำงานอัตโนมัติทุกครั้งที่ `push` ขึ้น branch `main`
  - ตรวจสอบ Typecheck + Vitest + D1 Migrations Apply + Wrangler Deploy
  - สคริปต์สั่ง Deploy แบบ Local: `deploy.ps1` หรือ `deploy.cmd` (รัน `deploy-cloudflare.ps1`)

---

## 2. สิ่งที่ทำสำเร็จใน Session ล่าสุด (2026-10-30 Draft Auto-Save 30m & Partial Request Approval)

### 1. feat(frontend): Auto-save แบบฟอร์มขอเบิก 30 นาที (`req_form_draft_v1`)
- บันทึกข้อมูลร่างฟอร์มลง `localStorage` ทันทีเมื่อมีการพิมพ์หรือแก้ไขรายการ (`saveReqDraft()`)
- กำหนดเวลาหมดอายุ 30 นาที (`DRAFT_TTL_MS = 30 * 60 * 1000`)
- เมื่อเปิดฟอร์มหรือกลับมาที่หน้าเว็บ หากมีร่างที่ยังไม่หมดอายุ ระบบจะโหลดข้อมูลกลับมาให้อัตโนมัติ พร้อมแสดงแถบแจ้งเตือนสีส้มอ่อนและปุ่ม "ล้างร่าง" (`clearReqDraft()`)
- ล้างข้อมูลร่างอัตโนมัติเมื่อกด "ล้างฟอร์ม" หรือส่งคำขอเบิกสำเร็จ

### 2. feat(requests): ระบบอนุมัติบางส่วน (Partial Approval)
- **Database Schema:** `cloudflare/migrations/0010_partial_approval.sql`
  - เพิ่ม `is_partial INTEGER NOT NULL DEFAULT 0` ในตาราง `requests`
  - เพิ่ม `approved_qty REAL` ในตาราง `request_items`
- **Backend & Inventory Logic:**
  - `applyRequestStock`: ตัดและคืนสต็อกตาม `COALESCE(approved_qty, qty)` หาก `effective_qty = 0` จะไม่ตัดสต็อก
  - `apiUpdateRequestStatus`: รองรับส่งรายการ `Items: [{ ID, Code, ApprovedQty }]` เมื่อกดอนุมัติ พร้อมคำนวณ `ItemCount`, `TotalAmount` และตั้งค่า `is_partial` ตามจริง
  - กรณีเปลี่ยนสถานะกลับ (Rollback) เช่น ยกเลิกหรือเปลี่ยนสถานะ คืนสต็อกตามจำนวนที่เคยตัดจริง และ reset `approved_qty`
- **Frontend UI:**
  - เพิ่ม Modal อนุมัติแบบกำหนดรายการ (`openApproveModal(id)`): มี Checkbox เลือกแต่ละรายการ และ Input ปรับจำนวนที่อนุมัติ (0 ถึงจำนวนที่ขอ)
  - คำนวณสรุปจำนวนรายการและยอดเงินรวมที่อนุมัติแบบเรียลไทม์
  - เพิ่ม Badge "อนุมัติบางส่วน" สีส้ม (`stBadge`) ในตารางคำขอเบิก
  - ปรับหน้ารายละเอียดคำขอเบิก (`reqDetail`) แสดงยอดที่ขอเบิกและยอดที่อนุมัติจริง
- **Notifications:**
  - LINE Flex (`cloudflare/src/lib/lineFlex.ts`) และ Telegram (`cloudflare/src/lib/telegram.ts`):
  - แจ้งเตือนระบุ "(อนุมัติบางส่วน)" พร้อมแจกแจงรายการและจำนวนที่อนุมัติชัดเจน

---

## 3. สรุปประวัติการพัฒนาก่อนหน้า (2026-10-29)

### 1. fix(inventory): แก้ปัญหายอดสต็อกการ์ด x2 จากยอดยกมา
- **ปัญหาเดิม:** เมื่อเพิ่มพัสดุใหม่ด้วยยอดยกมา (เช่น 6) แต่ไม่ได้ระบุยอดสั่งซื้อ (`OrderQty: 0`) ระบบกลับสร้างทั้งรายการยอดยกมาใน `opening_balances` และสร้าง movement `IN 'จัดซื้อ'` ซ้ำใน `stock_movements` ส่งผลให้หน้าสต็อกการ์ดคำนวณยอดยกมา 6 + ยอดจัดซื้อ 6 = กลายเป็น 12
- **การแก้ไข:**
  - `cloudflare/src/api/materials.ts` (`create`): เพิ่มเงื่อนไขตรวจสอบ `initialOrderQty > 0` ก่อนสร้าง movement จัดซื้อ ป้องกันการสร้าง synthetic movement เมื่อมียกมาอย่างเดียว
  - `cloudflare/src/api/reports.ts` (`stockCard`): เพิ่มฟิลเตอร์ละเว้น movement จัดซื้อที่ไม่มี `purchase_orders` จริงและวันที่ตรงกับยอดยกมา เพื่อป้องกันข้อมูลเก่าคำนวณเบิ้ล 2 เท่า
- **ผลลัพธ์:** สต็อกการ์ดแสดงยอดยกมา 6 คงเหลือ 6 ถูกต้องตามสต็อกจริง ไม่เกิดยอดเบิ้ล

### 2. feat(dashboard): ปรับปรุงแดชบอร์ดตามโครงสร้างหมวดหมู่จริง
- **การปรับปรุง:**
  - ลบตารางรายการพัสดุ (`matTable`) และปุ่มพิมพ์ (`btnPrintMat`) ออกจากแดชบอร์ดตามที่ผู้ใช้ร้องขอ
  - เพิ่มการ์ดสรุปจำนวนสต็อกคงเหลือ 6 หมวดหมู่วัสดุหลัก:
    - วัสดุสำนักงาน, วัสดุงานบ้านงานครัว, วัสดุงานช่าง, วัสดุการเกษตร, วัสดุคอมพิวเตอร์, วัสดุจราจร
  - เพิ่ม Bar Chart (`chCategory`) แสดงเปรียบเทียบยอดคงเหลือแยกตามหมวดหมู่ชัดเจน
  - ปรับข้อมูลใน `cloudflare/src/api/reports.ts` (`apiGetAdminDashboard`) ให้คำนวณ `byCategory` และส่งข้อมูลหมวดหมู่เข้าสู่กราฟแท่ง

### 3. feat(purchase-order): ปรับโครงสร้างคอลัมน์ใบสั่งซื้อทั้งเว็บและ Excel
- **การปรับปรุง:**
  - ลบคอลัมน์ "หมายเหตุ" ออกจากตารางใบสั่งซื้อหน้าเว็บและ Excel
  - สลับคอลัมน์ชื่อรายการมาอยู่ก่อนจำนวน/หน่วย:
    - รูปแบบใหม่: `[ที่/ลำดับที่ | รายการ | จำนวน/หน่วย | ราคาต่อหน่วย | จำนวนเงิน]` (รวม 5 คอลัมน์)
  - ปรับหน้า Excel (`exportPurchaseOrderXlsx`) ให้เหลือ 5 คอลัมน์ (A ถึง E), จัดลำดับคอลัมน์สอดคล้องกับหน้าเว็บ, ปรับ Print Area เป็น `A1:E...` พอดีหน้ากระดาษ A4

### 4. feat(requests & notifications): ลบสถานะ "ปฏิเสธ" (REJECTED) ออกจากทุกระบบ
- **การปรับปรุง:**
  - ปิดการส่งข้อความแจ้งเตือนคำขอที่ถูกปฏิเสธใน Telegram (`cloudflare/src/api/admin.ts`)
  - ลบการ์ดสรุปสถานะ "ปฏิเสธ" และตัวนับ/ตาราง/ปุ่มปฏิเสธในทุกหน้าจอ:
    - หน้าแดชบอร์ด (`viewAdminDash`): ลบการ์ดปฏิเสธ และปรับ Doughnut Chart เหลือ 2 สถานะ (อนุมัติแล้ว, รออนุมัติ)
    - หน้าคำขอเบิกสำหรับผู้ดูแลระบบ (`viewRequests`): ลบการ์ดสถานะปฏิเสธ, ลบแท็บ/ตารางรายการปฏิเสธ, และนำปุ่มปฏิเสธออก
    - หน้าติดตามสถานะและคำขอเบิกของผู้ใช้ (`viewMyRequests`, `viewTeacherDash`, `viewPublicTrack`): ปรับการแสดงผลให้มีเฉพาะสถานะรออนุมัติและอนุมัติแล้ว

### 5. chore(skills): ติดตั้ง Skill repomix-explorer
- ติดตั้ง `repomix-explorer` ลงใน `~/.agents/skills/repomix-explorer` และ `~/.gemini/config/skills/repomix-explorer` สำหรับการวิเคราะห์และสรุปโค้ดเบสขนาดใหญ่

---

## 3. สิ่งที่ทำสำเร็จใน Session ก่อนหน้า (2026-10-29 Audit Log Actor Role Badge & Task Observer Review)

### 1. feat(ui): Audit Log Actor Role Badge
- **ปัญหาเดิม:** ในตาราง Audit Log เมื่อผู้ดูแลระบบ (Admin) เข้าสู่ระบบ คอลัมน์ `Entity` แสดงเป็น `User` ทำให้เกิดความสับสนว่าเป็นผู้ใช้ทั่วไปเข้าใช้งานหรือไม่
- **การออกแบบ & แก้ไข (ตามผลสรุป /grill-me และ /oil-ui-pro แนวทางที่ 1):**
  - คงค่า `Entity` เป็น `User` ในระดับ Database ตาม Domain Model สากล เพื่อป้องกันผลกระทบต่อ API Contract และ Test assertion
  - ใน [cloudflare/public/index.html](file:///d:/Webapp/ระบบเบิกจ่ายพัสดุ/cloudflare/public/index.html) (`viewAuditLog`):
    - ดึงรายชื่อผู้ใช้ `apiGetUsers` ควบคู่กัน (และแคชไว้ใน `S.cache.users`)
    - สร้าง `getActorRole` และ `actorBadge` เพื่อแสดง Badge สิทธิ์กำกับไว้ที่คอลัมน์ **ผู้ทำ (Actor)** ชัดเจน:
      - ผู้ดูแลระบบ: Badge สีม่วง `[ผู้ดูแลระบบ]` พร้อมไอคอนโล่
      - เจ้าหน้าที่: Badge สีฟ้า `[เจ้าหน้าที่]`
      - ผู้ใช้ทั่วไป: Badge สีเทา `[ผู้ใช้]`
    - ปรับปรุงการค้นหา (`filterAud`) ให้สามารถพิมพ์ `admin`, `ผู้ดูแลระบบ`, หรือ `เจ้าหน้าที่` เพื่อกรองเฉพาะกิจกรรมตามสิทธิ์ได้ทันที
- **ผลการทดสอบ:** Vitest 197 ผ่านครบ 100%

### 2. chore(tooling & governance): Task Observer Review, Graft & Repomix Setup
- **Graft Context Graph:** ติดตั้งและสร้างกราฟความสัมพันธ์โค้ดเบส 288 โหนด 761 edges พร้อมตรวจสอบความสดใหม่ (`graft check: OK`)
- **Token Management:**
  - สร้าง [repomix.config.json](file:///d:/Webapp/ระบบเบิกจ่ายพัสดุ/repomix.config.json) ตัดคอมเมนต์และบรรทัดว่างสำหรับแพ็คโค้ด
  - เปิดใช้งาน RTK Proxy และ Caveman Lite mode เพื่อประหยัด Output Tokens
- **Task Observer Governance:**
  - ทบทวน observation log ค้างและปรับสถานะเป็น `actioned` 2 รายการ:
    - 0002 (Schema Migration Backfill Rule) -> บันทึกเป็น Rule 5 ใน [AGENTS.md](file:///d:/Webapp/ระบบเบิกจ่ายพัสดุ/AGENTS.md)
    - 0003 (Windows CLI & RTK Fallback Rule) -> บันทึกเป็น Rule 6 ใน [AGENTS.md](file:///d:/Webapp/ระบบเบิกจ่ายพัสดุ/AGENTS.md)
  - อัปเดต `skill-observations/last-review-date.txt` เป็น `2026-10-29` และบันทึก `checkpoints.log`

---

## 3. สิ่งที่ทำสำเร็จใน Session ก่อนหน้า (2026-10-28 Sync Inventory Values & Rules Optimization)

### 1. fix(inventory): ซิงค์ตัวเลขคงคลังและแจ้งเตือนพัสดุใกล้หมดให้ตรงกันทั้ง 4 แท็บ
- **ปัญหาเดิม:**
  - ตัวเลขมูลค่าคงเหลือไม่ตรงกัน 3 ค่า (แดชบอร์ด/บัญชีพัสดุ = 28,081 บ., จัดการพัสดุ = 27,831 บ., ทะเบียนพัสดุ = 27,895 บ.) เนื่องจากหน้าจัดการพัสดุคิดจาก `UnitPrice * StockQty` เดี่ยว และทะเบียนพัสดุไม่คิดราคาตามล็อตจริง FIFO
  - จำนวนแจ้งเตือนพัสดุใกล้หมดแสดง 10 รายการในแดชบอร์ด/จัดการพัสดุ แต่แสดง 8 รายการในบัญชีพัสดุ
- **การแก้ไข:**
  - `cloudflare/src/api/materials.ts` (`listMaterials`): ส่ง `RemainAmount` ที่คำนวณจากยอดรวมตามล็อตจริง (`material_lots`) สำหรับพัสดุแต่ละรายการ
  - `cloudflare/public/index.html` (`viewMaterials`): ปรับยอดรวม `totalValue` ให้รวมจาก `RemainAmount` เพื่อให้ได้มูลค่าตามล็อตจริงตรงกับแดชบอร์ด (28,081.00 บาท)
  - `cloudflare/src/api/reports.ts` (`apiGetInventoryReport`): ดึง `lotRemainMap` และคำนวณมูลค่าคงเหลือ `Amount` อิงตามล็อตจริง FIFO ให้ตรงกัน (28,081.00 บาท)
  - `cloudflare/src/api/reports.ts` (`inventoryAccount`): ซิงค์สรุป `lowStock` ให้คำนวณจากสถานะสต็อกจริง (10 รายการ) เมื่อไม่ได้ระบุช่วงวันที่ย้อนหลัง
- **ผลลัพธ์:** ทั้ง 4 แท็บ (แดชบอร์ด, ทะเบียนพัสดุคงเหลือ, บัญชีพัสดุ, จัดการพัสดุ) แสดงมูลค่าคงเหลือ **28,081.00 บาท** และแจ้งเตือนพัสดุใกล้หมด **10 รายการ** ตรงกันทั้งหมด 100%

### 2. chore(rules): ลด Token ในระบบและลบ Rules ซ้ำซ้อน
- ลบ `GEMINI.md` ใน root โปรเจกต์ เนื่องจากซ้ำซ้อนกับคำสั่ง Graft ใน `AGENTS.md` 100%
- ปรับปรุง Global Rule (`~/.gemini/GEMINI.md`) ให้ Lean ตัดคำบรรยายและรายชื่อ Framework ฟุ่มเฟือย ขนาดลดลง 67.5% (ประหยัด ~2,700 tokens ต่อคำขอ)

---

## 3. สิ่งที่ทำสำเร็จใน Session ก่อนหน้า (2026-10-28 FIFO Lot Inventory & UI Workflow)

### 1. feat(inventory): FIFO Lot tracking for material price changes
- **Database Migration:**
  - สร้าง `cloudflare/migrations/0009_material_lots.sql` เพิ่มตาราง `material_lots` บันทึกล็อตต้นทุนราคาพัสดุ (`unit_price`, `initial_qty`, `remaining_qty`, `status`) พร้อม backfill สต็อกเดิมทั้งหมดอัตโนมัติ
- **Backend FIFO Deduction & Price Transition:**
  - `cloudflare/src/api/materials.ts`: ปรับ `apiPurchaseMaterials` ให้รับ `UnitPrice` ที่จัดซื้อจริง หากราคาต่างจากเดิมจะบันทึกเป็นล็อตราคาใหม่ และหากสต็อกเดิมเป็น 0 จะอัปเดตราคาพัสดุทันที
  - `cloudflare/src/api/requests.ts`: ใน `applyRequestStock` เมื่ออนุมัติใบขอเบิก จะตัดจ่ายสต็อกตามลำดับ FIFO (ตัดล็อตราคาเก่าให้หมดก่อน) เมื่อล็อตเก่าหมดเกลี้ยง (`status = 'DEPLETED'`) ระบบจะอัปเดตราคาหลัก (`materials.unit_price`) สลับเป็นราคาของล็อตใหม่อัตโนมัติ
  - `cloudflare/src/api/reports.ts`: คำนวณมูลค่าคงคลังคงเหลือจริงตามผลรวมของทุกล็อตที่ยังคงเหลือ
- **Frontend UI Enhancements:**
  - `cloudflare/public/index.html`:
    - เพิ่มช่อง "ราคาต่อหน่วย (บาท)" ในฟอร์มจัดซื้อพัสดุเพิ่ม พร้อมดึงราคาเดิมเป็น Default และแสดงกล่องข้อความแจ้งเตือนอัตโนมัติเมื่อราคาเปลี่ยนแปลง
    - ในตารางรายการพัสดุ แสดงราคาของล็อตปัจจุบันที่กำลังตัดจ่าย และแสดง Badge `[ล็อตถัดไป xx.xx บ.]` สีฟ้า เมื่อมีล็อตใหม่รอจ่ายอยู่
- **Testing:**
  - เพิ่ม Vitest 2 เคสใน `cloudflare/test/materials.test.ts` ทดสอบการซื้อต่างราคา การออกล็อต และการตัดสต็อกแบบ FIFO ข้ามล็อตจนสลับราคาพัสดุอัตโนมัติ (ผ่าน 100%)

---

## 3. สิ่งที่ทำสำเร็จใน Session ก่อนหน้า (2026-10-27 Night Session)

### 1. feat(stock-card): Display opening balance in "รับ" (In) column
- ในฟังก์ชัน `stockCard` (`cloudflare/src/api/reports.ts`):
  - แถวแรกของสต็อกการ์ด (`ยอดยกมา`) ส่งค่า `inQty: periodOpening` เพื่อให้ตารางสต็อกการ์ดแสดงตัวเลขยอดยกมาลงในคอลัมน์ "รับ" (In)
  - อัปเดต CSV export ของ Stock Card ให้แสดงตัวเลขยอดยกมาในคอลัมน์ "รับ" เช่นกัน

### 2. feat(materials): Sync plug 5m stock to 2 & auto-sync opening balances
- **Database Migration:**
  - เพิ่ม `cloudflare/migrations/0008_sync_plug_stock_and_notify_channels.sql` ซิงก์สต็อกสำหรับ `001-0001` (ปลั๊กไฟ 5 ม. BLL PLUG B75 WHITE) ให้ `stock_qty = 2` และ `opening_qty = 2`
- **ผลลัพธ์การแสดงผล:**
  - **แท็บแดชบอร์ด:** แสดงคงเหลือ `2 อัน` สถานะเปลี่ยนเป็น `ใกล้หมด` (เนื่องจาก 2 <= จุดสั่งซื้อ 3)
  - **แท็บพัสดุหมด/ใกล้หมด:** ย้ายจากกล่องสีแดง (หมดสต็อก) ไปอยู่กล่องสีส้ม (ใกล้หมด) คงเหลือ `2` จุดสั่งซื้อ `3`
  - **สต็อกการ์ด Dropdown:** แสดง `(คงเหลือ: 2 อัน)` ตรงกัน 2 ทุกจุด
- **Backend Auto-sync:**
  - ปรับปรุง `apiSaveOpeningBalance` (`cloudflare/src/api/materials.ts`) ให้คำนวณและอัปเดต `materials.stock_qty` ให้สัมพันธ์กับยอดยกมาและประวัติการเคลื่อนไหวอัตโนมัติ

### 3. feat(settings): Toggle checkboxes for LINE/Telegram & remove Email field
- **Database Schema:**
  - เพิ่มคอลัมน์ `notify_telegram` และ `notify_line` ในตาราง `settings`
- **Backend Notification Gating:**
  - อัปเดต `notifyHooks.onNewRequest`, `notifyHooks.onStatusChange`, และ `runLowStockCron` ให้ตรวจสอบการเปิดใช้งานของแต่ละช่องทางแยกกันอิสระ
- **Frontend Settings UI:**
  - ลบช่องกรอก "อีเมลรับแจ้งเตือน"
  - เปลี่ยนหัวข้อเป็นการแจ้งเตือน `(Telegram + LINE)`
  - เพิ่ม Checkbox สวิตช์เปิด-ปิดช่องทาง Telegram และ LINE อิสระจากกัน

### 4. refactor(settings): Remove legacy Google Sheets schema migration card
- ลบกล่องและปุ่ม "อัปเดตโครงสร้างชีต (Schema Migration)" ออกจากหน้าตั้งค่าระบบ
- เนื่องจากระบบย้ายมาใช้ Cloudflare D1 Database ซึ่งจัดการ Migration ผ่าน CI/CD (`wrangler d1 migrations apply`) แทนการปรับแก้ชีตแล้ว

### 5. feat(notifications): Add rejected request notification for Telegram and LINE
- เพิ่มการแจ้งเตือนกรณี "ไม่อนุมัติ/ปฏิเสธคำขอ (REJECTED)" ทั้ง Telegram (`rejectedRequestText`) และ LINE (`rejectedRequestFlex`)
- ระบุเหตุผลที่ไม่อนุมัติ (RejectReason) พร้อมข้อมูลใบขอเบิก
- ปรับข้อความ Checkbox ในหน้าตั้งค่าระบบเป็น "แจ้งเมื่ออนุมัติ / ไม่อนุมัติ"

---

## 3. สิ่งที่ทำสำเร็จใน Session ก่อนหน้า (2026-10-27 Earlier Session)

### 1. `83b1b7f` feat(materials): Move opening balance management to materials tab and sync with opening_balances
- ปรับปรุง UX การจัดการยอดยกมาไปไว้ที่แท็บจัดการพัสดุ (`matModal` + `openMaterialOpeningBalanceModal`)
- Sync ยอดยกมาลงตาราง `opening_balances` อัตโนมัติ

### 2. `555a6e4` feat(ui): lock material, shop, and user modals with static backdrop and shake animation
- กำหนดค่า `staticBackdrop: true` และ shake animation เมื่อคลิกพื้นหลัง Modal ป้องกันข้อมูลสูญหาย

---

## 4. สถานะการทดสอบและ Production ล่าสุด (Current Verified Status)

- **Test Suite Results (Vitest):**
  - Worker Tests: **161 passed** (10 test files)
  - Node Tests: **37 passed** (2 test files)
  - **รวมทั้งสิ้น: 198 passed (100% PASS)**
- **TypeScript Typecheck:** 0 errors
- **Git State:**
  - Branch: `main`

---

## 5. Suggested Skills สำหรับรอบถัดไป (Recommended Skills for Next Agent)

1. **`caveman` (lite)**: รักษารูปแบบการตอบที่กระชับ ตรงประเด็น ประหยัด token
2. **`rtk`**: ใช้เป็น prefix รันคำสั่งเชลล์บน Windows (เช่น `rtk git status`, `rtk rg`) เพื่อกรอง output
3. **`task-observer`**: ตรวจสอบ friction และบันทึกข้อสังเกตลง `skill-observations/`
4. **`graphify-windows` / `graft`**: สืบค้นสถาปัตยกรรมและจุดอ้างอิงโค้ดผ่าน Knowledge Graph
5. **`ponytail`**: ยึดหลัก Minimal Change, ไม่สร้าง Abstraction ฟุ่มเฟือย, แก้ไขตรงจุด Root Cause เท่านั้น
