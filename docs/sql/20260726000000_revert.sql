-- ===========================================================================
-- Do NOT run against production.
--
-- This recreates the broad "Unified org access on teams/coaches/locations"
-- ALL policies. Those never existed in production (verified by the
-- 2026-09-27 read-only drift check; production's equivalent hole was the
-- dashboard-only "Enforce Org Membership: ALL", reconciled by
-- 20260928000000_reconcile_prod_rls_drift.sql). Running this there would ADD
-- a member-write path production has never had.
--
-- The production-correct revert of 20260726000000 is a NO-OP: its DROP POLICY
-- IF EXISTS statements dropped nothing there, so there is nothing to restore.
-- This file is for the repo chain / local harness only.
-- ===========================================================================
--
-- Revert for 20260726000000_drop_stale_broad_write_policies.sql
--
-- Restores the broad org-member ALL policies on teams, coaches, and
-- locations. Run only to roll the hardening back -- this reopens the
-- privilege-escalation path the migration closes.

BEGIN;

CREATE POLICY "Unified org access on teams"
  ON public.teams FOR ALL TO authenticated
  USING (is_org_member(organization_id))
  WITH CHECK (is_org_member(organization_id));

CREATE POLICY "Unified org access on coaches"
  ON public.coaches FOR ALL TO authenticated
  USING (is_org_member(organization_id))
  WITH CHECK (is_org_member(organization_id));

CREATE POLICY "Unified org access on locations"
  ON public.locations FOR ALL TO authenticated
  USING (is_org_member(organization_id))
  WITH CHECK (is_org_member(organization_id));

COMMIT;
