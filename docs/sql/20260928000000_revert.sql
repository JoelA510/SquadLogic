-- Revert for 20260928000000_reconcile_prod_rls_drift.sql
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
--   * "org_member_access" on practice_slots, field_subunits and
--     scheduler_runs is not recreated either, for the same reason: it is the
--     same member-write grant under an older name
--     (20260416000000_security_hardening.sql:70).
--   * scheduler_runs_select_member / scheduler_runs_write_admin are LEFT IN
--     PLACE: without "org_member_access" they are that table's only read path
--     and the only path by which the SECURITY INVOKER persist_practice_schedule
--     can write it as an admin.
--   * The read policies the migration created are LEFT IN PLACE. They are the
--     repository's own policies, defined by earlier migrations (cited in the
--     migration), and on the repo chain the migration never created them.
--     Dropping them here would take away the only member read path on six
--     tables in production.
--
-- So the revert removes only what this migration added as objects: the
-- owner-only `public.reconcile_prod_rls_drift()` and
-- `public.rls_member_write_allowlist()` functions. If a reviewer ever
-- needs the literal pre-migration repo-chain state, the statement is:
--
--   CREATE POLICY "org_member_access" ON public.<practice_slots|field_subunits|scheduler_runs>
--     FOR ALL TO authenticated USING (is_org_member(organization_id));
--
-- and it must not be run against production, which never had it.

BEGIN;

DROP FUNCTION IF EXISTS public.reconcile_prod_rls_drift();
DROP FUNCTION IF EXISTS public.rls_member_write_allowlist();

DO $$
DECLARE
    v_broad int;
BEGIN
    IF to_regprocedure('public.reconcile_prod_rls_drift()') IS NOT NULL THEN
        RAISE EXCEPTION 'revert failed: public.reconcile_prod_rls_drift() still exists';
    END IF;
    IF to_regprocedure('public.rls_member_write_allowlist()') IS NOT NULL THEN
        RAISE EXCEPTION 'revert failed: public.rls_member_write_allowlist() still exists';
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
        ('field_subunits', 'Field Subunits: members select'),
        ('scheduler_runs', 'scheduler_runs_select_member'));
    IF v_broad <> 10 THEN
        RAISE EXCEPTION 'revert took read policies with it: % of 10 remain', v_broad;
    END IF;
    v_broad := 0;
    RAISE NOTICE 'revert verified: reconcile_prod_rls_drift() and rls_member_write_allowlist() gone; "Enforce Org Membership: ALL" present on % table(s) and NOT recreated by this revert; read policies left in place.', v_broad;
END;
$$;

COMMIT;
