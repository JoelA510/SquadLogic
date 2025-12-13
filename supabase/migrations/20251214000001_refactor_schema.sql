-- Refactor Schema Migration (Phases 2-10)
-- Applies enhancements from Refactor.md to the consolidated schema.

BEGIN;

-- ==========================================
-- 1. DIVISIONS (Phase 8)
-- ==========================================
-- Change max_roster_size to integer
ALTER TABLE divisions ALTER COLUMN max_roster_size TYPE integer;
-- Add format column if it doesn't exist
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS format text;


-- ==========================================
-- 2. PLAYERS (Phases 2-5, 10)
-- ==========================================
-- Add expanded data columns
ALTER TABLE players ADD COLUMN IF NOT EXISTS medical_info jsonb DEFAULT '{}'::jsonb;
ALTER TABLE players ADD COLUMN IF NOT EXISTS registration_history jsonb DEFAULT '[]'::jsonb;
ALTER TABLE players ADD COLUMN IF NOT EXISTS contact_info jsonb DEFAULT '{}'::jsonb;
ALTER TABLE players ADD COLUMN IF NOT EXISTS emergency_contacts jsonb DEFAULT '[]'::jsonb;
ALTER TABLE players ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'pending'));
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_imported_at timestamptz;
ALTER TABLE players ADD COLUMN IF NOT EXISTS import_source text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS location_lat double precision;
ALTER TABLE players ADD COLUMN IF NOT EXISTS location_lng double precision;
ALTER TABLE players ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS flags jsonb DEFAULT '[]'::jsonb;

-- Phase 10: Volunteer and Buddy Info
ALTER TABLE players ADD COLUMN IF NOT EXISTS willing_to_coach boolean DEFAULT false;
ALTER TABLE players ADD COLUMN IF NOT EXISTS buddy_request text;


-- ==========================================
-- 3. COACHES (Phases 2-5)
-- ==========================================
-- Change certifications to JSONB (handling conversion if data exists is up to the user, assuming empty or string for now)
-- We will add a temporary column, cast, and drop old if needed, or just ALTER if postgres allows simple cast.
-- Since it was TEXT, we might need a USING clause if data exists.
-- For safety in this refactor, we'll try to ALTER with USING.
ALTER TABLE coaches ALTER COLUMN certifications TYPE jsonb USING CASE WHEN certifications IS NULL THEN '[]'::jsonb ELSE to_jsonb(certifications) END;
ALTER TABLE coaches ALTER COLUMN certifications SET DEFAULT '[]'::jsonb;

-- Add expanded data
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS contact_info jsonb DEFAULT '{}'::jsonb;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS last_imported_at timestamptz;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS import_source text;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS location_lat double precision;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS location_lng double precision;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS flags jsonb DEFAULT '[]'::jsonb;


-- ==========================================
-- 4. FIELDS (Phase 6)
-- ==========================================
ALTER TABLE fields ADD COLUMN IF NOT EXISTS max_age text;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS priority_rating integer DEFAULT 1;
ALTER TABLE fields ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;


-- ==========================================
-- 5. PRACTICE SLOTS (Phase 7)
-- ==========================================
ALTER TABLE practice_slots ADD COLUMN IF NOT EXISTS label text;


COMMIT;
