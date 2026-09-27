-- ===========================================================================
-- Do NOT run against production.
--
-- This recreates the JWT-claim-trusting "Admins can manage organizations"
-- policy. That policy never existed in production (verified by the
-- 2026-09-27 read-only drift check), so running this there would ADD a
-- tenant-root write path production has never had.
--
-- The production-correct revert of 20260726000100 is only:
--
--   DROP POLICY IF EXISTS "Organizations: admins manage" ON public.organizations;
--
-- This file is for the repo chain / local harness only.
-- ===========================================================================
--
-- Revert for 20260726000100_fix_organizations_write_policy.sql
--
-- Restores the original JWT-claim-trusting write policy. Run only to roll
-- the hardening back -- this reopens the tenant-root privilege-escalation
-- path the migration closes.

BEGIN;

DROP POLICY IF EXISTS "Organizations: admins manage" ON public.organizations;

CREATE POLICY "Admins can manage organizations"
    ON public.organizations
    FOR ALL
    TO authenticated
    USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin');

COMMIT;
