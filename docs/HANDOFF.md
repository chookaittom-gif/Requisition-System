# Handoff: ระบบเบิกจ่ายพัสดุ (2026-11-03)

**Written for:** Agent หรือ Developer ที่จะรับช่วงต่องานใน repository `D:\Webapp\ระบบเบิกจ่ายพัสดุ` (Cloudflare Workers + D1 Database + Static Frontend SPA)
**Repository:** https://github.com/chookaittom-gif/Requisition-System
**Branch:** `main`

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

## 2. สิ่งที่ทำสำเร็จใน Session ล่าสุด (2026-11-04 Admin Revert to Pending & Thai Audit Log)

### feat(requisition & audit): ระบบส่งกลับเพื่อแก้ไขสำหรับ Admin และแสดงชื่อภาษาไทยใน Audit Log
- **ความต้องการ:**
  1. แก้ไขรายการพัสดุสำหรับ Admin: เมื่อใบขอเบิกอนุมัติแล้ว (`APPROVED`) หากพบข้อผิดพลาด ให้มีระบบ "ส่งกลับเพื่อแก้ไข (Revert to Pending)" เฉพาะบทบาท Admin เพื่อคืนสต็อกและล็อตพัสดุเข้าคลังอัตโนมัติอย่างถูกต้องตามหลักบัญชีและ FIFO พร้อมระบุเหตุผลลง Audit Log จากนั้นปลดล็อกฟอร์มให้แก้รายการ/จำนวนได้ทันที
  2. แสดงชื่อผู้ทำเป็นภาษาไทยใน Audit Log: คอลัมน์ "ผู้ทำ" แสดงชื่อ-นามสกุลภาษาไทย (`FullName`) ตัวหนาเป็นหลัก พร้อม `@username` ตัวเล็กกำกับด้านล่าง และเพิ่ม badge **"ผู้เบิก"** (สีส้ม/amber) สำหรับผู้ขอเบิกภายนอกที่ไม่ได้ล็อกอิน รวมถึงปรับปรุงตัวกรองค้นหาให้ค้นได้ทั้งชื่อไทยและ username
- **การเปลี่ยนแปลงในโค้ด:**
  - `cloudflare/src/api/requests.ts`:
    - ใน `apiUpdateRequestStatus`: เพิ่ม Guard ตรวจสอบว่าหากสถานะเดิมคือ `APPROVED` และเปลี่ยนเป็น `PENDING` ต้องเป็นบทบาท `admin` เท่านั้น (ป้องกัน officer ดำเนินการ)
    - รองรับการรับเหตุผลการส่งกลับแก้ไข (`item.RejectReason`) และบันทึกลง Audit Log: `${r.doc_no} → PENDING (ส่งกลับเพื่อแก้ไข: ${revertReason})`
    - เรียก `applyRequestStock(+1)` คืนสต็อกคงคลังและล็อต FIFO อัตโนมัติใน Database Batch เดียวกัน
  - `cloudflare/public/index.html`:
    - ใน `openEditReqModal`: แสดงปุ่ม **"ส่งกลับเพื่อแก้ไข"** (`#btnRevertReq`) สีส้ม Touch target $\ge 44$px ในกล่องเตือนสีเหลือง เฉพาะเมื่อเป็น Admin
    - เมื่อกด จะแสดง SweetAlert2 ให้ระบุเหตุผลในการส่งกลับแก้ไข (บังคับกรอก) แล้วส่งคำขอไปที่ `apiUpdateRequestStatus` เมื่อสำเร็จจะเปิด Modal ใหม่ในโหมดแก้ไขรายการพัสดุได้ทันที
    - ใน `viewAuditLog`:
      - ปรับปรุง `actorBadge`: ดึงข้อมูลผู้ใช้จาก `S.cache.users` แสดงชื่อภาษาไทยเป็นหลัก พร้อม `@username` ด้านล่าง หากไม่พบบัญชีผู้ใช้ (ผู้เบิกภายนอก) จะติด badge **"ผู้เบิก"** (`fa-user-pen`)
      - ปรับปรุง `filterAud`: กรองข้อมูล Audit Log โดยค้นหาได้ทั้ง `FullName`, `Username`, และคำว่า `ผู้เบิก`
  - `cloudflare/test/requests.test.ts`:
    - เพิ่ม Unit Test ตรวจสอบ:
      1. Officer ไม่สามารถเปลี่ยนสถานะคำขอที่อนุมัติแล้วกลับเป็น `PENDING` ได้ (ถูกปฏิเสธด้วยข้อความเฉพาะ Admin)
      2. Admin สามารถเปลี่ยนสถานะกลับเป็น `PENDING` ได้ คืนสต็อกเข้าคลังถูกต้อง บันทึกเหตุผลลง Audit Log และสามารถแก้ไขรายการพัสดุผ่าน `apiUpdateRequest` ต่อได้
