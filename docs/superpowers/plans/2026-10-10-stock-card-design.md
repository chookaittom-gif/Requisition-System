# Stock Card (สต๊อกการ์ดคุมพัสดุ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ออกแบบและพัฒนาระบบ "สต๊อกการ์ด (Stock Card)" รายชิ้นตามแบบฟอร์มราชการ (อ้างอิงจาก `สต๊อกการ์ด.pdf`) เพิ่มเข้าสู่ระบบเบิกพัสดุเดิม รองรับการดูบนหน้าจอเว็บ (Interactive Web UI), กรองตามช่วงวันที่/ปีงบประมาณ, คำนวณยอดคงเหลือสะสม (Running Balance), และสั่งพิมพ์/Export แบบฟอร์ม A4 แนวตั้งตรงตามมาตรฐานราชการ

**Architecture:** เพิ่ม Backend RPC function `apiGetStockCard(materialId, filter)` ใน `code.gs` สำหรับดึงข้อมูลวัสดุ ยอดยกมา (Opening Balance) และประวัติเคลื่อนไหว (Movements) เรียงลำดับเวลาเพื่อคำนวณยอด รับ-จ่าย-คงเหลือ; และในฝั่ง Frontend (`index.html`) เพิ่มเมนู "สต๊อกการ์ด (Stock Card)" สำหรับ Admin (และ Staff ดูได้), พร้อมหน้า Interactive UI และฟังก์ชัน `printStockCard` ที่เรนเดอร์เทมเพลต A4 หน้าตาตรงตามแบบฟอร์มราชการ

**Tech Stack:** Google Apps Script backend (`code.gs`), HTML5/Tailwind CSS/Vanilla JS (`index.html`), Print CSS (`@page { size: A4 portrait }`)

**Spec:** `สต๊อกการ์ด.pdf` (แบบฟอร์มทางการ) และ `prompt ระบบเบิกพัสดุ.txt` (หัวข้อ 4. Stock, 14. Report, 20. Phase 3)

## Global Constraints

- รักษาโครงสร้างชีตเดิมและ RPC pattern (`api(fn, args)`) และ CacheService ที่มีอยู่เดิม
- ห้ามแก้รหัสหรือลบฟังก์ชันเดิมใน `code.gs` โดยไม่จำเป็น
- แสดงผลวันที่ภาษาไทย พ.ศ. ตามข้อกำหนดของระบบ
- ช่องฟอร์มสั่งพิมพ์ต้องตรงกับ `สต๊อกการ์ด.pdf`:
  - หัวกระดาษ: ชื่อหน่วยงาน, ประเภทวัสดุ, ชื่อสินค้า, แผ่นที่
  - ตาราง: วันที่, รายการ, จำนวน (รับ / จ่าย / คงเหลือ), ลงชื่อ
- รองรับ Responsive บน Desktop, Tablet, Mobile

## Review Focus

1. **การคำนวณยอดยกมา (Opening Balance) ร่วมกับ Transactions ก่อนหน้าช่วงวันที่ที่เลือก:** หากผู้ใช้เลือกช่วงเวลา (Date Range) จะต้องคำนวณยอดยกมาสะสมก่อนวันเริ่มต้นให้ถูกต้อง
2. **ลำดับการเรียงลำดับเวลา (Chronological Sort):** ข้อมูลในการ์ดต้องเรียงตาม `CreatedAt` จากอดีตไปหาปัจจุบัน (Ascending) เพื่อคำนวณยอดคงเหลือสะสม (Running Balance) ได้แม่นยำ
3. **การแสดงผลเมื่อไม่มีข้อมูลเคลื่อนไหว (Empty State):** สต็อกการ์ดต้องแสดงข้อมูลพัสดุและยอดยกมาได้ถูกต้อง พร้อมบรรทัดว่างสำหรับพิมพ์แบบฟอร์มเปล่าได้เหมือนใน PDF
4. **ความแม่นยำในการพิมพ์ (Print Layout):** การสั่งพิมพ์ต้องแสดงผลหน้าเดียวหรือแบ่งหน้า A4 แนวตั้ง ไม่ล้นกระดาษ และไม่แสดงแถบเมนูนำทางของระบบ
5. **การสลับเลือกวัสดุ (Material Picker):** ค้นหาและสลับดูสต็อกการ์ดของแต่ละรายการได้อย่างรวดเร็ว

---

### Task 1: Backend RPC `apiGetStockCard` ใน `code.gs`

