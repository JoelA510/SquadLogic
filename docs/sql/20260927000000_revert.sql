-- Revert for 20260927000000_reconcile_prod_rls_drift.sql
--
-- **This revert deliberately does NOT restore what the migration dropped.**
--
--   * "Enforce Org Membership: ALL" is never recreated. It came from a
--     dashboard-only migration (`rls_hardening_stage_1`) that no repo file
--     contains, and it let every org member -- coach, parent, player --
--     INSERT, UPDATE and DELETE coaches, teams, locations, fields, divisions,
--     game_assignments, import_jobs, imports, team_messages,
--     organization_schemas and schedule_evaluations. Re-opening that is not a
--     rollback, it is re-introducing the defect. No application path needs it:
--     every write to those tables goes through a SECURITY DEFINER admin RPC or
--     a service-role Edge Function.
--   * "org_member_access" on practice_slots and field_subunits is not
--     recreated either, for the same reason: it is the same member-write
--     grant under an older name (20260416000000_security_hardening.sql:70).
--   * The read policies the migration created are LEFT IN PLACE. They are the
--     repository's own policies, defined by earlier migrations (cited in the
--     migration), and on the repo chain the migration never created them.
--     Dropping them here would take away the only member read path on six
--     tables in production.
--
-- So the revert removes only what this migration added as an object: the
-- owner-only `public.reconcile_prod_rls_drift()` function. If a reviewer ever
-- needs the literal pre-migration repo-chain state, the statement is:
--
--   CREATE POLICY "org_member_access" ON public.<practice_slots|field_subunits>
--     FOR ALL TO authenticated USING (is_org_member(organization_id));
--
-- and it must not be run against production, which never had it.

BEGIN;

DROP FUNCTION IF EXISTS public.reconcile_prod_rls_drift();

DO $$
DECLARE
    v_broad int;
BEGIN
    IF to_regprocedure('public.reconcile_prod_rls_drift()') IS NOT NULL THEN
        RAISE EXCEPTION 'revert failed: public.reconcile_prod_rls_drift() still exists';
    END IF;
    SELECT count(*) INTO v_broad FROM pg_policies WHERE policyname = 'Enforce Org Membership: ALL';
    IF v_broad <> 0 THEN
        RAISE EXCEPTION 'revert must not leave "Enforce Org Membership: ALL" standing; found on % table(s)', v_broad;
    END IF;
    -- The read policies production lacked must survive the revert.
    SELECT count(*) INTO v_broad FROM pg_policies
     WHERE schemaname = 'public' AND cmd = 'SELECT' AND (tablename, policyname) IN (
        ('coaches', 'Coaches: members access'), ('teams', 'Teams: members access'),
        ('game_assignments', 'Game Assignments: members access'), ('imports', 'Imports: members access'),
        ('import_jobs', 'Import Jobs: members access'),
        ('schedule_evaluations', 'Schedule Evaluations: members access'),
        ('import_jobs', 'Users can view their organization''s import jobs'),
        ('practice_slots', 'Practice Slots: members select'),
        ('field_subunits', 'Field Subunits: members select'));
    IF v_broad <> 9 THEN
        RAISE EXCEPTION 'revert took read policies with it: % of 9 remain', v_broad;
    END IF;
    v_broad := 0;
    RAISE NOTICE 'revert verified: reconcile_prod_rls_drift() gone; "Enforce Org Membership: ALL" present on % table(s) and NOT recreated by this revert; read policies left in place.', v_broad;
END;
$$;

COMMIT;
