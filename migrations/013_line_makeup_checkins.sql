BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS practice_timezone TEXT,
    ADD COLUMN IF NOT EXISTS practice_timezone_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS practice_timezone_updated_at TIMESTAMP WITH TIME ZONE;

UPDATE users
SET practice_timezone = 'Asia/Taipei'
WHERE practice_timezone IS NULL;

ALTER TABLE users
    ALTER COLUMN practice_timezone SET DEFAULT 'Asia/Taipei',
    ALTER COLUMN practice_timezone SET NOT NULL;

ALTER TABLE checkin_logs
    ADD COLUMN IF NOT EXISTS entry_kind VARCHAR(16) NOT NULL DEFAULT 'regular',
    ADD COLUMN IF NOT EXISTS practice_timezone TEXT;

UPDATE checkin_logs
SET practice_timezone = 'Asia/Taipei'
WHERE practice_timezone IS NULL;

ALTER TABLE checkin_logs
    ALTER COLUMN practice_timezone SET DEFAULT 'Asia/Taipei',
    ALTER COLUMN practice_timezone SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'checkin_logs_entry_kind_check'
    ) THEN
        ALTER TABLE checkin_logs
            ADD CONSTRAINT checkin_logs_entry_kind_check
            CHECK (entry_kind IN ('regular', 'makeup'));
    END IF;
END $$;

COMMIT;
