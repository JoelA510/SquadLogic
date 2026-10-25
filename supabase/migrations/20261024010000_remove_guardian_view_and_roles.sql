-- No guardian view, and no `parent` or `player` organization role (plan
-- docs/changes/2026-10-22-admin-focus.md, R3; owner decisions 2026-10-22,
-- docs/product.md "Non-goals").
--
-- **Why.** SquadLogic is for league admins and coaches; families stay on the
-- league's registration platform. The owner removed the guardian view, and
-- with it the two roles only a family member held. Production held no
-- guardian link, no `parent` or `player` member and no invite for either role
-- when this was written (read-only, 2026-10-24: `profile_players` 0 rows,
-- `organization_members` 1 row, an admin; `organization_invites` 0 rows; no
-- organization storing `guardian_contact_sharing`), so nothing is lost.
--
-- **Read policies first.** `players_select_admin_or_guardian` and
-- `team_players_select_admin_or_guardian` (20261021020000) hold the admin read
-- and the guardian read in one expression that names `profile_players`;
-- dropping that table with CASCADE would drop the admin read too. So each is
-- replaced first by an admin-only policy (`is_org_admin`: admin, tenant_admin
-- and staff), and every drop below names its object with no CASCADE, so
-- anything still depending on one fails the migration.
--
-- **A coach reads names only, through the roster read.** Row security
-- chooses rows, not columns, and a column grant would bind every
-- `authenticated` caller, admins included (they read `players` directly).
-- So a coach gets no direct read of either table, as before (the guardian arm
-- never admitted one), and reads their own teams' players through
-- `get_team_roster`, which returns a current coach the names and jersey
-- number and nothing else: no guardian contacts (R4 drops those columns), no
-- gender, years played, rating or coaching interest.
--
-- **The change.**
--   1. A guard: the migration refuses to run while any member or invite holds
--      `parent` or `player`; what the drops destroy is counted in a NOTICE.
--   2. `players_select_admin` and `team_players_select_admin` (SELECT,
--      authenticated, `is_org_admin(organization_id)`) are created, then the
--      two admin-or-guardian policies dropped.
--   3. `team_calendar_tokens_select` loses its guardian arm (ALTER POLICY:
--      admins and staff, or a current coach of the team).
--   4. `get_team_roster(uuid)` is recreated (its result loses `is_my_child`,
--      which nothing reads since R2, so CREATE OR REPLACE cannot do it) from
--      its latest body (20261021010000) without the guardian arm, the
--      `guardian_contact_sharing` setting and the contact card lookup: admins
--      and staff read guardian contacts in full, as imported; a current coach
--      reads names and jersey number only. Grants and comment restated.
--   5. `get_team_staff(uuid)` is replaced from its latest body
--      (20261021010000) without the guardian arm. Its contact columns stay
--      (R4 takes them out).
--   6. Dropped, exact signatures: `link_my_guardian_records()`,
--      `is_team_guardian(uuid)`, `guardian_contacts_view(uuid, jsonb,
--      boolean)`; then the policy `profile_players_select_own_or_admin` and
--      the table `profile_players` (its key and foreign keys go with it).
--   7. The roles: `organization_members_role_check` (admin, coach, staff,
--      tenant_admin) and `organization_invites_role_check` (admin, coach,
--      staff) are replaced, and `create_org_invite` and
--      `admin_change_member_role` refuse `parent` and `player` (22023). Both
--      bodies are their latest repo definitions (20260421034626 and
--      20261020030000) with only the role list changed; production's
--      `create_org_invite` differs from its file only by the file's comments
--      (read 2026-10-24). The roles are text CHECK constraints, not an enum,
--      so no type is rebuilt.
--   8. An end-state check: `players` and `team_players` each have exactly one
--      SELECT or ALL policy, the admin one, and nothing in `public` names a
--      dropped object.
--
-- **Kept.** The `guardian.linked` audit action (old audit rows reference
-- it). The `guardian_contact_sharing` key may stay in a stored
-- `feature_flags`; nothing reads it now. `players.guardian_contacts`, the
-- contact card and `get_coach_directory` are R4's.
--
-- Reversible in structure only: docs/sql/20261024010000_revert.sql restores
-- every object as it stood before this migration, `profile_players` empty. It
-- cannot restore the guardian links this drops; the NOTICE below counts them.
-- Smoke checks: docs/sql/20261024010000_smoke.sql.
-- pgTAP: supabase/tests/guardian_view_removed.sql and
-- supabase/tests/rls_policy_matrix.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The guard, and what the drops destroy.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_members bigint;
    v_invites bigint;
    v_links bigint;
    v_flags bigint;