- **ผลลัพธ์การทดสอบ:**
  - Vitest Backend: 11 test files, 177 tests ผ่าน 100%
  - Frontend Static Checks: 39 tests ผ่าน 100%
  - Graft: context graph ซิงค์สมบูรณ์ (303 nodes, 802 edges)

---

## 3. สิ่งที่ทำสำเร็จใน Session ก่อนหน้า (2026-11-04 Admin Self-Requisition Auto-Approve & No Password Decision)

### feat(requisition): ระบบอนุมัติและตัดสต็อกทันทีเมื่อผู้ดูแลเบิกพัสดุเอง
- **ความต้องการ:**
  1. ในกรณีที่ผู้ดูแลระบบหรือเจ้าหน้าที่พัสดุ (`ADMIN` / `APPROVER` / `OFFICER`) เป็นผู้เปิดใบเบิกพัสดุเพื่อใช้งานเอง ให้มีตัวเลือก "[✓] อนุมัติและตัดสต็อกทันที" โดยไม่ต้องสลับไปหน้า "จัดการรายการขอเบิก" เพื่อกดอนุมัติตนเองซ้ำซ้อน
  2. สรุปความชัดเจนเรื่องรหัสผ่าน: เว้นไว้แบบเดิม (ไม่มีช่องกรอกรหัสผ่านในแบบฟอร์มเบิกพัสดุ) เพื่อคงความสะดวก รวดเร็ว (Zero-friction) ของอาจารย์และบุคลากรทั่วไป และรักษาความปลอดภัยผ่านกระบวนการตรวจสอบอนุมัติของผู้ดูแลระบบ
- **การเปลี่ยนแปลงในโค้ด:**
  - `cloudflare/src/api/requests.ts`:
    - ปรับปรุง `apiCreateRequest`: ตรวจสอบพารามิเตอร์ `p.autoApprove` ร่วมกับสิทธิ์ใน Session (`ctx.session.role`)
    - หากเป็น Admin/Approver/Officer และเปิดใช้งาน autoApprove: เรียกใช้ `applyRequestStock` ตัดสต็อกแบบ FIFO ทันทีใน Transaction เดียวกัน บันทึก `approved_by` และ `approved_date` พร้อมส่ง Notification การอนุมัติ (`notifyHooks.onStatusChange`) แทนคำขอใหม่
    - หากเกิดข้อผิดพลาดด้านสต็อกไม่พอ จะทำการลบคำขอและแจ้งเตือนอย่างปลอดภัย
  - `cloudflare/public/index.html`:
    - ใน `renderRequisition`: แสดงกล่อง Toggle Switch สีเขียวมรกต (`emerald-600`) ขนาด Touch target $\ge 44$px เหนือปุ่มส่งคำขอ เฉพาะกรณีที่ล็อกอินอยู่ (`S.user.Role !== 'guest'`) และตั้งค่าเริ่มต้นเปิดใช้งาน (`checked = true`)
    - ใน `submitRequest`: แนบแฟล็ก `autoApprove: Boolean($('#chkAutoApprove')?.checked)` ส่งไปยัง API
  - `cloudflare/test/requests.test.ts`:
    - เพิ่ม Unit Test ตรวจสอบ:
      1. Officer สั่งเบิกพร้อม `autoApprove: true` จะได้สถานะ `APPROVED`, ตัดสต็อกทันที และบันทึก `approved_by`
      2. Guest สั่งเบิกพร้อม `autoApprove: true` ระบบจะปฏิเสธการตัดสต็อกอัตโนมัติและคงสถานะเป็น `PENDING`
