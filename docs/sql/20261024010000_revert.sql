-- Revert for 20261024010000_remove_guardian_view_and_roles.sql
--
-- Restores, in structure, every object the migration dropped or replaced, as
-- it stood after 20261023010000: the `profile_players` table (EMPTY) with its
-- key, foreign keys, column comment, row security, read policy and grants;
-- `is_team_guardian`, `guardian_contacts_view` and `link_my_guardian_records`
-- with their comments and grants; `get_team_roster` with its `is_my_child`
-- column, and `get_team_staff`, each with its guardian arm; the two
-- admin-or-guardian read policies on `players` and `team_players` (and the
-- admin-only ones dropped); the calendar-token policy's guardian arm and the
-- table comment; the member and invite role checks admitting `parent` and
-- `player`, and `create_org_invite` and `admin_change_member_role` accepting
-- them.
--
-- The DDL is pg_dump's (16) of a harness build at 20261023010000, so each
-- function body is that build's text byte for byte; only the OWNER lines are
-- left out (the objects are created by the role that runs this).
-- `create_org_invite` comes back as its migration file wrote it; production's
-- copy is the same code without the file's comments (read 2026-10-24).
--
-- **What it cannot restore:** the guardian links the migration dropped. The
-- table comes back empty, and no guardian is linked until each signs in
-- again (`link_my_guardian_records`). The forward migration's NOTICE counted
-- what it dropped (production: 0 links, read 2026-10-24).
--
-- Verified: the harness compares a fingerprint of every restored object
-- (signature, posture, grants, comment and body md5 of the seven functions;
-- columns, constraints, grants, row security and policies of `profile_players`;
-- the read policies on `players`, `team_players` and `team_calendar_tokens`;
-- the two role checks) with the one read off a build at 20261023010000.

BEGIN;

-- 1. The link table, its key, foreign keys, row security, policy and grants.


CREATE TABLE public.profile_players (
    profile_id uuid NOT NULL,
    player_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    matched_email text
);

COMMENT ON COLUMN public.profile_players.matched_email IS 'The imported guardian address (lowercased) link_my_guardian_records matched this link on; the contact card applies to that contact even after the sign-in email changes. NULL for a registration link not yet matched. 20261021010000.';

ALTER TABLE ONLY public.profile_players
    ADD CONSTRAINT profile_players_pkey PRIMARY KEY (profile_id, player_id);

ALTER TABLE ONLY public.profile_players
    ADD CONSTRAINT profile_players_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.profile_players
    ADD CONSTRAINT profile_players_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.profile_players
    ADD CONSTRAINT profile_players_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.profile_players ENABLE ROW LEVEL SECURITY;

CREATE POLICY profile_players_select_own_or_admin ON public.profile_players FOR SELECT TO authenticated USING (((public.is_org_member(organization_id) AND (profile_id = ( SELECT auth.uid() AS uid))) OR public.is_org_admin(organization_id)));

GRANT ALL ON TABLE public.profile_players TO anon;
GRANT ALL ON TABLE public.profile_players TO authenticated;
GRANT ALL ON TABLE public.profile_players TO service_role;

-- 2. The three guardian functions, with their comments and grants.

CREATE FUNCTION public.is_team_guardian(p_team_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.profile_players pp
          JOIN public.team_players tp ON tp.player_id = pp.player_id
         WHERE tp.team_id = p_team_id
           AND pp.profile_id = auth.uid()
           AND public.is_org_member(tp.organization_id)
    );
$$;

