-- Phase 8: Team Size Caps Schema Updates

-- Divisions: Add max_roster_size and format
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS max_roster_size INTEGER;
ALTER TABLE divisions ADD COLUMN IF NOT EXISTS format TEXT; -- e.g., '5v5', '7v7', '9v9', '11v11'