BEGIN
    SELECT count(*) INTO v_members FROM public.organization_members WHERE role IN ('parent', 'player');
    SELECT count(*) INTO v_invites FROM public.organization_invites WHERE role IN ('parent', 'player');
    IF v_members > 0 OR v_invites > 0 THEN
        -- A member's access is a decision for an admin, not for a migration.
        RAISE EXCEPTION 'refusing to remove the parent and player roles: % member(s) and % invite(s) still hold one',
            v_members, v_invites USING ERRCODE = '55000';
    END IF;
    SELECT count(*) INTO v_links FROM public.profile_players;
    SELECT count(*) INTO v_flags FROM public.organizations WHERE feature_flags ? 'guardian_contact_sharing';
    RAISE NOTICE 'dropping % guardian link(s); % organization(s) store guardian_contact_sharing, which is no longer read',
        v_links, v_flags;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The people read policies: the admin read on its own, then the old ones.
-- ---------------------------------------------------------------------------

CREATE POLICY players_select_admin ON public.players
    FOR SELECT TO authenticated
    USING (public.is_org_admin(organization_id));

CREATE POLICY team_players_select_admin ON public.team_players
    FOR SELECT TO authenticated
    USING (public.is_org_admin(organization_id));

DROP POLICY players_select_admin_or_guardian ON public.players;
DROP POLICY team_players_select_admin_or_guardian ON public.team_players;

-- ---------------------------------------------------------------------------
-- 3. The calendar token: admins and staff, or a current coach.
-- ---------------------------------------------------------------------------

ALTER POLICY team_calendar_tokens_select ON public.team_calendar_tokens
    USING (
        public.is_org_admin((SELECT t.organization_id FROM public.teams t WHERE t.id = team_id))
        OR public.is_current_team_coach(team_id)
    );

COMMENT ON TABLE public.team_calendar_tokens IS
    'A team''s calendar feed credential, moved out of teams so only admins/staff and the team''s current coaches read it. Written by the teams insert trigger and rotate_calendar_token only. 20261021020000; guardians out 20261024010000.';

-- ---------------------------------------------------------------------------
-- 4. get_team_roster: from 20261021010000 without the guardian arm.
-- ---------------------------------------------------------------------------

DROP FUNCTION public.get_team_roster(uuid);

