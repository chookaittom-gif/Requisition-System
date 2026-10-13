-- 0004_seed_office_categories.sql
-- Remove legacy medical default categories and seed 5 office supply categories.

DELETE FROM categories WHERE name IN (
  'วัสดุสิ้นเปลือง',
  'เครื่องมือแพทย์',
  'อุปกรณ์ป้องกัน',
  'ยาและเวชภัณฑ์',
  'อื่นๆ'
);

INSERT INTO categories (id, name, created_at) VALUES
  ('CAT-DOC01', 'หมวดงานเอกสารและกระดาษ', datetime('now', '+7 hours')),
  ('CAT-PEN01', 'หมวดเครื่องเขียนและอุปกรณ์ตัด', datetime('now', '+7 hours')),
  ('CAT-TAP01', 'หมวดอุปกรณ์ยึดติดและเทป', datetime('now', '+7 hours')),
  ('CAT-IT001', 'หมวดอุปกรณ์ไอทีและวัสดุคอมพิวเตอร์', datetime('now', '+7 hours')),
  ('CAT-HOM01', 'หมวดงานบ้านงานครัวสำนักงาน', datetime('now', '+7 hours'))
ON CONFLICT(name) DO NOTHING;
