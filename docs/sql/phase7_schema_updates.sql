-- Phase 7: Field Generator Schema Updates

-- Practice Slots: Add label for easier debugging/UI
ALTER TABLE practice_slots ADD COLUMN IF NOT EXISTS label TEXT;
