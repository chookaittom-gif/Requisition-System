# Design Doc: ช่องค้นหาพัสดุในแบบฟอร์มขอเบิก (Material Search Filter)

**วันที่:** 2026-11-07 · **สถานะ:** อนุมัติแล้ว (ผู้ใช้ยืนยันทางแชท)

## Intent & Why

Dropdown เลือกพัสดุในฟอร์มขอเบิกมี 50+ รายการ ชื่อคล้ายกันมาก (กระดาษ A4 หลาย variants) ผู้ใช้ต้องเลื่อนไล่หาเอง เสี่ยงเลือกผิด ตามหลัก UI (recognition over recall) list เกิน ~20 รายการควรมีช่องค้นหา

## Goals

- พิมพ์ค้นหาได้ทั้งชื่อพัสดุและรหัส (case-insensitive) กรอง realtime ทันทีที่พิมพ์
- ทำงานเหมือนกันทั้ง desktop และ mobile
- คงพฤติกรรมเดิมครบ: `<optgroup>` 6 หมวด, เรียง ก-ฮ, ซ่อนหมดสต็อก (ฟอร์มใหม่), โชว์รายการเดิม (Modal แก้ไข)
- ค่าที่เลือกไว้ก่อนหน้าไม่หายเมื่อกรอง

## Non-goals

- ไม่เปลี่ยน native `<select>` เป็น custom combobox component (ยังคง native mobile picker)
- ไม่แตะ backend / schema / API
- ไม่ขยายไป dropdown พัสดุจุดอื่น (`buyMat`, `obMat`, `scMatSelect`) — ทำเฉพาะฟอร์มขอเบิก

## Approaches ที่พิจารณา

1. คง native select เดิม — ถูกปฏิเสธ: ปัญหาค้าง
2. **ช่องค้นหากรอง options ของ native select (vanilla JS)** — เลือกแนวทางนี้: minimal change, ไม่เพิ่ม dependency, ตรงกับที่ผู้ใช้อนุมัติ
3. Custom combobox component เต็มรูปแบบ — ถูกปฏิเสธ: งานหนัก, ARIA/keyboard ต้องทำเอง, ผิดหลัก Ponytail/minimal
4. CDN library (Tom Select/Choices.js) — ถูกปฏิเสธ: เพิ่ม dependency, theme ยุ่ง

## การเปลี่ยนแปลงที่ตัดสินใจแล้ว

- `cloudflare/public/index.html`:
  - เพิ่ม helper `filterMats(mats, q)` กรองตาม `Name` + `Code`
  - `addItemRow`: เพิ่มช่องค้นหาเหนือ select รายการพัสดุ (placeholder "ค้นหาพัสดุ (ชื่อหรือรหัส)..."), touch ≥44px, พิมพ์แล้ว re-render options ของ select แถวนั้น
  - `openEditReqModal`: ช่องค้นหาแบบเดียวกัน, คง `includeCodeInLabel` + รายการเดิม
  - UI ยึด class ชุดเดิมของโปรเจกต์ (rounded-2xl, border-slate-200, focus ring เดิม)
- `cloudflare/test/node/frontend.test.ts`: static tests ตรวจ helper กรอง, ช่องค้นหาถูกผูกทั้ง 2 จุด, รักษา optgroup/เรียง ก-ฮ

## Acceptance Criteria

- พิมพ์ "กระดาษ" → list เหลือเฉพาะพัสดุชื่อ/รหัสที่มีคำนั้น จัดกลุ่มหมวดถูกต้อง
- ล้างช่องค้นหา → list กลับเต็ม
- เลือกพัสดุแล้วพิมพ์ค้นหา → ค่าที่เลือกคงอยู่ถ้ายังตรง filter
- ทั้งฟอร์มใหม่และ Modal แก้ไขทำงานเหมือนกัน
- Vitest + Frontend static tests ผ่าน 100%, typecheck 0 errors
