-- 0005_category_code.sql
-- Add code column to categories table for category prefix in material codes.

ALTER TABLE categories ADD COLUMN code TEXT;

UPDATE categories SET code = 'DOC' WHERE name = 'หมวดงานเอกสารและกระดาษ';
UPDATE categories SET code = 'PEN' WHERE name = 'หมวดเครื่องเขียนและอุปกรณ์ตัด';
UPDATE categories SET code = 'TAP' WHERE name = 'หมวดอุปกรณ์ยึดติดและเทป';
UPDATE categories SET code = 'IT'  WHERE name = 'หมวดอุปกรณ์ไอทีและวัสดุคอมพิวเตอร์';
UPDATE categories SET code = 'HOM' WHERE name = 'หมวดงานบ้านงานครัวสำนักงาน';

CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_code ON categories (code);
