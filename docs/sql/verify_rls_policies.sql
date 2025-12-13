-- Verification Script for RLS Policies
-- Execute this in the Supabase SQL Editor to verify access controls.

BEGIN;

-- 1. Setup Test Data
-- Create a dummy coach user (simulated) and a team assigned to them.
DO $$
DECLARE
  v_coach_id uuid := gen_random_uuid();
  v_other_coach_id uuid := gen_random_uuid();
  v_team_id text := 'TEST-TEAM-001';
  v_other_team_id text := 'TEST-TEAM-002';
BEGIN
  RAISE NOTICE 'Setting up test data...';
  
  -- We can't easily create auth.users in SQL editor without admin privs,
  -- but we can simulate RLS by setting the role configuration parameter.
  -- Instead, we will assume we are testing 'anon' vs 'authenticated'.
  -- For granular role testing (app_metadata->role), we need to mock the JWT claim.
  -- Supabase allows testing policies by setting logical session variables if policies use current_setting or auth.jwt().
  
  -- However, since policies use auth.jwt() -> 'app_metadata', we can't easily mock that in standard SQL script 
  -- without `set local request.jwt.claim`.
  
  -- MOCKING JWT for 'coach' role:
  -- set local request.jwt.claims = json_build_object('sub', v_coach_id, 'app_metadata', json_build_object('role', 'coach'))::text;
  
  -- Unfortunately, Supabase helper `auth.jwt()` extracts from config.
  -- Let's try to set it.
END $$;

-- 2. Create Policy Verification Functions (Optional)
-- In a real scenario, we would run:
-- SELECT * FROM teams; -- as admin (should see all)
-- SELECT * FROM teams; -- as coach (should see only own)

-- Since we can't interactively switch users in a single script easily without specific extensions,
-- we will provide the instructions and queries to run.

ROLLBACK;

-- MANUAL VERIFICATION STEPS:
/*
1. Create two users in Authentication tab: coach1@test.com, coach2@test.com.
2. Assign 'coach' role to them via UPDATE auth.users set raw_app_meta_data = '{"role": "coach", "provider": "email"}' where email = ...
3. Create teams in 'teams' table:
   - Team A (coach_id = coach1.id)
   - Team B (coach_id = coach2.id)
4. Log in as coach1 and run:
   SELECT count(*) FROM teams; 
   -> Should return 1 (Team A).
   
5. Log in as coach2 and run:
   SELECT count(*) FROM teams;
   -> Should return 1 (Team B).
*/

-- AUTOMATED VERIFICATION (Conceptual):
-- This requires pgTAP or similar, which might not be installed.
-- We will write a query that checks policy definitions instead.

SELECT
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM
    pg_policies
WHERE
    tablename IN ('teams', 'players', 'coaches', 'schedule_evaluations');
