-- Phase 4: Robustness & Validation Schema Updates

-- Players: Add status, last_imported_at, import_source
ALTER TABLE players ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'pending'));
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_imported_at TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN IF NOT EXISTS import_source TEXT;

-- Coaches: Add last_imported_at, import_source
-- Note: Coaches already has a 'status' column.
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS last_imported_at TIMESTAMPTZ;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS import_source TEXT;