REVOKE ALL ON FUNCTION public.is_team_guardian(p_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_team_guardian(p_team_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_team_guardian(p_team_id uuid) TO service_role;

CREATE FUNCTION public.guardian_contacts_view(p_player_id uuid, p_contacts jsonb, p_primary_only boolean) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT COALESCE(jsonb_agg(x.contact ORDER BY x.ord), '[]'::jsonb)
      FROM (
        SELECT g.ord,
               CASE
                   WHEN card.share_contact IS NULL THEN jsonb_strip_nulls(jsonb_build_object(
                       'name', g.c ->> 'name',
                       'email', g.c ->> 'email',
                       'phone', g.c ->> 'phone',
                       'alternate_email', CASE WHEN NOT p_primary_only THEN g.c ->> 'alternate_email' END))
                   WHEN card.share_contact THEN jsonb_strip_nulls(jsonb_build_object(
                       'name', g.c ->> 'name',
                       'email', card.contact_email,
                       'phone', card.contact_phone))
                   ELSE jsonb_strip_nulls(jsonb_build_object('name', g.c ->> 'name'))
               END AS contact
          FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(p_contacts) = 'array' THEN p_contacts ELSE '[]'::jsonb END
               ) WITH ORDINALITY AS g(c, ord)
          LEFT JOIN LATERAL (
              SELECT pr.share_contact, pr.contact_email, pr.contact_phone
                FROM public.profile_players pp
                JOIN auth.users u ON u.id = pp.profile_id
                JOIN public.profiles pr ON pr.id = pp.profile_id
               WHERE pp.player_id = p_player_id
                 AND (lower(trim(pp.matched_email)) IN (lower(trim(g.c ->> 'email')),
                                                       lower(trim(g.c ->> 'alternate_email')))
                      OR (u.email_confirmed_at IS NOT NULL
                          AND lower(trim(u.email)) IN (lower(trim(g.c ->> 'email')),
                                                       lower(trim(g.c ->> 'alternate_email')))))
               ORDER BY (pr.share_contact IS NULL), pp.created_at, pp.profile_id
               LIMIT 1
          ) card ON true
         WHERE jsonb_typeof(g.c) = 'object'
           AND (NOT p_primary_only OR g.ord = 1)
      ) x;
$$;

-- Internal, as 20261021010000 made it: no client role executes it (the
-- default privileges would otherwise give authenticated EXECUTE).
REVOKE ALL ON FUNCTION public.guardian_contacts_view(p_player_id uuid, p_contacts jsonb, p_primary_only boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guardian_contacts_view(p_player_id uuid, p_contacts jsonb, p_primary_only boolean) FROM anon, authenticated;
GRANT ALL ON FUNCTION public.guardian_contacts_view(p_player_id uuid, p_contacts jsonb, p_primary_only boolean) TO service_role;

CREATE FUNCTION public.link_my_guardian_records() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_email text;
    v_linked integer := 0;
    v_total integer;
    r record;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'link_my_guardian_records requires a signed-in caller' USING ERRCODE = '42501';
    END IF;

    SELECT lower(trim(u.email)) INTO v_email
      FROM auth.users u
     WHERE u.id = v_uid AND u.email_confirmed_at IS NOT NULL;
    IF v_email IS NULL OR v_email = '' THEN
        RETURN jsonb_build_object('status', 'email_not_verified', 'linked', 0);
    END IF;

    FOR r IN
        SELECT p.id, p.organization_id
          FROM public.players p
         WHERE EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.organization_id = p.organization_id AND m.profile_id = v_uid)
           AND jsonb_typeof(p.guardian_contacts) = 'array'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.guardian_contacts) g(c)
                        WHERE jsonb_typeof(g.c) = 'object'
                          AND v_email IN (lower(trim(g.c ->> 'email')),
                                          lower(trim(g.c ->> 'alternate_email'))))
         ORDER BY p.organization_id, p.id
    LOOP
        -- A link made at registration records the address it matches now.
        UPDATE public.profile_players
           SET matched_email = v_email
         WHERE profile_id = v_uid AND player_id = r.id AND matched_email IS NULL;
        INSERT INTO public.profile_players (profile_id, player_id, organization_id, matched_email)
        VALUES (v_uid, r.id, r.organization_id, v_email)
        ON CONFLICT (profile_id, player_id) DO NOTHING;
        IF FOUND THEN
            v_linked := v_linked + 1;
            PERFORM public.record_audit_event(
                r.organization_id, 'guardian.linked', 'players', r.id,
                jsonb_build_object('profile_id', v_uid, 'matched_email', v_email)
            );
        END IF;
    END LOOP;

    SELECT count(*) INTO v_total FROM public.profile_players WHERE profile_id = v_uid;

    RETURN jsonb_build_object(
        'status', CASE WHEN v_linked > 0 THEN 'linked'
                       WHEN v_total > 0 THEN 'already_linked'
                       ELSE 'no_match' END,
        'linked', v_linked);
END;
$$;

COMMENT ON FUNCTION public.link_my_guardian_records() IS 'Links the caller to each player whose imported guardian email matches their verified email, in organizations they belong to. Idempotent; audited. 20261021010000.';

REVOKE ALL ON FUNCTION public.link_my_guardian_records() FROM PUBLIC;
GRANT ALL ON FUNCTION public.link_my_guardian_records() TO authenticated;
GRANT ALL ON FUNCTION public.link_my_guardian_records() TO service_role;

-- 3. The roster read with its guardian arm and `is_my_child` column (the result
--    type changes, so it is dropped and created), and the staff read's body.

DROP FUNCTION public.get_team_roster(uuid);

