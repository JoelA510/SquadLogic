-- Register `members.invited_joined`, the audit action `redeem_org_invite`
-- writes when someone joins an organization with an invite code
-- (20260421034626_invite_code_system.sql).
--
-- `audit_log.action` is a foreign key to `audit_actions`
-- (20260613000006_audit_actions_lookup.sql). The action has been written by the
-- function since invites shipped and was never registered, here or in
-- production (checked read-only against production before this migration: not
-- in `audit_actions`, the production body of `redeem_org_invite` names it, and
-- `audit_log` holds no `members.%` row). The audit call is in the redeem's own
-- transaction and is not best-effort: the `pg_proc` guard around it only tests
-- that `record_audit_event` exists. So the insert fails with 23503 and takes
-- the membership row and the used invite down with it, and every redemption
-- that adds a member rolls back. No smoke or test ever redeemed an invite.
--
-- A sweep of every other writer found no further unregistered action: each
-- action named in a `record_audit_event` call or an `INSERT INTO audit_log` in
-- the migrations, the Edge Functions and the frontend is registered by a
-- migration, and the action built from a status (`coach_preference.<status>`,
-- `practice_lighting_override.<status>`) or chosen by a CASE
-- (`coach.promoted`, `team.coach_*`) resolves to registered ones.
--
-- The end-state check fails the migration if the registration is missing, or
-- if `redeem_org_invite` no longer names the action it registers.
--
-- Reversible: see docs/sql/20261029020000_revert.sql.
-- Smoke checks: see docs/sql/20261029020000_smoke.sql.
-- pgTAP: supabase/tests/invite_redemption_audit.sql.

BEGIN;

INSERT INTO public.audit_actions (action) VALUES ('members.invited_joined')
    ON CONFLICT (action) DO NOTHING;

DO $check$
DECLARE
    v_body text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'members.invited_joined') THEN
        RAISE EXCEPTION 'members.invited_joined is not registered in audit_actions';
    END IF;

    SELECT p.prosrc INTO v_body
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'redeem_org_invite'
       AND pg_get_function_identity_arguments(p.oid) = 'p_code text';
    IF v_body IS NULL THEN
        RAISE EXCEPTION 'public.redeem_org_invite(p_code text) does not exist';
    END IF;
    IF position('''members.invited_joined''' IN v_body) = 0 THEN
        RAISE EXCEPTION 'redeem_org_invite does not write members.invited_joined; this migration registers an action nothing writes';
    END IF;
END;
$check$;

COMMIT;
