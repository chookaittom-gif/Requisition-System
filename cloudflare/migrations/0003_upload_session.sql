-- 0003_upload_session.sql — keeps the Google resumable-session URL and owner server-side.
-- upload_owner: session user id of the uploader ('' for guest); only that actor may finish/proxy.
ALTER TABLE drive_files ADD COLUMN upload_url TEXT NOT NULL DEFAULT '';
ALTER TABLE drive_files ADD COLUMN upload_owner TEXT NOT NULL DEFAULT '';
