-- 0006_settings_line_to.sql
-- LINE Messaging API push target (Group ID or User ID). settings.line_token now holds the Channel access token.

ALTER TABLE settings ADD COLUMN line_to TEXT NOT NULL DEFAULT '';