- **ผลลัพธ์การทดสอบ:**
  - Vitest Backend: 11 test files, 176 tests ผ่าน 100%
  - Frontend Static Checks: 39 tests ผ่าน 100%

---

## 3. สิ่งที่ทำสำเร็จใน Session ก่อนหน้า (2026-11-03 Excel Import Support for Personnel)

### feat(personnel): เพิ่มการรองรับการนำเข้าไฟล์ Excel (.xlsx) สำหรับข้อมูลบุคลากร
- **ความต้องการ:** ผู้ใช้งานต้องการนำเข้าข้อมูลบุคลากรด้วยไฟล์ Excel (.xlsx) นอกเหนือจากไฟล์ CSV เพื่อป้องกันปัญหาตัวอักษรภาษาไทยกลายเป็นภาษาต่างด้าว (Encoding เพี้ยน) และปัญหาตัวคั่นเครื่องหมายจุลภาคในชื่อตำแหน่ง/ฝ่ายงาน
- **การเปลี่ยนแปลงในโค้ด:**
  - `cloudflare/public/index.html`:
    - ปรับปรุงฟังก์ชัน `importPersonnelModal`:
      - ช่องเลือกไฟล์ (`#fileCsvPersonnel`) รองรับทั้ง `.xlsx, .xls, .csv`
      - หากเลือกไฟล์ `.xlsx` หรือ `.xls`: โหลด `ExcelJS` อ่านแผ่นงานแรก Map คอลัมน์ภาษาไทย (`รหัสบุคลากร`, `ชื่อ-นามสกุล`, `ตำแหน่ง`, `หลักสูตร/ฝ่ายงาน`, `สถานะ`) หรือภาษาอังกฤษ พร้อมแสดงกล่อง Preview จำนวนรายการและตัวอย่างชื่อ 3 รายการแรกก่อนกดยืนยัน
      - หากเลือกไฟล์ `.csv`: อ่านด้วย `FileReader.readAsText` ตามปกติ
      - หากพิมพ์หรือวางข้อมูลลงใน Textarea โดยตรง จะสลับไปใช้ข้อมูลจาก Textarea อัตโนมัติ
    - ปรับปรุง `downloadPersonnelTemplate_`:
      - สร้างไฟล์แม่แบบ `.xlsx` ด้วย `ExcelJS` พร้อมตกแต่ง Header สีเขียว (`#059669`) จัดกว้างคอลัมน์และมีตัวอย่าง 3 แถว
      - มี Fallback เป็น CSV หากเกิดข้อผิดพลาดในการโหลดไลบรารี
- **ผลลัพธ์การทดสอบ:**
  - Vitest Backend: 11 test files, 174 tests ผ่าน 100%
  - Frontend Static Checks: 34 tests ผ่าน 100%
  - สอดคล้องกับแนวคิด Ponytail & YAGNI: ไม่เพิ่ม Dependency ใหม่ นำ `ExcelJS` ที่มีอยู่แล้วมาใช้ซ้ำ 100%

---

## 3. สิ่งที่ทำสำเร็จใน Session ก่อนหน้า (2026-11-03 Personnel Quick Registration & UX Alignment)