**Files:**
- Modify: `Code/code.gs` (เพิ่ม `apiGetStockCard` ใน `FN_ACCESS` และเขียนฟังก์ชันคำนวณ Stock Card)

**Interfaces:**
- Consumes: `materialId: string`, `filter: { fiscalYear?: number, from?: string, to?: string }`
- Produces: 
  ```ts
  {
    ok: boolean,
    data: {
      material: { ID, Code, Name, Unit, UnitPrice, Category, StorageLocation, StockQty },
      openingBalance: number,
      summary: { totalIn: number, totalOut: number, currentBalance: number },
      entries: Array<{
        date: string,        // YYYY-MM-DD
        dateTh: string,      // วันที่ พ.ศ.
        description: string, // เช่น รับเข้าพัสดุ (RefDoc), จ่ายตามใบเบิก REQ-xxx
        inQty: number,
        outQty: number,
        balance: number,
        actor: string,
        refDoc: string
      }>
    }
  }
  ```

- [ ] **Step 1: เพิ่มสิทธิ์ใน `FN_ACCESS`**
  เพิ่ม `apiGetStockCard: 'staff'` (หรือ admin ตามนโยบาย แต่ staff ควรดูยอดคงเหลือเพื่อความโปร่งใสได้)

- [ ] **Step 2: เขียนฟังก์ชัน `apiGetStockCard(materialId, filter)`**
  - ค้นหาข้อมูลวัสดุจากชีต `Materials` ตาม `materialId`
  - ค้นหายอดยกมาต้นปีงบประมาณจาก `OpeningBalances`
  - ดึงรายการ `StockMovements` ของวัสดุนี้ทั้งหมด เรียงตาม `CreatedAt` ASC
  - คำนวณ Running Balance ทีละบรรทัด (IN บวก, OUT ลบ, ADJUST ปรับ)
  - จัดการกรองช่วงวันที่ (ถ้ามีระบุ `from` / `to`) โดยรวบยอดก่อนหน้า `from` เป็นยอดยกมาเริ่มต้น

- [ ] **Step 3: รองรับ Export CSV ของ Stock Card ใน `apiExportCSV`**
  - เพิ่มเคส `type === 'stock_card'` ให้ดาวน์โหลดไฟล์ CSV ประวัติของวัสดุนั้นได้

---

### Task 2: Frontend Menu & Routing ใน `Code/index.html`

**Files:**
- Modify: `Code/index.html` (อัปเดต `MENUS.admin`, `MENUS.staff` และ `go(view)`)

**Interfaces:**
- Consumes: User click เมนู `a-stockcard`
- Produces: เรียก `viewStockCard(selectedMaterialId)`

- [ ] **Step 1: เพิ่มเมนู `a-stockcard` ใน `MENUS.admin`**
  ```javascript
  { id:'a-stockcard', title:'สต๊อกการ์ด (Stock Card)', sub:'บัตรคุมยอดพัสดุรายชิ้น', icon:'fa-id-card', color:'#0d9488' }
  ```

- [ ] **Step 2: เพิ่ม Route ในฟังก์ชัน `go()`**
  เพิ่ม `'a-stockcard': viewStockCard` ในตัวแปร `map`

- [ ] **Step 3: เพิ่มปุ่ม Quick Link จากหน้า "จัดการพัสดุ" (`viewMaterials`)**
  ในแถวรายการพัสดุแต่ละชิ้น เพิ่มปุ่มไอคอนลัด `<button data-stock-card="${m.ID}">` เพื่อคลิกแล้วเปิดดูสต็อกการ์ดของพัสดุชิ้นนั้นได้ทันที

---

### Task 3: Interactive UI หน้า `viewStockCard` ใน `Code/index.html`

**Files:**
- Modify: `Code/index.html` (เขียนฟังก์ชัน `viewStockCard`)

**Interfaces:**
- Consumes: ข้อมูลจาก `api('apiGetMaterials')` และ `api('apiGetStockCard', materialId, filter)`
- Produces: หน้าจอแสดงผล Interactive Stock Card

- [ ] **Step 1: โครงสร้างส่วนควบคุม (Toolbar / Filter Bar)**
  - กล่องค้นหา / Dropdown เลือกพัสดุ (พร้อมแสดงรหัสและหน่วยนับ)
  - ตัวเลือกปีงบประมาณ หรือ วันที่เริ่มต้น - สิ้นสุด
  - ปุ่ม "รีเฟรช", ปุ่ม "พิมพ์สต็อกการ์ด (A4)", และปุ่ม "Export CSV"

