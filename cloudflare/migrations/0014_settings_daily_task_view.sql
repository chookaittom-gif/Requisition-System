-- 0014_settings_daily_task_view.sql
-- Admin-chosen "daily task" menu id shown first in the mobile shortcut grid. Additive; default keeps today's order.
ALTER TABLE settings ADD COLUMN daily_task_view TEXT NOT NULL DEFAULT 'a-dash';