### feat(personnel): ระบบเพิ่มประวัติผู้ขอเบิกใหม่ในหน้าขอเบิกพัสดุ และปรับปรุง UX หน้าแรก
- **ความต้องการ:** ผู้ใช้งานต้องการให้อาจารย์และผู้ขอเบิกสามารถบันทึกประวัติข้อมูลของตนเอง (รหัสบุคลากร, ชื่อ-นามสกุล, ตำแหน่ง, ฝ่ายงาน/หลักสูตร) ได้โดยตรงจากหน้าแบบฟอร์มขอเบิก เพื่อดึงข้อมูลมาใช้อัตโนมัติโดยไม่ต้องสลับไปหน้าอื่น และไม่ให้เกิดความสับสนเรื่องการเข้าสู่ระบบ
- **การเปลี่ยนแปลงในโค้ด:**
  - `cloudflare/src/api/personnel.ts`:
    - เพิ่ม RPC Endpoint `apiRegisterPersonnel` (Public access): รองรับการบันทึกประวัติผู้เบิกใหม่โดยไม่ต้อง Login
    - **Security & Data Integrity:** อนุญาตเฉพาะคำสั่ง `INSERT` รหัสใหม่เท่านั้น (ห้าม `UPDATE` ทับข้อมูลของผู้อื่น), ตรวจจับรหัสซ้ำแบบ Case-insensitive, บังคับตรวจสอบฟิลด์ครบถ้วน, ตรวจสอบรหัสบุคลากรเป็นตัวเลขล้วน (`/^\d+$/`), และบันทึก Audit Log กำกับ `[Public Registration]`
  - `cloudflare/public/index.html`:
    - **ปุ่ม "+ เพิ่มประวัติผู้เบิก" (`#btnRegisterPersonnel`):** วางคู่กับปุ่มค้นหารหัสบุคลากรในกล่องกรอกรหัส (Touch target $\ge$ 44px)
    - **Smart Inline Action:** หากกดค้นหารหัสแล้วไม่พบข้อมูล จะแสดงข้อความแจ้งเตือนพร้อมปุ่มลัด `คลิกเพื่อเพิ่มประวัติผู้เบิกใหม่`
    - **Modal เพิ่มประวัติผู้ขอเบิกใหม่ (`registerPersonnelModal`):**
      - Placeholder รหัสบุคลากรปรับเป็น `เช่น 4216125 (ตัวเลขเท่านั้น)` พร้อมจำกัดให้พิมพ์ได้เฉพาะตัวเลข (`inputmode="numeric"` และกรอง `replace(/\D/g, '')`)
      - ซ่อนช่อง "สถานะเปิดใช้งาน (Active)" ที่ไม่จำเป็นออก เพื่อลด Visual Clutter และขยายช่อง "ตำแหน่ง" ให้เต็มความกว้าง
      - ปรับช่อง "ตำแหน่ง" เป็น Dropdown (`<select>`) มี 2 ตัวเลือก: "อาจารย์" และ "เจ้าหน้าที่" สอดคล้องกับแบบฟอร์มขอเบิก 100%
      - เพิ่มข้อความหมายเหตุสุภาพใต้ฟอร์ม: `💡 หมายเหตุ: หากต้องการแก้ไขหรือลบข้อมูลในภายหลัง สามารถแจ้งเจ้าหน้าที่พัสดุหรือผู้ดูแลระบบได้`
      - รองรับการกรอกรหัส, ชื่อ-สกุล, ตำแหน่ง, ฝ่ายงาน/หลักสูตร พร้อม Loading & Disabled state ป้องกัน Double Submit
    - **Seamless Auto-fill & Auto-lock:** เมื่อบันทึกสำเร็จ ระบบจะนำข้อมูลมาเติมลงฟอร์มขอเบิกพัสดุและล็อคช่องให้อัตโนมัติ พร้อมแสดง Badge "ยืนยันข้อมูลแล้ว" และปุ่ม "เปลี่ยนรหัส" โดยไม่ต้องกดค้นหาซ้ำ
    - **UX Alignment หน้าแรก (Login Screen):** ปรับข้อความจาก *"สำหรับอาจารย์ / บุคลากร / ผู้ขอเบิก (ไม่ต้องเข้าสู่ระบบ)"* เป็น **`สำหรับอาจารย์ / บุคลากร (ทำรายการได้ทันที)`** เพื่อขจัดความขัดแย้งในใจผู้ใช้เรื่อง "ทำไมบอกไม่ต้องเข้าสู่ระบบ แต่ข้างในให้ลงทะเบียน" โดยสื่อสารอย่างชัดเจนว่าเป็นการทำรายการด่วนโดยไม่ต้องใช้รหัสผ่าน
  - `cloudflare/test/personnel.test.ts`:
    - เพิ่ม Unit Tests ครอบคลุม `apiRegisterPersonnel` ทั้งการบันทึกสำเร็จ, การปฏิเสธรหัสซ้ำ, และการตรวจจับข้อมูลไม่ครบ
