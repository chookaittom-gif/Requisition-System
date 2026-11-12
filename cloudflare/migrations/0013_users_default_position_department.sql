-- 0013_users_default_position_department.sql
-- Set default department to 'สำนักงานศูนย์การศึกษา' and standardize position to 'เจ้าหน้าที่' for existing admin/officer accounts.

UPDATE users
SET department = 'สำนักงานศูนย์การศึกษา'
WHERE TRIM(COALESCE(department, '')) = '';

UPDATE users
SET position = 'เจ้าหน้าที่'
WHERE TRIM(COALESCE(position, '')) IN ('', 'ผู้ดูแลระบบ', 'เจ้าหน้าที่พัสดุ', 'เจ้าหน้าที่สำนักงาน (พัสดุ)');
