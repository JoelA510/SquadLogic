-- Who the caller is (owner decisions 2026-10-20; plan
-- docs/changes/2026-10-20-phase-a-privacy.md, A2 items 1 and 2).
--
-- **1. A signed-in coach gets a coach identity.** Nothing set
-- `coaches.user_id` (0 of 130 production rows linked, read 2026-10-20), so the
-- pages that find "my coach record" by it (practice preferences, lighting
-- overrides) found nothing for any coach. `link_my_coach_record()` links the
-- caller's account to the coach row whose email matches the caller's verified
-- auth email, case-insensitively, in an organization the caller belongs to.
--   * Verified means `auth.users.email_confirmed_at` is set. That is proof of
--     the address only while the project confirms emails on sign-up; production
--     does (its last self sign-up was sent a confirmation and confirmed it, read
--     2026-10-20). The local config does not (`enable_confirmations = false`),
--     which is fine for local data and wrong for production.
--   * Only a coach in the roles a team can be given links: status 'active' or
--     'pending-confirmation', the test `set_team_coaches` and the coach admin
--     RPCs apply. An 'interested' lead (a parent who ticked "willing to coach")
--     or an 'inactive' coach does not.
--   * `coaches.user_id` is unique, so an account links at most one row.
--     `coaches.email` is unique only as typed, so rows differing in case can
--     both match; a row already linked to the caller wins, then an unlinked
--     one, then the oldest.
--   * Idempotent: a row already linked to the caller returns 'already_linked'.
--     A row linked to another account is refused ('linked_to_another'), and an
--     account already linked elsewhere is refused ('caller_already_linked');
--     neither changes anything. A link writes one `coach.linked` audit row.
--   * Returns jsonb `{status, coach_id, organization_id}`; it raises only for a
--     caller with no session.
--
-- **2. A profile's role and organization are no longer self-editable.** The
-- "Profiles: users update own" policy admits the caller's own row, and the table
-- grant let that update reach every column, `role` and `organization_id`
-- included (read 2026-10-20). No server authorization reads either, but the UI
-- and some settings modules trust them. UPDATE is now granted on the four
-- columns a user edits on the account page (first_name, last_name, full_name,
-- avatar_url) and on no other; anon loses UPDATE entirely (it has no policy).
-- Definer functions that maintain the profile (handle_new_user, the
-- registration RPCs) run as the owner and are unaffected.
--
-- Revert: docs/sql/20261020040000_revert.sql. Smoke: docs/sql/20261020040000_smoke.sql.
-- pgTAP: supabase/tests/identity_guards.sql.

BEGIN;

-- `audit_log.action` is a foreign key to `audit_actions` (20260613000006).
INSERT INTO public.audit_actions (action) VALUES ('coach.linked')
    ON CONFLICT (action) DO NOTHING;

CREATE OR REPLACE FUNCTION public.link_my_coach_record()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_email text;
    v_coach public.coaches%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'link_my_coach_record requires a signed-in caller' USING ERRCODE = '42501';
    END IF;

    SELECT lower(trim(u.email)) INTO v_email
      FROM auth.users u
     WHERE u.id = v_uid AND u.email_confirmed_at IS NOT NULL;
    IF v_email IS NULL OR v_email = '' THEN
        RETURN jsonb_build_object('status', 'email_not_verified');
    END IF;

    SELECT c.* INTO v_coach
      FROM public.coaches c
     WHERE lower(trim(c.email)) = v_email
       AND c.status IN ('active', 'pending-confirmation')
       AND EXISTS (SELECT 1 FROM public.organization_members m
                    WHERE m.organization_id = c.organization_id AND m.profile_id = v_uid)
     ORDER BY (c.user_id IS NOT DISTINCT FROM v_uid) DESC, (c.user_id IS NULL) DESC,
              c.created_at, c.id
     LIMIT 1
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'no_match');
    END IF;

    IF v_coach.user_id = v_uid THEN
        RETURN jsonb_build_object('status', 'already_linked', 'coach_id', v_coach.id,
                                  'organization_id', v_coach.organization_id);
    END IF;
    IF v_coach.user_id IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'linked_to_another', 'coach_id', v_coach.id,
                                  'organization_id', v_coach.organization_id);
    END IF;
    IF EXISTS (SELECT 1 FROM public.coaches c WHERE c.user_id = v_uid) THEN
        RETURN jsonb_build_object('status', 'caller_already_linked', 'coach_id', v_coach.id,
                                  'organization_id', v_coach.organization_id);
    END IF;

    UPDATE public.coaches SET user_id = v_uid WHERE id = v_coach.id;

    PERFORM public.record_audit_event(
        v_coach.organization_id, 'coach.linked', 'coaches', v_coach.id,
        jsonb_build_object('user_id', v_uid, 'matched_email', v_email,
                           'coach_email', v_coach.email, 'previous_user_id', v_coach.user_id)
    );

    RETURN jsonb_build_object('status', 'linked', 'coach_id', v_coach.id,
                              'organization_id', v_coach.organization_id);
END;
$$;

REVOKE ALL ON FUNCTION public.link_my_coach_record() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_my_coach_record() TO authenticated;
COMMENT ON FUNCTION public.link_my_coach_record() IS
    'Links the caller to the coach row matching their verified email in an organization they belong to. Idempotent; audited. 20261020040000.';

REVOKE UPDATE ON public.profiles FROM anon, authenticated;
GRANT UPDATE (first_name, last_name, full_name, avatar_url) ON public.profiles TO authenticated;

COMMIT;