- **ผลลัพธ์การทดสอบ:**
  - Vitest: 11 test files, 174 tests ผ่านทั้งหมด (100%)
  - TypeScript: `tsc --noEmit` ผ่านฉลุย ไม่มี Type Error
  - Graft: wiring graph ซิงค์สมบูรณ์ (303 nodes, 802 edges)

---

## 3. ประวัติสิ่งที่ทำสำเร็จก่อนหน้า (2026-11-02 Full Name Placeholder & Validation)

### feat(form): ปรับ Placeholder และเพิ่มการตรวจสอบ (Validation) ชื่อ-นามสกุลเต็มในแบบฟอร์มขอเบิก
- **ความต้องการ:** ผู้ใช้งานต้องการให้ช่องระบุชื่อ-สกุล มี Placeholder แสดงตัวอย่างชัดเจน และมีระบบตรวจจับ (Validation) บังคับให้ต้องกรอกทั้งชื่อและนามสกุลเต็ม (เช่น สมรักษ์ คำดี)
- **การเปลี่ยนแปลงในโค้ด:**
  - `cloudflare/public/index.html`:
    - ปรับ Placeholder ในช่อง `#rName` สำหรับ Guest/ผู้ขอเบิกทั่วไป เป็น `"ระบุชื่อ - นามสกุลเต็ม เช่น สมรักษ์ คำดี (ต้องระบุทั้งชื่อและนามสกุล)"`
    - ในฟังก์ชัน `submitRequest`: เพิ่มการตรวจสอบ `nameParts = reqName.split(/\s+/).filter(Boolean)` ว่าต้องมีอย่างน้อย 2 คำ (`nameParts.length >= 2`) ก่อนเปิด Confirmation Modal
    - หากไม่ผ่าน: แสดง Warning Toast `"กรุณาระบุชื่อและนามสกุลเต็ม (เช่น สมรักษ์ คำดี)"` พร้อมสั่ง focus ไปที่ช่อง `#rName` ทันที
- **ผลลัพธ์การทดสอบ:**
  - Vitest + Node Frontend Static Tests ผ่านครบ 212/212 tests (100%)
  - การจัดการ Skill: ปรับปรุง `grill-me` ลบตัวซ้ำซ้อน และใช้ Built-in Slash Command ร่วมกับโฟลเดอร์กลางอย่างเป็นระเบียบ

---

## 3. ประวัติสิ่งที่ทำสำเร็จก่อนหน้า

