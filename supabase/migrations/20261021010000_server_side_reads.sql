-- Who reads what, part one: the server-side reads (owner decisions 2026-10-20;
-- plan docs/changes/2026-10-20-phase-a-privacy.md, A3 and "A3 as built").
--
-- This migration is ADDITIVE. It adds the identity helpers, the guardian link,
-- the contact card, and the reads that apply the plan's access table, and the
-- pages move onto them in the same PR. No table policy changes here: every
-- table stays as readable as it was. The restriction is the next migration
-- (A3b), once nothing a non-admin page needs is read directly.
--
-- **Identity helpers** (definer, so a later restriction of the tables they read
-- does not lock out the people they admit):
--   * `team_local_today(team)`: today's date in the team's season timezone
--     (teams -> divisions -> season_settings.timezone), UTC when unset. A zone
--     PostgreSQL cannot read (one stored before `admin_set_season_timezone`
--     validated it) is treated as unset. Never `current_date`, which follows the
--     caller's session zone (a PostgREST caller sets it per request).
--   * `is_current_team_coach(team)`: the caller's linked coach row
--     (`coaches.user_id`, A2b) has a `team_coach_assignments` row for the team
--     whose INCLUSIVE window holds that date.
--   * `is_team_guardian(team)`: a `profile_players` link from the caller to a
--     player on the team's roster (`team_players`).
--   Both also require the caller to be a member of the team's organization, so
--   a removed member keeps no access through a stale link.
--
-- **Guardian link.** In-app registration writes `profile_players`; imported
-- players have none. `link_my_guardian_records()` links the caller to every
-- player in their organizations whose imported guardian email or alternate
-- email matches their verified auth email, case-insensitively: the rule
-- `link_my_coach_record()` uses for coaches. Idempotent; each new link writes
-- one `guardian.linked` audit row.
--
-- **Contact card (A2c).** `profiles.contact_phone`, `contact_email` and
-- `share_contact`. `share_contact` is NULL until the user saves the card, and
-- imported details show; `true` shows the card's phone and email in their
-- place; `false` shows neither. A card applies to a guardian contact whose
-- email or alternate email is the verified email of an account linked to that
-- player, and to a coach through `coaches.user_id`. Profiles are readable only
-- by their owner, so the reads below are the only way a card reaches anyone.
-- `set_my_contact_card()` is its only writer (the column grant of A2b does not
-- include these columns). It changes what other members are shown, so each
-- save writes one `profile.contact_card_updated` audit row in every
-- organization the caller belongs to, carrying the sharing choice and whether a
-- phone and an email are set, never the values.
--
-- **League settings** (organization feature flags, absent = on):
-- `guardian_contact_sharing` (guardians see each teammate's primary guardian
-- contact) and `coach_directory` (current coaches see every current coach's
-- contact details).
--
-- **Reads**, each refusing (42501) a caller the access table does not admit,
-- including for a team id that does not exist, so the refusal reveals nothing:
--   * `get_team_roster(team)`: admins, staff, a current coach of the team, a
--     guardian on the team. Names and jersey number for all; guardian contacts
--     in full to admins, staff and the coach, and to a guardian for their own
--     children; to a guardian for teammates, the primary contact (the first)
--     with name, email and phone, unless `guardian_contact_sharing` is off.
--     Gender, years played, rating and coaching interest to admins and staff only.
--   * `get_team_staff(team)`: the same callers; every current coach, with name,
--     role, phone and email (status to admins and staff only).
--   * `get_coach_directory(org)`: admins and staff; a current coach of any
--     team in the organization while `coach_directory` is on.
--   * `get_my_coached_team_ids(org)`: the teams the caller currently coaches.
--
-- Revert: docs/sql/20261021010000_revert.sql. Smoke: docs/sql/20261021010000_smoke.sql.
-- pgTAP: supabase/tests/server_side_reads.sql.

BEGIN;

