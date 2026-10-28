# Handoff: ระบบเบิกจ่ายพัสดุ (2026-10-28)

**Written for:** Agent หรือ Developer ที่จะรับช่วงต่องานใน repository `D:\Webapp\ระบบเบิกจ่ายพัสดุ` (Cloudflare Workers + D1 Database + Static Frontend SPA)
**Repository:** https://github.com/chookaittom-gif/Requisition-System
**Branch:** `main`
**Latest Deployment:** Version `51a5d7f9-1677-4c95-8c0b-47ddf42a0295` (Commit `0267be2`) — Live at https://supply-requisition.chookait-tom.workers.dev

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

## 2. สิ่งที่ทำสำเร็จใน Session ล่าสุด (2026-10-28 FIFO Lot Inventory & UI Workflow)

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
  - Worker Tests: **160 passed** (10 test files)
  - Node Tests: **37 passed** (2 test files)
  - **รวมทั้งสิ้น: 197 passed (100% PASS)**
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