CREATE FUNCTION public.get_team_roster(p_team_id uuid) RETURNS TABLE(player_id uuid, first_name text, last_name text, preferred_name text, jersey_number smallint, is_my_child boolean, guardian_contacts jsonb, gender text, years_played smallint, rating smallint, willing_to_coach boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
#variable_conflict use_column
DECLARE
    v_org uuid;
    v_admin boolean;
    v_coach boolean := false;
    v_guardian boolean := false;
    v_share boolean;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'get_team_roster requires a signed-in caller' USING ERRCODE = '42501';
    END IF;
    SELECT t.organization_id INTO v_org FROM public.teams t WHERE t.id = p_team_id;
    v_admin := v_org IS NOT NULL AND public.is_org_admin(v_org);
    IF v_org IS NOT NULL AND NOT v_admin THEN
        v_coach := public.is_current_team_coach(p_team_id);
        IF NOT v_coach THEN
            v_guardian := public.is_team_guardian(p_team_id);
        END IF;
    END IF;
    IF NOT (v_admin OR v_coach OR v_guardian) THEN
        RAISE EXCEPTION 'not permitted to read this team''s roster' USING ERRCODE = '42501';
    END IF;
    v_share := public.org_flag(v_org, 'guardian_contact_sharing', true);

    RETURN QUERY
    SELECT p.id,
           p.first_name,
           p.last_name,
           p.preferred_name,
           p.jersey_number,
           mine.is_mine,
           CASE
               WHEN v_admin OR v_coach OR mine.is_mine
                   THEN public.guardian_contacts_view(p.id, p.guardian_contacts, false)
               WHEN v_share
                   THEN public.guardian_contacts_view(p.id, p.guardian_contacts, true)
               ELSE '[]'::jsonb
           END,
           CASE WHEN v_admin THEN p.gender END,
           CASE WHEN v_admin THEN p.years_played END,
           CASE WHEN v_admin THEN p.rating END,
           CASE WHEN v_admin THEN p.willing_to_coach END
      FROM public.team_players tp
      JOIN public.players p ON p.id = tp.player_id
     CROSS JOIN LATERAL (
         SELECT EXISTS (SELECT 1 FROM public.profile_players pp
                         WHERE pp.player_id = p.id AND pp.profile_id = auth.uid()) AS is_mine
     ) mine
     WHERE tp.team_id = p_team_id
     ORDER BY p.last_name, p.first_name, p.id;
END;
$$;

COMMENT ON FUNCTION public.get_team_roster(p_team_id uuid) IS 'Team roster per the Phase A access table (admins/staff, current coach, guardian on the team); guardian contacts pass through contact cards. 20261021010000.';

REVOKE ALL ON FUNCTION public.get_team_roster(p_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_team_roster(p_team_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_team_roster(p_team_id uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_team_staff(p_team_id uuid) RETURNS TABLE(coach_id uuid, full_name text, role text, phone text, email text, status text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
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
            OR (v_org IS NOT NULL AND (public.is_current_team_coach(p_team_id)
                                       OR public.is_team_guardian(p_team_id)))) THEN
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

COMMENT ON FUNCTION public.get_team_staff(p_team_id uuid) IS 'Current coaches of a team with contact details (contact card wins); admins/staff, current coach, guardian on the team. 20261021010000.';

-- 4. The read policies: the admin-or-guardian ones back, the admin-only ones
--    gone, the calendar token's guardian arm back.

CREATE POLICY players_select_admin_or_guardian ON public.players FOR SELECT TO authenticated USING ((public.is_org_admin(organization_id) OR (public.is_org_member(organization_id) AND (id IN ( SELECT pp.player_id
   FROM public.profile_players pp
  WHERE (pp.profile_id = ( SELECT auth.uid() AS uid)))))));

CREATE POLICY team_players_select_admin_or_guardian ON public.team_players FOR SELECT TO authenticated USING ((public.is_org_admin(organization_id) OR (public.is_org_member(organization_id) AND (player_id IN ( SELECT pp.player_id
   FROM public.profile_players pp
  WHERE (pp.profile_id = ( SELECT auth.uid() AS uid)))))));

DROP POLICY players_select_admin ON public.players;
DROP POLICY team_players_select_admin ON public.team_players;

ALTER POLICY team_calendar_tokens_select ON public.team_calendar_tokens USING ((public.is_org_admin(( SELECT t.organization_id
   FROM public.teams t
  WHERE (t.id = team_calendar_tokens.team_id))) OR public.is_current_team_coach(team_id) OR public.is_team_guardian(team_id)));

COMMENT ON TABLE public.team_calendar_tokens IS 'A team''s calendar feed credential, moved out of teams so only admins/staff, the team''s current coaches and its guardians read it. Written by the teams insert trigger and rotate_calendar_token only. 20261021020000.';

-- 5. The roles.

ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_role_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'coach'::text, 'player'::text, 'parent'::text, 'staff'::text, 'tenant_admin'::text])));

ALTER TABLE public.organization_invites DROP CONSTRAINT organization_invites_role_check;
ALTER TABLE public.organization_invites ADD CONSTRAINT organization_invites_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'coach'::text, 'player'::text, 'parent'::text, 'staff'::text])));

CREATE OR REPLACE FUNCTION public.create_org_invite(p_org_id uuid, p_role text, p_expires_in interval DEFAULT '7 days'::interval) RETURNS TABLE(code text, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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
  IF p_role NOT IN ('admin', 'coach', 'player', 'parent', 'staff') THEN
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

COMMENT ON FUNCTION public.create_org_invite(p_org_id uuid, p_role text, p_expires_in interval) IS 'Admin-only. Mints a single-use invite code for the given org + role.';

CREATE OR REPLACE FUNCTION public.admin_change_member_role(p_organization_id uuid, p_profile_id uuid, p_role text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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
    IF p_role IS NULL OR p_role NOT IN ('admin', 'coach', 'player', 'parent', 'staff') THEN
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

COMMENT ON FUNCTION public.admin_change_member_role(p_organization_id uuid, p_profile_id uuid, p_role text) IS 'Audited org member role change; blocks demoting last admin.';

COMMIT;
