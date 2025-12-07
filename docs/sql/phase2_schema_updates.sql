-- Phase 2: Schema Refinement for Real Data

-- Players: Add medical_info and registration_history
ALTER TABLE players ADD COLUMN IF NOT EXISTS medical_info JSONB DEFAULT '{}'::jsonb;
ALTER TABLE players ADD COLUMN IF NOT EXISTS registration_history JSONB DEFAULT '[]'::jsonb;

-- Coaches: Change certifications to JSONB
-- Dropping and re-adding to change type from TEXT to JSONB. Data will be re-populated by import script.
ALTER TABLE coaches DROP COLUMN IF EXISTS certifications;
ALTER TABLE coaches ADD COLUMN certifications JSONB DEFAULT '[]'::jsonb;
