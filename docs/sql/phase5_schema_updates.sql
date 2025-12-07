-- Phase 5: Advanced Schema Optimizations

-- Players: Add location_lat, location_lng, timezone, flags
ALTER TABLE players ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION;
ALTER TABLE players ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION;
ALTER TABLE players ADD COLUMN IF NOT EXISTS timezone TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS flags JSONB DEFAULT '[]'::jsonb;

-- Coaches: Add location_lat, location_lng, timezone, flags
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS timezone TEXT;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS flags JSONB DEFAULT '[]'::jsonb;