### 0. feat(requests): เพิ่มไอคอนและระบบแก้ไขใบขอเบิกสำหรับผู้ดูแลระบบและเจ้าหน้าที่ (Edit Requisition)
- **ความต้องการ:** เพิ่มปุ่มไอคอนแก้ไขข้อมูลใบขอเบิกในหน้ารายการขอเบิก (`a-request`) สำหรับผู้ดูแลระบบ (Admin) และเจ้าหน้าที่ (Officer) เพื่อให้สามารถแก้ไขข้อมูลที่ผู้ใช้งานกรอกผิดได้โดยตรง
- **กฎทางธุรกิจและการควบคุมคลัง (Inventory Safety Rules):**
  - **สถานะ "รออนุมัติ" (PENDING):** แก้ไขได้เต็มรูปแบบ ทั้งข้อมูลทั่วไป (ผู้ขอเบิก, ตำแหน่ง, ฝ่ายงาน/โครงการ, วัตถุประสงค์, วันที่, ไฟล์แนบ, หมายเหตุ) และรายการพัสดุ (เพิ่ม/ลบ/เปลี่ยนพัสดุ/ปรับจำนวน) พร้อมตรวจเช็คสต็อกคงเหลือ
  - **สถานะ "อนุมัติแล้ว" (APPROVED):** แก้ไขได้เฉพาะข้อมูลทั่วไป ห้ามแก้ไขรายการพัสดุ เพื่อป้องกันยอดสต็อกตามล็อตจริง (`material_lots`) และการบันทึกบัญชีคลังคลาดเคลื่อน
- **การเปลี่ยนแปลงในโค้ด:**
  - `cloudflare/src/api/requests.ts`: เพิ่ม RPC handler `apiUpdateRequest` สิทธิ์ `'officer'` พร้อมระบบตรวจสอบสถานะ PENDING vs APPROVED และบันทึก Audit Log การแก้ไข
  - `cloudflare/public/index.html`:
    - เพิ่มไอคอนแก้ไข (`fa-pen-to-square`) สีเหลืองส้ม (Amber) ในคอลัมน์ "จัดการ" ของตารางและ Card view ในฟังก์ชัน `reqActions(q)`
    - ผูก Event `[data-edit-req]` ใน `bindReqEvents()`
    - เพิ่มฟังก์ชัน Modal `openEditReqModal(id)` ดึงข้อมูลเดิมมาแสดง ให้แก้ไขพร้อม UI เพิ่ม/ลบรายการพัสดุ และ Loading/Disabled state ป้องกัน Double Submit
    - **ล็อกการปิด Modal จากพื้นที่ว่าง (Static Backdrop by Default):** ปรับให้ `openModal` มีค่าเริ่มต้น `staticBackdrop = true` ทุกตัวทั่วทั้งระบบ ป้องกันการเผลอคลิกพื้นหลังแล้วฟอร์มหลุด พร้อมเอฟเฟกต์สั่นภาพ (`animate-shake`), วงแหวนไฮไลต์ปุ่มกากบาท (`ring-4 ring-white scale-125`), และสั่นเครื่องจริงผ่าน Haptic Feedback (`navigator.vibrate([40, 60, 40])`)
  - `cloudflare/test/requests.test.ts`: เพิ่ม Unit Test ครอบคลุมการแก้ไข PENDING, APPROVED (ห้ามแตะพัสดุ), และตรวจจับจำนวนเกินสต็อก
  - `cloudflare/test/node/frontend.test.ts`: อัปเดตทดสอบ staticBackdrop และ Haptic vibration effect
- **ผลลัพธ์การทดสอบ:**
  - Vitest + Node Frontend Tests ผ่านครบถ้วน 212/212 tests (100%)
  - Graft index wiring graph ซิงค์ตรงกับโค้ดทั้งหมด (303 nodes, 802 edges)

