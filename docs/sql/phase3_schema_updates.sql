-- Phase 3: Full Fidelity Schema Updates

-- Players: Add contact_info and emergency_contacts
ALTER TABLE players ADD COLUMN IF NOT EXISTS contact_info JSONB DEFAULT '{}'::jsonb;
ALTER TABLE players ADD COLUMN IF NOT EXISTS emergency_contacts JSONB DEFAULT '[]'::jsonb;

-- Coaches: Add contact_info
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS contact_info JSONB DEFAULT '{}'::jsonb;

-- Note: medical_info already exists from Phase 2, but we will expand its content in the JSONB.
-- No DDL needed for expanding JSONB content, just data update.
