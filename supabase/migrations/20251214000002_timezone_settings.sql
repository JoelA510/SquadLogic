-- Add Timezone and School Hours to Season Settings

BEGIN;

-- Add timezone column (IANA format, e.g., 'America/Los_Angeles')
ALTER TABLE season_settings ADD COLUMN IF NOT EXISTS timezone text;

-- Add school_day_end column (Time of day, defaults to 4 PM)
ALTER TABLE season_settings ADD COLUMN IF NOT EXISTS school_day_end time DEFAULT '16:00';

COMMIT;