### 0. feat(notifications) & fix(requests): แสดงรายการพัสดุและสรุปอนุมัติ/ไม่อนุมัติใน Telegram & LINE
- **ปัญหาเดิม:** การอนุมัติใบขอเบิกบางครั้งแจ้งเตือน `จำนวน: 0 รายการ | มูลค่ารวม: 0.00 บาท` เนื่องจาก `apiGetRequestForPrint` ไม่ได้ส่งฟิลด์ `ID` ของแต่ละรายการพัสดุ ทำให้ตอนส่งบันทึกจาก Modal ฝั่ง Backend จับคู่ ID ไม่เจอและคำนวณ `approvedCount` เป็น 0 รวมถึงข้อความแจ้งเตือนไม่แสดงรายการพัสดุที่ขอเบิก
- **การแก้ไข:**
  - `cloudflare/src/api/requests.ts`: เพิ่ม `ID: str(it.id)` ใน `apiGetRequestForPrint` และเพิ่ม Fallback ให้จับคู่ด้วย `Code` ใน `apiUpdateRequestStatus`
  - `cloudflare/src/lib/telegram.ts`:
    - ปรับ `newRequestText`: เพิ่มรายการพัสดุที่ขอเบิก (`📦 รายการพัสดุที่ขอเบิก:`) สูงสุด 10 รายการ
    - ปรับ `approvedRequestText`: แสดงสรุป `อนุมัติ X รายการ | ไม่อนุมัติ Y รายการ` พร้อมแจกแจง `📦 รายการที่อนุมัติ:` และ `❌ รายการที่ตัดออก:` สูงสุด 10 รายการ
  - `cloudflare/src/lib/lineFlex.ts`:
    - ปรับ `newRequestFlex` และ `approvedRequestFlex` เพิ่มกล่องสรุปและรายการพัสดุในรูปแบบ Flex Bubble
  - `cloudflare/test/admin.test.ts` & `cloudflare/test/requests.test.ts`: เพิ่มและอัปเดตชุดการทดสอบครอบคลุมการจัดรูปแบบข้อความ

### 0.1 fix(requests): แก้ไข TypeError $(...).forEach ใน modal พิจารณาอนุมัติคำขอเบิก
- **Root Cause:** ใน `cloudflare/public/index.html` ภายในฟังก์ชัน `openApproveModal(id)` มีการเรียกใช้ Selector `$('#tblApItems .item-approve-row')` (ใช้ `$` เดี่ยว ซึ่งคือ `querySelector` ส่งคืน Element เดี่ยว) แล้วนำไปเรียก `.forEach` ทำให้เกิด `TypeError: $(...).forEach is not a function at openApproveModal`
- **การแก้ไข:**
  - เปลี่ยนการเรียกแถวตารางพัสดุเป็น `$$('#tblApItems .item-approve-row')` (ใช้ `$$` ซึ่งคือ `querySelectorAll` ส่งคืน Array) ทั้งหมด 3 จุดใน `openApproveModal` (ใน `updateSummary()`, การผูก Event Listener เช็คบ็อกซ์/จำนวน, และตอนกดปุ่มยืนยันบันทึกการอนุมัติ)
  - เพิ่ม Static Regression Test ใน `cloudflare/test/node/frontend.test.ts` เพื่อป้องกันการเรียก Array methods (`forEach`, `map`, `filter`, `reduce`) บน `$(...)` ทั่วทั้งไฟล์
- **ผลลัพธ์:**
  - Modal พิจารณาอนุมัติคำขอเบิกเปิดและทำงานได้อย่างสมบูรณ์ คำนวณยอดเงินและจำนวนรายการแบบ Reactive ทันทีตอนเปิดและตอนปรับเปลี่ยนค่า และบันทึกการอนุมัติได้ถูกต้อง

### 1. feat(ui): Pagination ครบทั้ง 3 มุมมองหลัก (บัญชีพัสดุ, จัดการพัสดุ, ทะเบียนวัสดุคงเหลือ)
- **แท็บบัญชีพัสดุ (`viewAccount`):**
  - แสดงผลแบ่งหน้าเริ่มต้นที่ **20 แถวต่อหน้า** (Default) พร้อม Page Size Selector `[แสดง: 20 | 25 | 50 | ทั้งหมด]`
  - แถบเลขหน้าแบบกะทัดรัด `[ < 1 2 3 > ]` และแสดงยอดรวมทั้งสิ้น (Grand Total) ที่ `tfoot` ตลอดเวลา
  - การสั่งพิมพ์ (`printAccount`): แบ่งหน้า A4 แนวนอนอัตโนมัติที่ 15 แถวต่อหน้า พร้อมซ้ำหัวตารางและสรุป+ลายเซ็นต์หน้าสุดท้าย
