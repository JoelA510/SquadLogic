-- Phase 10: Teaming Logic Schema Updates

-- Players: Add willing_to_coach and buddy_request
ALTER TABLE players ADD COLUMN IF NOT EXISTS willing_to_coach BOOLEAN DEFAULT false;
ALTER TABLE players ADD COLUMN IF NOT EXISTS buddy_request TEXT; -- Name of requested buddy