CREATE FUNCTION public.get_team_roster(p_team_id uuid)
RETURNS TABLE (
    player_id uuid,
    first_name text,
    last_name text,
    preferred_name text,
    jersey_number smallint,
    guardian_contacts jsonb,
    gender text,
    years_played smallint,
    rating smallint,
    willing_to_coach boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
    v_org uuid;
    v_admin boolean;
    v_coach boolean := false;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'get_team_roster requires a signed-in caller' USING ERRCODE = '42501';
    END IF;
    SELECT t.organization_id INTO v_org FROM public.teams t WHERE t.id = p_team_id;
    v_admin := v_org IS NOT NULL AND public.is_org_admin(v_org);
    IF v_org IS NOT NULL AND NOT v_admin THEN
        v_coach := public.is_current_team_coach(p_team_id);
    END IF;
    IF NOT (v_admin OR v_coach) THEN
        RAISE EXCEPTION 'not permitted to read this team''s roster' USING ERRCODE = '42501';
    END IF;

    -- A current coach reads names and jersey number; every other column is
    -- an admin's.
    RETURN QUERY
    SELECT p.id,
           p.first_name,
           p.last_name,
           p.preferred_name,
           p.jersey_number,
           CASE
               WHEN v_admin THEN (
                   SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                              'name', g.c ->> 'name',
                              'email', g.c ->> 'email',
                              'phone', g.c ->> 'phone',
                              'alternate_email', g.c ->> 'alternate_email')) ORDER BY g.ord), '[]'::jsonb)
                     FROM jsonb_array_elements(
                              CASE WHEN jsonb_typeof(p.guardian_contacts) = 'array'
                                   THEN p.guardian_contacts ELSE '[]'::jsonb END
                          ) WITH ORDINALITY AS g(c, ord)
                    WHERE jsonb_typeof(g.c) = 'object')
               ELSE '[]'::jsonb
           END,
           CASE WHEN v_admin THEN p.gender END,
           CASE WHEN v_admin THEN p.years_played END,
           CASE WHEN v_admin THEN p.rating END,
           CASE WHEN v_admin THEN p.willing_to_coach END
      FROM public.team_players tp
      JOIN public.players p ON p.id = tp.player_id
     WHERE tp.team_id = p_team_id
     ORDER BY p.last_name, p.first_name, p.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_team_roster(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_team_roster(uuid) TO authenticated;
COMMENT ON FUNCTION public.get_team_roster(uuid) IS
    'Team roster: admins/staff read every column, guardian contacts as imported; a current coach of the team reads names and jersey number only. 20261021010000; guardians out 20261024010000.';

-- ---------------------------------------------------------------------------
-- 5. get_team_staff: from 20261021010000 without the guardian arm.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_team_staff(p_team_id uuid)
RETURNS TABLE (
    coach_id uuid,
    full_name text,
    role text,
    phone text,
    email text,
    status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
    v_org uuid;
    v_admin boolean;
    v_today date;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'get_team_staff requires a signed-in caller' USING ERRCODE = '42501';
    END IF;
    SELECT t.organization_id INTO v_org FROM public.teams t WHERE t.id = p_team_id;
    v_admin := v_org IS NOT NULL AND public.is_org_admin(v_org);
    IF NOT (v_admin
            OR (v_org IS NOT NULL AND public.is_current_team_coach(p_team_id))) THEN
        RAISE EXCEPTION 'not permitted to read this team''s staff' USING ERRCODE = '42501';
    END IF;
    v_today := public.team_local_today(p_team_id);

    RETURN QUERY
    SELECT c.id,
           c.full_name,
           a.role,
           CASE WHEN pr.share_contact IS NULL THEN c.phone
                WHEN pr.share_contact THEN pr.contact_phone END,
           CASE WHEN pr.share_contact IS NULL THEN c.email
                WHEN pr.share_contact THEN pr.contact_email END,
           CASE WHEN v_admin THEN c.status END
      FROM public.team_coach_assignments a
      JOIN public.coaches c ON c.id = a.coach_id
      LEFT JOIN public.profiles pr ON pr.id = c.user_id
     WHERE a.team_id = p_team_id
       AND a.effective_from <= v_today
       AND (a.effective_to IS NULL OR a.effective_to >= v_today)
     ORDER BY (a.role = 'lead') DESC, c.full_name, c.id;
END;
$$;

COMMENT ON FUNCTION public.get_team_staff(uuid) IS
    'Current coaches of a team with contact details (contact card wins); admins/staff and a current coach of the team. 20261021010000; guardians out 20261024010000.';

-- ---------------------------------------------------------------------------
-- 6. The guardian functions, then the link table.
-- ---------------------------------------------------------------------------

DROP FUNCTION public.link_my_guardian_records();
DROP FUNCTION public.is_team_guardian(uuid);
DROP FUNCTION public.guardian_contacts_view(uuid, jsonb, boolean);

DROP POLICY profile_players_select_own_or_admin ON public.profile_players;
DROP TABLE public.profile_players;

-- ---------------------------------------------------------------------------
-- 7. The roles.
-- ---------------------------------------------------------------------------

ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_role_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_role_check
    CHECK (role = ANY (ARRAY['admin'::text, 'coach'::text, 'staff'::text, 'tenant_admin'::text]));

ALTER TABLE public.organization_invites DROP CONSTRAINT organization_invites_role_check;
ALTER TABLE public.organization_invites ADD CONSTRAINT organization_invites_role_check
    CHECK (role = ANY (ARRAY['admin'::text, 'coach'::text, 'staff'::text]));

CREATE OR REPLACE FUNCTION public.create_org_invite(
  p_org_id     uuid,
  p_role       text,
  p_expires_in interval DEFAULT interval '7 days'
)
RETURNS TABLE (code text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code       text;
  v_expires_at timestamptz;
  v_attempts   int := 0;
BEGIN
  -- Authz: caller must be admin of the target org.
  IF NOT public.is_org_admin(p_org_id) THEN
    RAISE EXCEPTION 'Not authorized to create invites for this organization'
      USING ERRCODE = '42501';  -- insufficient_privilege
  END IF;

  -- Role whitelist (matches the CHECK constraint).
  IF p_role NOT IN ('admin', 'coach', 'staff') THEN
    RAISE EXCEPTION 'Invalid role: %', p_role USING ERRCODE = '22023';
  END IF;

  v_expires_at := CASE
    WHEN p_expires_in IS NULL THEN NULL
    ELSE now() + p_expires_in
  END;

  -- Retry up to 5 times on code collision (probability ≈ 0 at current volume).
  LOOP
    v_attempts := v_attempts + 1;
    v_code := public.generate_invite_code();
    BEGIN
      INSERT INTO public.organization_invites (code, organization_id, role, created_by, expires_at)
      VALUES (v_code, p_org_id, p_role, auth.uid(), v_expires_at);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempts >= 5 THEN
        RAISE EXCEPTION 'Could not generate a unique invite code after % attempts', v_attempts;
      END IF;
    END;
  END LOOP;

  RETURN QUERY SELECT v_code, v_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_change_member_role(
    p_organization_id uuid,
    p_profile_id      uuid,
    p_role            text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_id   uuid := auth.uid();
    v_old_role    text;
    v_admin_count integer;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '23502';
    END IF;
    IF p_profile_id IS NULL THEN
        RAISE EXCEPTION 'p_profile_id is required' USING ERRCODE = '23502';
    END IF;
    IF p_role IS NULL OR p_role NOT IN ('admin', 'coach', 'staff') THEN
        RAISE EXCEPTION 'invalid role: %', p_role USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT role INTO v_old_role
    FROM public.organization_members
    WHERE organization_id = p_organization_id AND profile_id = p_profile_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found in organization' USING ERRCODE = 'P0002';
    END IF;

    -- Block demoting the last admin-equivalent member (including yourself).
    IF v_old_role IN ('admin', 'tenant_admin', 'staff') AND p_role NOT IN ('admin', 'tenant_admin', 'staff') THEN
        SELECT count(*) INTO v_admin_count
        FROM public.organization_members
        WHERE organization_id = p_organization_id AND role IN ('admin', 'tenant_admin', 'staff');
        IF v_admin_count <= 1 THEN
            RAISE EXCEPTION 'Cannot demote the last admin of the organization'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    UPDATE public.organization_members
    SET role = p_role
    WHERE organization_id = p_organization_id AND profile_id = p_profile_id;

    IF v_old_role IS DISTINCT FROM p_role THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'member.role_changed',
            'organization_members',
            p_profile_id,
            jsonb_build_object('previous_role', v_old_role, 'role', p_role)
        );
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. The end state.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname) INTO v_bad
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename IN ('players', 'team_players')
       AND cmd IN ('SELECT', 'ALL')
       AND policyname NOT IN ('players_select_admin', 'team_players_select_admin');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'another read policy remains on the people tables: %', v_bad;
    END IF;
    IF (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename IN ('players', 'team_players')
           AND cmd = 'SELECT' AND qual = 'is_org_admin(organization_id)') <> 2 THEN
        RAISE EXCEPTION 'the admin read policy is missing from players or team_players';
    END IF;

    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_bad
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prosrc ~ '(profile_players|is_team_guardian|guardian_contacts_view|link_my_guardian_records|guardian_contact_sharing)';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'a function still names a dropped guardian object: %', v_bad;
    END IF;
    SELECT string_agg(tablename || '.' || policyname, ', ') INTO v_bad
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (coalesce(qual, '') || coalesce(with_check, '')) ~ '(profile_players|is_team_guardian)';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'a policy still names a dropped guardian object: %', v_bad;
    END IF;
END;
$$;

COMMIT;