- **แท็บจัดการพัสดุ (`viewMaterials`):**
  - แบ่งหน้าเริ่มต้นที่ **20 รายการต่อหน้า** รองรับทั้งโหมดตาราง (**Table**) และโหมดการ์ด (**Grid**)
  - มี Page Size Selector `[แสดง: 20 | 25 | 50 | ทั้งหมด]` และแถบควบคุมเลขหน้า `[ < 1 2 3 > ]`
  - รีเซ็ตกลับไปหน้า 1 อัตโนมัติเมื่อพิมพ์ค้นหาหรือเปลี่ยนตัวกรองหมวดหมู่/สถานะ
  - เช็คบ็อกซ์ "เลือกทั้งหมด" และ "ลบที่เลือก" ดำเนินการเฉพาะรายการในหน้าปัจจุบันเพื่อความปลอดภัย
  - การ "ส่งออก Excel" และ "พิมพ์" ยังคงส่งออก/พิมพ์รายการทั้งหมดที่ผ่านการกรองครบถ้วน
- **แท็บทะเบียนวัสดุคงเหลือ (`viewInventoryReport`):**
  - แสดงผลแบ่งหน้าเริ่มต้นที่ **20 แถวต่อหน้า** พร้อม Page Size Selector `[แสดง: 20 | 25 | 50 | ทั้งหมด]`
  - แถบเลขหน้าแบบกะทัดรัด `[ < 1 2 3 > ]`
  - คงแถวสรุป Grand Total ที่ `tfoot` ของตารางคำนวณยอดเงินรวมและจำนวนทั้งหมดตามเงื่อนไขที่กรองไว้เสมอ
  - การสั่งพิมพ์ (`printInventoryReport`): แบ่งหน้า A4 แนวนอนอัตโนมัติที่ **15 แถวต่อหน้า** ซ้ำหัวตาราง 14 คอลัมน์ทุกล็อต และรวมแถบสรุป + ช่องลงนาม 3 ตำแหน่งท้ายหน้าสุดท้าย ป้องกันตารางล้นและตัดบรรทัด

### 2. feat(frontend): Auto-save แบบฟอร์มขอเบิก 30 นาที (`req_form_draft_v1`)
- บันทึกข้อมูลร่างฟอร์มลง `localStorage` ทันทีเมื่อมีการพิมพ์หรือแก้ไขรายการ (`saveReqDraft()`) รองรับทั้งฟิลด์ข้อความ วันที่ ตำแหน่ง ผู้ขอเบิก แผนก วัตถุประสงค์ หมายเหตุ และรายการพัสดุ
- กำหนดเวลาหมดอายุ 30 นาที (`REQ_DRAFT_TTL_MS = 30 * 60 * 1000`)
- เมื่อเปิดฟอร์มหรือรีเฟรช/กลับมาที่หน้าเว็บ หากมีร่างที่ยังไม่หมดอายุ ระบบจะโหลดข้อมูลกลับมาให้อัตโนมัติ พร้อมแสดงแถบแจ้งเตือนสีส้มอ่อนและปุ่ม "ล้างแบบร่าง" (`#btnClearReqDraft`)
- บันทึกเซสชันของ Guest (`enterGuest` -> `saveSession_`) และจดจำหน้าล่าสุด (`supply_last_view`) เพื่อให้เมื่อกดรีเฟรชหรือเปิดเบราว์เซอร์ใหม่ยังคงอยู่ที่หน้าแบบฟอร์มขอเบิกและกู้คืนร่างได้ทันที
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
  - Worker Tests: **162 passed** (10 test files)
  - Node Tests: **38 passed** (2 test files)
  - **รวมทั้งสิ้น: 200 passed (100% PASS)**
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