- [ ] **Step 2: การ์ดสรุปภาพรวมด้านบน (Header Info Card)**
  - หน่วยงาน (จาก Settings)
  - หมวดหมู่ / ประเภทวัสดุ
  - ชื่อพัสดุ, รหัสพัสดุ, สถานที่จัดเก็บ
  - สรุปตัวเลข: [ยอดยกมา] | [รับรวม] | [จ่ายรวม] | [คงเหลือปัจจุบัน]

- [ ] **Step 3: ตาราง Stock Ledger แสดงการเคลื่อนไหว**
  - คอลัมน์: วันที่ | รายการ / เอกสารอ้างอิง | รับ | จ่าย | คงเหลือสะสม | ผู้ลงชื่อ/ผู้ทำรายการ
  - มี Badge แยกสี รับเข้า (เขียว) / เบิกจ่าย (แดง) / ปรับยอด (ส้ม)

---

### Task 4: Template พิมพ์แบบฟอร์มทางการ A4 `printStockCard`

**Files:**
- Modify: `Code/index.html` (เพิ่มฟังก์ชัน `printStockCard`)

**Interfaces:**
- Consumes: ข้อมูลที่เตรียมไว้สำหรับ Stock Card
- Produces: ส่ง HTML ไปยัง `doPrint(html, false)` (A4 Portrait)

- [ ] **Step 1: ออกแบบโครงสร้าง HTML ตรงตามแบบฟอร์ม `สต๊อกการ์ด.pdf`**
  - หัวกระดาษ:
    - ข้อความตรงกลางตัวหนา: `สต๊อกการ์ด (Stock Card)`
    - ชิดขวา: `แผ่นที่ ....................`
    - ชิดซ้าย: `ชื่อหน่วยงาน ............................................................................`
    - ชิดซ้าย: `ประเภทวัสดุ ............................................................................`
    - ชิดซ้าย: `ชื่อสินค้า ............................................................................`
  - ตาราง 2 ชั้น (Nested Header Table):
    ```text
    +-----------+--------------------+-------------------------+-------------+
    |           |                    |          จำนวน           |             |
    |   วันที่   |       รายการ        +------+------+-----------+    ลงชื่อ    |
    |           |                    |  รับ  | จ่าย |  คงเหลือ  |             |
    +-----------+--------------------+------+------+-----------+-------------+
    ```
  - จัดช่องตารางเติมแถวว่าง (Empty rows) ให้เต็มหน้ากระดาษ A4 เสมือนแบบฟอร์มจริงในไฟล์ PDF

- [ ] **Step 2: กำหนด Styling สำหรับ Print ใน `doPrint`**
  - ตั้งค่า Font Sarabun / ThSarabunNew
  - เส้นขอบตารางสีดำ คมชัด (`border: 1px solid black; border-collapse: collapse;`)
  - จัดระยะขอบหน้ากระดาษ `@media print { @page { size: A4 portrait; margin: 15mm 10mm; } }`

---

## Verification Plan

### Automated Tests
- ตรวจสอบไวยากรณ์ JavaScript ใน `Code/code.gs` และ `Code/index.html`
- ทดสอบ build/syntax ด้วย node parser:
  ```powershell
  node --check Code/code.gs
  ```

### Manual Verification
1. **เข้าสู่ระบบ Admin** -> ตรวจสอบว่ามีเมนู "สต๊อกการ์ด (Stock Card)" ใน Sidebar
2. **เลือกรายการพัสดุ** -> ระบบดึงข้อมูลพัสดุและคำนวณยอดยกมา + ประวัติการรับ/จ่าย ถูกต้อง
3. **ตรวจสอบ Running Balance** -> ยอดคงเหลือในแต่ละแถวคำนวณตรงกับสูตร `คงเหลือ = ก่อนหน้า + รับ - จ่าย`
4. **คลิกปุ่ม "พิมพ์สต็อกการ์ด"** -> หน้าต่าง Print Preview ปรากฏขึ้น เป็น A4 แนวตั้ง หัวตารางและเส้นขอบเหมือน `สต๊อกการ์ด.pdf`
5. **ทดสอบปุ่มทางลัดจากหน้ารายการพัสดุ** -> คลิกไอคอนสต็อกการ์ดในตารางพัสดุ แล้วเปิดไปหน้านั้นทันที
