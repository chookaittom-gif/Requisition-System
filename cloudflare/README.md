# ระบบเบิกจ่ายพัสดุ บน Cloudflare (Worker + D1)

ย้ายจาก Google Apps Script มาเป็น Cloudflare Worker + D1 โดยโค้ด GAS เดิมใน `Code/` ยังอยู่เป็นต้นฉบับอ้างอิงและสำรอง (ห้ามแก้)
ทุกคำสั่งในหัวข้อ "ขึ้นระบบจริง" ที่มี `--remote` หรือ `wrangler deploy` ต้องได้รับอนุมัติจากเจ้าของระบบทีละขั้นก่อนรันเสมอ

## สารบัญ
1. ตั้งค่าและรันในเครื่อง
2. Secrets
3. Google OAuth refresh token (อัปโหลดไฟล์ขึ้น Drive)
4. ขึ้นระบบจริง (ทีละขั้น)
5. Backup และ Rollback
6. ตรวจรับหลัง deploy
7. ปิด GAS เดิม

## 1. ตั้งค่าและรันในเครื่อง
```bash
cd cloudflare
npm install
cp .dev.vars.example .dev.vars      # แล้วกรอกค่า 4 ตัว (ไฟล์นี้ไม่ถูก commit)
npm run db:migrate:local            # สร้างตารางใน D1 local
npm run dev                         # http://localhost:8787
```
ตรวจคุณภาพ: `npm run typecheck`, `npm test`, `npm run db:smoke:local`, `npm run db:negative:local`

## 2. Secrets
ตั้งด้วย `npx wrangler secret put <ชื่อ>` (ระบบจะถามค่าแบบไม่แสดงบนจอ) ห้ามใส่ใน git หรือ frontend

| Secret | ความหมาย |
|---|---|
| `PW_SALT` | salt ที่ใช้ตรวจรหัสผ่านแบบ `sha256$` เดิม |
| `GOOGLE_CLIENT_ID` | OAuth client ของ Google Cloud |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | refresh token ของเจ้าของโฟลเดอร์ Drive (หัวข้อ 3) |

**สำคัญมาก: `PW_SALT` ต้องเป็น salt ที่ใช้งานจริงของระบบเดิม (effective legacy salt)** ถ้าผิด ทุกคนจะล็อกอินไม่ได้
- ถ้าตั้ง Script Property ชื่อ `PW_SALT` ไว้ใน Apps Script (Project Settings → Script Properties) ให้ใช้ค่านั้น
- ถ้าไม่ได้ตั้ง ระบบเดิมจะใช้ค่าคงที่ `LEGACY_SALT` ใน `Code/code.gs` (บรรทัด 315, ฟังก์ชัน `getSalt_` บรรทัด 317-320 ใช้ Script Property ก่อน แล้วค่อย fallback)
- ห้ามคัดลอกค่า salt ลงในเอกสารนี้หรือ git

ค่า `DRIVE_ROOT_FOLDER_ID` เป็น var ใน `wrangler.jsonc` (ไม่ใช่ secret)
หมายเหตุ: Telegram bot token เก็บในตาราง `settings` (คอลัมน์ `telegram_bot_token`, migration 0002) ไม่ใช่ secret ของ Worker; comment เก่าใน `0001_init.sql` ที่บอกว่าเป็น secret ล้าสมัยแล้ว (ไม่แก้ไฟล์ migration ที่ apply แล้ว) หน้า Settings แสดง token แบบปิดบัง `••••` + 4 ตัวท้าย

