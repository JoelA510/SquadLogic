-- Phase 6: Field Schema & Scheduling Updates

-- Fields: Add max_age, priority_rating, active
ALTER TABLE fields ADD COLUMN IF NOT EXISTS max_age TEXT; -- e.g., 'U12'
ALTER TABLE fields ADD COLUMN IF NOT EXISTS priority_rating INTEGER DEFAULT 1; -- Higher = Better priority
ALTER TABLE fields ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

-- Note: Daylight adjustments are handled by creating specific practice_slots with valid_from/valid_until ranges.
-- No schema change needed for practice_slots as it already supports this.
