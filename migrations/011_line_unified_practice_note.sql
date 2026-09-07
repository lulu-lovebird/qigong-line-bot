BEGIN;

ALTER TABLE checkin_logs
    ADD COLUMN IF NOT EXISTS practice_note TEXT;

CREATE OR REPLACE FUNCTION sync_line_practice_note_from_legacy()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT' AND NEW.practice_note IS NULL)
       OR (
           TG_OP = 'UPDATE'
           AND NEW.practice_note IS NOT DISTINCT FROM OLD.practice_note
           AND (
               NEW.reflection_note IS DISTINCT FROM OLD.reflection_note
               OR NEW.body_feeling_note IS DISTINCT FROM OLD.body_feeling_note
           )
       ) THEN
        NEW.practice_note := CASE
            WHEN COALESCE(BTRIM(NEW.reflection_note, E' \t\n\r'), '') <> ''
                 AND COALESCE(BTRIM(NEW.body_feeling_note, E' \t\n\r'), '') <> ''
                THEN '練功心得：' || BTRIM(NEW.reflection_note, E' \t\n\r')
                     || E'\n身體感受：' || BTRIM(NEW.body_feeling_note, E' \t\n\r')
            WHEN COALESCE(BTRIM(NEW.reflection_note, E' \t\n\r'), '') <> ''
                THEN BTRIM(NEW.reflection_note, E' \t\n\r')
            WHEN COALESCE(BTRIM(NEW.body_feeling_note, E' \t\n\r'), '') <> ''
                THEN BTRIM(NEW.body_feeling_note, E' \t\n\r')
            ELSE NULL
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_line_practice_note_from_legacy ON checkin_logs;
CREATE TRIGGER sync_line_practice_note_from_legacy
BEFORE INSERT OR UPDATE OF reflection_note, body_feeling_note, practice_note
ON checkin_logs
FOR EACH ROW
EXECUTE FUNCTION sync_line_practice_note_from_legacy();

UPDATE checkin_logs
SET practice_note = CASE
    WHEN COALESCE(BTRIM(reflection_note, E' \t\n\r'), '') <> ''
         AND COALESCE(BTRIM(body_feeling_note, E' \t\n\r'), '') <> ''
        THEN '練功心得：' || BTRIM(reflection_note, E' \t\n\r')
             || E'\n身體感受：' || BTRIM(body_feeling_note, E' \t\n\r')
    WHEN COALESCE(BTRIM(reflection_note, E' \t\n\r'), '') <> ''
        THEN BTRIM(reflection_note, E' \t\n\r')
    WHEN COALESCE(BTRIM(body_feeling_note, E' \t\n\r'), '') <> ''
        THEN BTRIM(body_feeling_note, E' \t\n\r')
    ELSE NULL
END
WHERE practice_note IS NULL
  AND (
      COALESCE(BTRIM(reflection_note, E' \t\n\r'), '') <> ''
      OR COALESCE(BTRIM(body_feeling_note, E' \t\n\r'), '') <> ''
  );

COMMIT;