-- `audit_log.action` is a foreign key to `audit_actions` (20260613000006).
INSERT INTO public.audit_actions (action) VALUES ('guardian.linked'), ('profile.contact_card_updated')
    ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Contact card
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS contact_phone text,
    ADD COLUMN IF NOT EXISTS contact_email text,
    ADD COLUMN IF NOT EXISTS share_contact boolean;

ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_contact_phone_check
        CHECK (contact_phone IS NULL OR contact_phone ~ '^\+?[0-9() .-]{7,32}$'),
    ADD CONSTRAINT profiles_contact_email_check
        CHECK (contact_email IS NULL
               OR (length(contact_email) <= 254 AND contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

COMMENT ON COLUMN public.profiles.share_contact IS
    'Contact card: NULL = never saved (imported details show), true = card phone/email show, false = no contact details show. 20261021010000.';

CREATE OR REPLACE FUNCTION public.set_my_contact_card(
    p_phone text,
    p_email text,
    p_share boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_phone text := NULLIF(trim(p_phone), '');
    v_email text := NULLIF(trim(p_email), '');
    v_org uuid;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'set_my_contact_card requires a signed-in caller' USING ERRCODE = '42501';
    END IF;
    IF p_share IS NULL THEN
        RAISE EXCEPTION 'p_share is required' USING ERRCODE = '23502';
    END IF;
    IF v_phone IS NOT NULL AND v_phone !~ '^\+?[0-9() .-]{7,32}$' THEN
        RAISE EXCEPTION 'contact phone is not a phone number' USING ERRCODE = '22023';
    END IF;
    IF v_email IS NOT NULL
       AND (length(v_email) > 254 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
        RAISE EXCEPTION 'contact email is not an email address' USING ERRCODE = '22023';
    END IF;

    UPDATE public.profiles
       SET contact_phone = v_phone,
           contact_email = v_email,
           share_contact = p_share
     WHERE id = v_uid;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no profile for the caller' USING ERRCODE = 'P0002';
    END IF;

    FOR v_org IN
        SELECT m.organization_id FROM public.organization_members m
         WHERE m.profile_id = v_uid ORDER BY m.organization_id
    LOOP
        PERFORM public.record_audit_event(
            v_org, 'profile.contact_card_updated', 'profiles', v_uid,
            jsonb_build_object('share_contact', p_share, 'has_phone', v_phone IS NOT NULL,
                               'has_email', v_email IS NOT NULL)
        );
    END LOOP;

    RETURN jsonb_build_object('contact_phone', v_phone, 'contact_email', v_email,
                              'share_contact', p_share);
END;
$$;

-- ---------------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.team_local_today(p_team_id uuid)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tz text;
BEGIN
    SELECT NULLIF(trim(ss.timezone), '') INTO v_tz
      FROM public.teams t
      LEFT JOIN public.divisions d ON d.id = t.division_id
      LEFT JOIN public.season_settings ss ON ss.id = d.season_settings_id
     WHERE t.id = p_team_id;
    IF v_tz IS NOT NULL THEN
        BEGIN
            RETURN (now() AT TIME ZONE v_tz)::date;
        EXCEPTION WHEN invalid_parameter_value THEN
            -- An unreadable stored zone counts as unset: UTC, below.
            NULL;
        END;
    END IF;
    RETURN (now() AT TIME ZONE 'UTC')::date;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_current_team_coach(p_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.team_coach_assignments a
          JOIN public.coaches c ON c.id = a.coach_id
         CROSS JOIN (SELECT public.team_local_today(p_team_id) AS today) d
         WHERE a.team_id = p_team_id
           AND c.user_id = auth.uid()
           AND a.effective_from <= d.today
           AND (a.effective_to IS NULL OR a.effective_to >= d.today)
           AND public.is_org_member(a.organization_id)
    );
$$;

CREATE OR REPLACE FUNCTION public.is_team_guardian(p_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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

CREATE OR REPLACE FUNCTION public.get_my_coached_team_ids(p_organization_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    -- Today is worked out once per team, not once per assignment row.
    WITH mine AS MATERIALIZED (
        SELECT a.team_id, a.effective_from, a.effective_to
          FROM public.team_coach_assignments a
          JOIN public.coaches c ON c.id = a.coach_id
         WHERE a.organization_id = p_organization_id
           AND c.user_id = auth.uid()
           AND public.is_org_member(p_organization_id)
    ), days AS MATERIALIZED (
        SELECT t.team_id, public.team_local_today(t.team_id) AS today
          FROM (SELECT DISTINCT team_id FROM mine) t
    )
    SELECT DISTINCT m.team_id
      FROM mine m
      JOIN days d ON d.team_id = m.team_id
     WHERE m.effective_from <= d.today
       AND (m.effective_to IS NULL OR m.effective_to >= d.today);
$$;

-- Internal: an organization's boolean flag, the default when absent or not a boolean.
CREATE OR REPLACE FUNCTION public.org_flag(p_organization_id uuid, p_key text, p_default boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT CASE WHEN jsonb_typeof(o.feature_flags -> p_key) = 'boolean'
                     THEN (o.feature_flags ->> p_key)::boolean END
           FROM public.organizations o
          WHERE o.id = p_organization_id),
        p_default);
$$;

-- Internal: a player's guardian contacts as a reader sees them, each passed
-- through the contact card of a linked account whose verified email is that
-- contact's email or alternate email. p_primary_only keeps the first contact
-- and drops the alternate email.
CREATE OR REPLACE FUNCTION public.guardian_contacts_view(
    p_player_id uuid,
    p_contacts jsonb,
    p_primary_only boolean
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
                 AND u.email_confirmed_at IS NOT NULL
                 AND lower(trim(u.email)) IN (lower(trim(g.c ->> 'email')),
                                              lower(trim(g.c ->> 'alternate_email')))
               ORDER BY (pr.share_contact IS NULL), pp.created_at, pp.profile_id
               LIMIT 1
          ) card ON true
         WHERE jsonb_typeof(g.c) = 'object'
           AND (NOT p_primary_only OR g.ord = 1)
      ) x;
$$;

-- ---------------------------------------------------------------------------
-- Guardian link
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.link_my_guardian_records()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
           AND NOT EXISTS (SELECT 1 FROM public.profile_players pp
                            WHERE pp.profile_id = v_uid AND pp.player_id = p.id)
         ORDER BY p.organization_id, p.id
    LOOP
        INSERT INTO public.profile_players (profile_id, player_id, organization_id)
        VALUES (v_uid, r.id, r.organization_id)
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

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_team_roster(p_team_id uuid)
RETURNS TABLE (
    player_id uuid,
    first_name text,
    last_name text,
    preferred_name text,
    jersey_number smallint,
    is_my_child boolean,
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

CREATE OR REPLACE FUNCTION public.get_coach_directory(p_organization_id uuid)
RETURNS TABLE (
    coach_id uuid,
    full_name text,
    phone text,
    email text,
    team_names text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'get_coach_directory requires a signed-in caller' USING ERRCODE = '42501';
    END IF;
    IF NOT (public.is_org_admin(p_organization_id)
            OR (public.org_flag(p_organization_id, 'coach_directory', true)
                AND EXISTS (SELECT 1 FROM public.get_my_coached_team_ids(p_organization_id)))) THEN
        RAISE EXCEPTION 'not permitted to read the coach directory' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    WITH days AS MATERIALIZED (
        -- Today once per team, not once per assignment row.
        SELECT t.id AS team_id, t.name, public.team_local_today(t.id) AS today
          FROM public.teams t
         WHERE t.organization_id = p_organization_id
    )
    SELECT c.id,
           c.full_name,
           CASE WHEN pr.share_contact IS NULL THEN c.phone
                WHEN pr.share_contact THEN pr.contact_phone END,
           CASE WHEN pr.share_contact IS NULL THEN c.email
                WHEN pr.share_contact THEN pr.contact_email END,
           array_agg(DISTINCT d.name ORDER BY d.name)
      FROM public.team_coach_assignments a
      JOIN days d ON d.team_id = a.team_id
      JOIN public.coaches c ON c.id = a.coach_id
      LEFT JOIN public.profiles pr ON pr.id = c.user_id
     WHERE a.organization_id = p_organization_id
       AND a.effective_from <= d.today
       AND (a.effective_to IS NULL OR a.effective_to >= d.today)
     GROUP BY c.id, c.full_name, c.phone, c.email, pr.share_contact, pr.contact_phone, pr.contact_email
     ORDER BY c.full_name, c.id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges. New functions are executable by PUBLIC (and Supabase's default
-- privileges add anon and authenticated), so each is revoked first.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.org_flag(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
-- Internal too: callable with any team id, it would tell a caller from another
-- organization that the team exists and roughly where its season is.
REVOKE ALL ON FUNCTION public.team_local_today(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guardian_contacts_view(uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.set_my_contact_card(text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_current_team_coach(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_team_guardian(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_coached_team_ids(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.link_my_guardian_records() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_team_roster(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_team_staff(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_coach_directory(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.set_my_contact_card(text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_current_team_coach(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_team_guardian(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_coached_team_ids(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_my_guardian_records() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_roster(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_coach_directory(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_team_roster(uuid) IS
    'Team roster per the Phase A access table (admins/staff, current coach, guardian on the team); guardian contacts pass through contact cards. 20261021010000.';
COMMENT ON FUNCTION public.get_team_staff(uuid) IS
    'Current coaches of a team with contact details (contact card wins); admins/staff, current coach, guardian on the team. 20261021010000.';
COMMENT ON FUNCTION public.get_coach_directory(uuid) IS
    'Every current coach with contact details; admins/staff, or a current coach while coach_directory is on. 20261021010000.';
COMMENT ON FUNCTION public.link_my_guardian_records() IS
    'Links the caller to each player whose imported guardian email matches their verified email, in organizations they belong to. Idempotent; audited. 20261021010000.';

COMMIT;