## 3. Google OAuth refresh token
ต้องใช้บัญชี Google ที่เป็นเจ้าของโฟลเดอร์ Drive รากตาม `DRIVE_ROOT_FOLDER_ID` และ scope `https://www.googleapis.com/auth/drive`
1. Google Cloud Console → สร้าง/เลือกโปรเจกต์ → เปิดใช้ Google Drive API → สร้าง OAuth client (ประเภท Web application) และเพิ่ม Authorized redirect URI: `https://developers.google.com/oauthplayground`
2. เปิด https://developers.google.com/oauthplayground → ไอคอนเฟือง → ติ๊ก "Use your own OAuth credentials" แล้วกรอก Client ID / Client secret
3. Step 1: ใส่ scope `https://www.googleapis.com/auth/drive` → Authorize APIs → ล็อกอินด้วยบัญชีเจ้าของโฟลเดอร์ → อนุญาต
4. Step 2: Exchange authorization code for tokens → คัดลอก `refresh_token`
5. `npx wrangler secret put GOOGLE_REFRESH_TOKEN` (และ `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
6. ถ้า OAuth consent screen เป็นโหมด Testing refresh token จะหมดอายุใน 7 วัน ให้เปลี่ยนเป็น In production

## 4. ขึ้นระบบจริง (ทีละขั้น ต้องได้รับอนุมัติทุกขั้น)
ชื่อฐานข้อมูล D1 คือ `ims_db` (ตรวจ `database_name` / `database_id` ใน `wrangler.jsonc` กับ Cloudflare dashboard ก่อนเสมอ)

1. **ตรวจตารางบน remote แบบอ่านอย่างเดียว** (ก่อนทำอะไรทั้งสิ้น):
   `npx wrangler d1 execute ims_db --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"`
2. **Backup:** `npx wrangler d1 export ims_db --remote --output backups/pre-change-<วันที่>.sql` (โฟลเดอร์ `backups/` ถูก gitignore)
3. **Migration:** `npx wrangler d1 migrations apply ims_db --remote`
4. **สร้าง seed จากไฟล์ export ของ Sheet** (ไฟล์ผลลัพธ์มีรหัสผ่านแฮชและ token ห้าม commit):
   ```bash
   npm run seed:build -- "../docs/ระบบเบิกจ่ายพัสดุ.xlsx"      # เขียน seeds/legacy-seed.sql
   ```
   สคริปต์ map ตาราง Users ตามลำดับ `HEADERS.Users` (ไม่ใช่ header ใน sheet ซึ่งมีแค่ 8 ชื่อ), แปลง role `staff` เป็น `officer`, ปฏิเสธแถวที่รหัสผ่านไม่ขึ้นต้น `sha256$`/`pbkdf2$` และ username ซ้ำ (รายงานเฉพาะ ID), ข้ามแถวที่ ID ว่าง และ import ซ้ำได้ปลอดภัย (`ON CONFLICT(id) DO UPDATE`) อ่านรายงานจำนวนแถวและคำเตือนท้ายคำสั่ง ถ้ามี warning `email-not-text` ให้ตรวจลำดับคอลัมน์ใน Sheet
   ทดสอบกับ local ก่อน: `npm run db:migrate:local && npx wrangler d1 execute DB --local --file seeds/legacy-seed.sql` แล้วตรวจจำนวนแถว
5. **Import seed:** `npx wrangler d1 execute ims_db --remote --file seeds/legacy-seed.sql`
6. **Secrets:** `npx wrangler secret put PW_SALT` ฯลฯ (หัวข้อ 2)
7. **Deploy:** `npx wrangler deploy`

ข้อมูลอื่น (Materials, Requests ฯลฯ) นำเข้าตาม `docs/data-mapping.md`

## 5. Backup และ Rollback
- Backup: `npx wrangler d1 export ims_db --remote --output backups/<ไฟล์>.sql`
- ย้อนฐานข้อมูล (Time Travel): `npx wrangler d1 time-travel restore ims_db --timestamp=<ISO ก่อนเปลี่ยน>` (ดูเวลาที่ย้อนได้ด้วย `npx wrangler d1 time-travel info ims_db`)
- ย้อน Worker เป็นเวอร์ชันก่อนหน้า: `npx wrangler rollback`
- ถ้ายังไม่ปิด GAS เดิม ให้กลับไปใช้ GAS ได้ทันที

## 6. ตรวจรับหลัง deploy (ทำด้วยมือ)
- [ ] ล็อกอินด้วยผู้ใช้เดิม (รหัสผ่านเดิมใช้ได้ และถูก rehash เป็น `pbkdf2$` หลังล็อกอินสำเร็จ)
- [ ] อัปโหลดไฟล์จริงทางตรง (direct upload ไป Drive) และทาง proxy ผ่าน Worker ให้สำเร็จ
- [ ] ปุ่มทดสอบ Telegram ส่งข้อความถึงกลุ่มได้
- [ ] อนุมัติใบเบิกที่สต็อกไม่พอ ต้องถูกปฏิเสธ (สต็อกไม่ติดลบ)
- [ ] ส่งออก XLSX แล้วเปิดใน Excel ได้ ภาษาไทยถูกต้อง

## 7. ปิด GAS เดิม
ยกเลิก deploy ของ GAS web app **หลังเจ้าของระบบตรวจรับผลในหัวข้อ 6 แล้วเท่านั้น** และเก็บ Google Sheet / `Code/` ไว้เป็นข้อมูลสำรอง
