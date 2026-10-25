-- Revert for 20261025010000_remove_contact_surfaces.sql
--
-- Restores, in structure, every object the migration dropped or replaced, as
-- it stood after 20261024010000: `players.guardian_contacts` and
-- `players.contact_info` (EMPTY: their defaults, `[]` and `{}`, on every
-- row); the contact card columns on `profiles` (NULL on every row: no card
-- saved) with their checks and comment; `coach_interested_programs` (EMPTY)
-- with its keys, indexes, row security, policy, org-scope trigger and its
-- function, and grants; `upsert_coach_leads` and
-- `set_import_job_coach_lead_summary`; `set_my_contact_card` and
-- `get_coach_directory`; `get_team_staff` with its phone and email and
-- `get_team_roster` with its guardian contacts; `get_organization_members`
-- open to any member; and `sanitize_player_patch`, `apply_player_patch`,
-- `admin_bulk_update_players`, `finalize_import_job` and
-- `minimise_import_people_data` with the two player columns; each with its
-- comment, grants and posture, and the comment on `coaches.status`.
--
-- The DDL is pg_dump's (16) of a harness build at 20261024010000, so each
-- function body is that build's text byte for byte; only the OWNER lines are
-- left out (the objects are created by the role that runs this). Each
-- function's grants are revoked from every client role before the dump's are
-- restated, so the default privileges a new function gets cannot widen it
-- (the org-scope trigger function keeps PUBLIC's EXECUTE, as it had).
--
-- **What it cannot restore:** the guardian contacts, player contact details,
-- saved contact cards and coach interest rows the migration dropped. The
-- columns come back at their defaults and the table empty; a league would
-- re-import its players for guardian contacts. The forward migration's
-- NOTICE counted what it dropped (production: 0 players, 0 cards, 0 coach
-- interest rows, read 2026-10-25).
--
-- Verified: the harness compares a fingerprint of every restored object
-- (signature, posture, grants, comment and body md5 of the thirteen
-- functions; columns, constraints, indexes, trigger, grants, row security and
-- policy of `coach_interested_programs`; the restored columns of `players`
-- and `profiles` and the two card checks; the comment on `coaches.status`)
-- with the one read off a build at 20261024010000.

BEGIN;

-- 1. The players and profiles columns, back where the replaced bodies read them.

ALTER TABLE public.players
    ADD COLUMN guardian_contacts jsonb DEFAULT '[]'::jsonb,
    ADD COLUMN contact_info jsonb DEFAULT '{}'::jsonb;

ALTER TABLE public.profiles
    ADD COLUMN contact_phone text,
    ADD COLUMN contact_email text,
    ADD COLUMN share_contact boolean;

ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_contact_email_check CHECK (((contact_email IS NULL) OR ((length(contact_email) <= 254) AND (contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::text)))),
    ADD CONSTRAINT profiles_contact_phone_check CHECK (((contact_phone IS NULL) OR (contact_phone ~ '^\+?[0-9() .-]{7,32}$'::text)));

COMMENT ON COLUMN public.profiles.share_contact IS 'Contact card: NULL = never saved (imported details show), true = card phone/email show, false = no contact details show. 20261021010000.';

-- 2. The coach leads: the trigger function, the table with its keys, indexes,
--    row security, policy, trigger and grants, then the two RPCs.

CREATE FUNCTION public.enforce_coach_interested_programs_org_scope() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.coaches c
        WHERE c.id = NEW.coach_id
          AND c.organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'coach_interested_programs coach organization mismatch'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.divisions d
        WHERE d.id = NEW.division_id
          AND d.organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'coach_interested_programs division organization mismatch'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.inferred_from_player_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM public.players p
           WHERE p.id = NEW.inferred_from_player_id
             AND p.organization_id = NEW.organization_id
       ) THEN
        RAISE EXCEPTION 'coach_interested_programs player organization mismatch'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

GRANT ALL ON FUNCTION public.enforce_coach_interested_programs_org_scope() TO anon;
GRANT ALL ON FUNCTION public.enforce_coach_interested_programs_org_scope() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_coach_interested_programs_org_scope() TO service_role;

CREATE TABLE public.coach_interested_programs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    coach_id uuid NOT NULL,
    division_id uuid NOT NULL,
    inferred_from_player_id uuid,
    organization_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.coach_interested_programs
    ADD CONSTRAINT coach_interested_programs_coach_id_division_id_inferred_fro_key UNIQUE NULLS NOT DISTINCT (coach_id, division_id, inferred_from_player_id);

ALTER TABLE ONLY public.coach_interested_programs
    ADD CONSTRAINT coach_interested_programs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.coach_interested_programs
    ADD CONSTRAINT coach_interested_programs_coach_id_fkey FOREIGN KEY (coach_id) REFERENCES public.coaches(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.coach_interested_programs
    ADD CONSTRAINT coach_interested_programs_division_id_fkey FOREIGN KEY (division_id) REFERENCES public.divisions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.coach_interested_programs
    ADD CONSTRAINT coach_interested_programs_inferred_from_player_id_fkey FOREIGN KEY (inferred_from_player_id) REFERENCES public.players(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.coach_interested_programs
    ADD CONSTRAINT coach_interested_programs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

CREATE INDEX idx_coach_interested_programs_coach ON public.coach_interested_programs USING btree (coach_id);

CREATE INDEX idx_coach_interested_programs_division ON public.coach_interested_programs USING btree (division_id);

CREATE INDEX idx_coach_interested_programs_org ON public.coach_interested_programs USING btree (organization_id);

ALTER TABLE public.coach_interested_programs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coach Interested Programs: members access" ON public.coach_interested_programs FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

CREATE TRIGGER coach_interested_programs_org_scope BEFORE INSERT OR UPDATE OF coach_id, division_id, inferred_from_player_id, organization_id ON public.coach_interested_programs FOR EACH ROW EXECUTE FUNCTION public.enforce_coach_interested_programs_org_scope();

GRANT ALL ON TABLE public.coach_interested_programs TO anon;
GRANT ALL ON TABLE public.coach_interested_programs TO authenticated;
GRANT ALL ON TABLE public.coach_interested_programs TO service_role;

CREATE FUNCTION public.upsert_coach_leads(p_leads jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
    AS $$
DECLARE
    v_org_id uuid;
    v_invalid_scope_count integer;
    v_result jsonb;
BEGIN
    IF p_leads IS NULL OR jsonb_typeof(p_leads) <> 'array' THEN
        RAISE EXCEPTION 'p_leads must be a jsonb array';
    END IF;

    FOR v_org_id IN
        SELECT DISTINCT (elem->>'organization_id')::uuid
        FROM jsonb_array_elements(p_leads) AS elem
        WHERE elem->>'organization_id' IS NOT NULL
          AND elem->>'organization_id' <> ''
    LOOP
        IF NOT public.is_org_member(v_org_id) THEN
            RAISE EXCEPTION 'Access denied: user is not a member of organization %', v_org_id
                USING ERRCODE = '42501';
        END IF;
    END LOOP;

    WITH input_leads AS (
        SELECT
            lower(trim(coalesce(email, ''))) AS email,
            trim(coalesce(full_name, '')) AS full_name,
            organization_id,
            division_id,
            player_id
        FROM jsonb_to_recordset(p_leads) AS x(
            email text,
            full_name text,
            organization_id uuid,
            division_id uuid,
            player_id uuid
        )
        WHERE organization_id IS NOT NULL
    ),
    valid_leads AS (
        SELECT * FROM input_leads
        WHERE email <> '' AND full_name <> ''
    ),
    invalid_scope AS (
        SELECT 1
        FROM valid_leads vl
        WHERE (
            vl.division_id IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM public.divisions d
                WHERE d.id = vl.division_id
                  AND d.organization_id = vl.organization_id
            )
        )
        OR (
            vl.player_id IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM public.players p
                WHERE p.id = vl.player_id
                  AND p.organization_id = vl.organization_id
            )
        )
    )
    SELECT count(*)
    INTO v_invalid_scope_count
    FROM invalid_scope;

    IF v_invalid_scope_count > 0 THEN
        RAISE EXCEPTION 'Coach lead references a division or player outside its organization'
            USING ERRCODE = '42501';
    END IF;

    WITH input_leads AS (
        SELECT
            lower(trim(coalesce(email, ''))) AS email,
            trim(coalesce(full_name, '')) AS full_name,
            organization_id,
            division_id,
            player_id
        FROM jsonb_to_recordset(p_leads) AS x(
            email text,
            full_name text,
            organization_id uuid,
            division_id uuid,
            player_id uuid
        )
        WHERE organization_id IS NOT NULL
    ),
    valid_leads AS (
        SELECT * FROM input_leads
        WHERE email <> '' AND full_name <> ''
    ),
    coach_candidates AS (
        SELECT DISTINCT ON (email)
            email, full_name, organization_id
        FROM valid_leads
        ORDER BY email, organization_id
    ),
    upserted_coaches AS (
        INSERT INTO public.coaches (
            organization_id, full_name, email, status,
            import_source, last_imported_at
        )
        SELECT
            organization_id, full_name, email, 'interested',
            'player_import_lead', timezone('utc', now())
        FROM coach_candidates
        ON CONFLICT (email) DO UPDATE
        SET last_imported_at = EXCLUDED.last_imported_at
        WHERE public.coaches.organization_id = EXCLUDED.organization_id
        RETURNING id, organization_id, email, (xmax = '0'::xid) AS inserted
    ),
    resolved_leads AS (
        SELECT
            vl.division_id,
            vl.player_id,
            vl.organization_id,
            COALESCE(uc.id, c.id) AS coach_id
        FROM valid_leads vl
        LEFT JOIN upserted_coaches uc
            ON uc.email = vl.email
           AND uc.organization_id = vl.organization_id
        LEFT JOIN public.coaches c
            ON lower(c.email) = vl.email
           AND c.organization_id = vl.organization_id
    ),
    inserted_links AS (
        INSERT INTO public.coach_interested_programs (
            coach_id, division_id, inferred_from_player_id, organization_id
        )
        SELECT coach_id, division_id, player_id, organization_id
        FROM resolved_leads
        WHERE coach_id IS NOT NULL
          AND division_id IS NOT NULL
        ON CONFLICT (coach_id, division_id, inferred_from_player_id) DO NOTHING
        RETURNING 1
    )
    SELECT jsonb_build_object(
        'leads_created', (SELECT count(*) FROM upserted_coaches WHERE inserted),
        'programs_linked', (SELECT count(*) FROM inserted_links),
        'skipped_existing', (SELECT count(*) FROM valid_leads)
                            - (SELECT count(*) FROM upserted_coaches WHERE inserted)
    )
    INTO v_result;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_coach_leads(p_leads jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.upsert_coach_leads(p_leads jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.upsert_coach_leads(p_leads jsonb) TO service_role;

CREATE FUNCTION public.set_import_job_coach_lead_summary(p_import_job_id uuid, p_summary jsonb, p_status text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_org_id uuid;
BEGIN
    IF p_summary IS NULL OR jsonb_typeof(p_summary) <> 'object' THEN
        RAISE EXCEPTION 'p_summary must be a jsonb object';
    END IF;

    IF p_status IS NOT NULL
       AND p_status NOT IN (
           'queued','processing','importing','completed',
           'completed_with_warnings','needs_fix','failed'
       ) THEN
        RAISE EXCEPTION 'invalid import job status: %', p_status
            USING ERRCODE = '23514';
    END IF;

    SELECT organization_id INTO v_org_id
    FROM public.import_jobs
    WHERE id = p_import_job_id;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Import job not found: %', p_import_job_id
            USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.import_jobs
    SET
        status = COALESCE(p_status, status),
        -- Guard against a JSON null / non-object warning_summary: jsonb_set on a
        -- scalar would error, so normalize to an object first.
        warning_summary = jsonb_set(
            CASE
                WHEN warning_summary IS NULL OR jsonb_typeof(warning_summary) <> 'object'
                THEN '{}'::jsonb
                ELSE warning_summary
            END,
            '{coach_leads}',
            p_summary,
            true
        )
    WHERE id = p_import_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_import_job_coach_lead_summary(p_import_job_id uuid, p_summary jsonb, p_status text) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.set_import_job_coach_lead_summary(p_import_job_id uuid, p_summary jsonb, p_status text) TO authenticated;
GRANT ALL ON FUNCTION public.set_import_job_coach_lead_summary(p_import_job_id uuid, p_summary jsonb, p_status text) TO service_role;

COMMENT ON COLUMN public.coaches.status IS 'Lifecycle state. ''interested'' = lead captured from player-registration "Head coach" intent flag; promoted to ''active'' automatically when the same email appears on a coach import.';

-- 3. The contact card and the coach directory.

CREATE FUNCTION public.set_my_contact_card(p_phone text, p_email text, p_share boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
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
$_$;

REVOKE ALL ON FUNCTION public.set_my_contact_card(p_phone text, p_email text, p_share boolean) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.set_my_contact_card(p_phone text, p_email text, p_share boolean) TO authenticated;
GRANT ALL ON FUNCTION public.set_my_contact_card(p_phone text, p_email text, p_share boolean) TO service_role;

CREATE FUNCTION public.get_coach_directory(p_organization_id uuid) RETURNS TABLE(coach_id uuid, full_name text, phone text, email text, team_names text[])
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
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

COMMENT ON FUNCTION public.get_coach_directory(p_organization_id uuid) IS 'Every current coach with contact details; admins/staff, or a current coach while coach_directory is on. 20261021010000.';

REVOKE ALL ON FUNCTION public.get_coach_directory(p_organization_id uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.get_coach_directory(p_organization_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_coach_directory(p_organization_id uuid) TO service_role;

-- 4. The staff and roster reads with their contact columns (the result types
--    change, so each is dropped and created), and the member list open to any
--    member.

DROP FUNCTION public.get_team_staff(uuid);

CREATE FUNCTION public.get_team_staff(p_team_id uuid) RETURNS TABLE(coach_id uuid, full_name text, role text, phone text, email text, status text)
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

COMMENT ON FUNCTION public.get_team_staff(p_team_id uuid) IS 'Current coaches of a team with contact details (contact card wins); admins/staff and a current coach of the team. 20261021010000; guardians out 20261024010000.';

REVOKE ALL ON FUNCTION public.get_team_staff(p_team_id uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.get_team_staff(p_team_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_team_staff(p_team_id uuid) TO service_role;

DROP FUNCTION public.get_team_roster(uuid);

CREATE FUNCTION public.get_team_roster(p_team_id uuid) RETURNS TABLE(player_id uuid, first_name text, last_name text, preferred_name text, jersey_number smallint, guardian_contacts jsonb, gender text, years_played smallint, rating smallint, willing_to_coach boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
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

COMMENT ON FUNCTION public.get_team_roster(p_team_id uuid) IS 'Team roster: admins/staff read every column, guardian contacts as imported; a current coach of the team reads names and jersey number only. 20261021010000; guardians out 20261024010000.';

REVOKE ALL ON FUNCTION public.get_team_roster(p_team_id uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.get_team_roster(p_team_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_team_roster(p_team_id uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_organization_members(p_organization_id uuid) RETURNS TABLE(profile_id uuid, role text, created_at timestamp with time zone, email text, full_name text, first_name text, last_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_member(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: membership required for organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT om.profile_id, om.role, om.created_at,
           p.email, p.full_name, p.first_name, p.last_name
    FROM public.organization_members om
    LEFT JOIN public.profiles p ON p.id = om.profile_id
    WHERE om.organization_id = p_organization_id
    ORDER BY om.created_at ASC;
END;
$$;

COMMENT ON FUNCTION public.get_organization_members(p_organization_id uuid) IS 'Org-membership-gated member list with profile display fields (bypasses own-row-only profiles RLS).';

REVOKE ALL ON FUNCTION public.get_organization_members(p_organization_id uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.get_organization_members(p_organization_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_organization_members(p_organization_id uuid) TO service_role;

-- 5. The player writers, with the two contact columns.

CREATE OR REPLACE FUNCTION public.sanitize_player_patch(p_patch jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $_$
DECLARE
    v_out jsonb := '{}'::jsonb;
    v_key text;
    v_val jsonb;
    v_text text;
    v_num numeric;
BEGIN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'patch must be a JSON object' USING ERRCODE = '22023';
    END IF;

    FOR v_key, v_val IN SELECT * FROM jsonb_each(p_patch) LOOP
        CASE v_key
            WHEN 'first_name', 'last_name', 'preferred_name', 'gender', 'grade', 'notes',
                 'buddy_request' THEN
                v_text := NULLIF(trim(v_val #>> '{}'), '');
                IF v_key IN ('first_name', 'last_name') AND v_text IS NULL THEN
                    RAISE EXCEPTION '% cannot be empty', v_key USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object(v_key, to_jsonb(v_text));
            WHEN 'status' THEN
                v_text := lower(trim(v_val #>> '{}'));
                IF v_text NOT IN ('active', 'inactive', 'pending', 'waitlist') THEN
                    RAISE EXCEPTION 'invalid status %', v_text USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('status', to_jsonb(v_text));
            WHEN 'rating' THEN
                v_num := CASE WHEN jsonb_typeof(v_val) = 'null' THEN NULL ELSE (v_val #>> '{}')::numeric END;
                IF v_num IS NOT NULL AND (v_num < 1 OR v_num > 5 OR v_num <> round(v_num)) THEN
                    RAISE EXCEPTION 'rating must be an integer 1-5' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('rating', to_jsonb(v_num));
            WHEN 'years_played' THEN
                v_num := CASE WHEN jsonb_typeof(v_val) = 'null' THEN NULL ELSE (v_val #>> '{}')::numeric END;
                IF v_num IS NOT NULL AND (v_num < 0 OR v_num > 30 OR v_num <> round(v_num)) THEN
                    RAISE EXCEPTION 'years_played must be an integer 0-30' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('years_played', to_jsonb(v_num));
            WHEN 'jersey_number' THEN
                v_num := CASE WHEN jsonb_typeof(v_val) = 'null' THEN NULL ELSE (v_val #>> '{}')::numeric END;
                IF v_num IS NOT NULL AND (v_num < 0 OR v_num > 999 OR v_num <> round(v_num)) THEN
                    RAISE EXCEPTION 'jersey_number must be an integer 0-999' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('jersey_number', to_jsonb(v_num));
            WHEN 'willing_to_coach' THEN
                IF jsonb_typeof(v_val) <> 'boolean' THEN
                    RAISE EXCEPTION '% must be boolean', v_key USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object(v_key, v_val);
            WHEN 'division_id', 'team_id' THEN
                v_text := NULLIF(trim(v_val #>> '{}'), '');
                IF v_text IS NOT NULL AND v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                    RAISE EXCEPTION '% must be a uuid', v_key USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object(v_key, to_jsonb(v_text));
            WHEN 'date_of_birth' THEN
                v_text := NULLIF(trim(v_val #>> '{}'), '');
                v_out := v_out || jsonb_build_object('date_of_birth', to_jsonb(v_text));
            WHEN 'guardian_contacts' THEN
                -- Array of {name?, email?, phone?, alternate_email?} objects
                -- (the Player record guardians editor).
                IF jsonb_typeof(v_val) <> 'array' THEN
                    RAISE EXCEPTION 'guardian_contacts must be an array' USING ERRCODE = '22023';
                END IF;
                IF EXISTS (
                    SELECT 1 FROM jsonb_array_elements(v_val) g
                    WHERE jsonb_typeof(g.value) <> 'object'
                       OR EXISTS (
                           SELECT 1 FROM jsonb_object_keys(g.value) k
                           -- 'primary'/'relationship' appear in legacy seed/import
                           -- data and must round-trip through record-page edits.
                           WHERE k NOT IN ('name', 'email', 'phone', 'alternate_email',
                                           'primary', 'relationship')
                       )
                ) THEN
                    RAISE EXCEPTION 'guardian_contacts entries allow only name/email/phone/alternate_email/primary/relationship'
                        USING ERRCODE = '22023';
                END IF;
                IF jsonb_array_length(v_val) > 6 THEN
                    RAISE EXCEPTION 'guardian_contacts limited to 6 entries' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('guardian_contacts', v_val);
            ELSE
                RAISE EXCEPTION 'field % is not editable', v_key USING ERRCODE = '22023';
        END CASE;
    END LOOP;

    IF v_out = '{}'::jsonb THEN
        RAISE EXCEPTION 'patch contains no editable fields' USING ERRCODE = '22023';
    END IF;

    RETURN v_out;
END;
$_$;

REVOKE ALL ON FUNCTION public.sanitize_player_patch(p_patch jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.sanitize_player_patch(p_patch jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.sanitize_player_patch(p_patch jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.apply_player_patch(p_player_id uuid, p_sanitized jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
    AS $$
BEGIN
    UPDATE public.players p
    SET
        first_name      = COALESCE(CASE WHEN p_sanitized ? 'first_name' THEN p_sanitized->>'first_name' END, p.first_name),
        last_name       = COALESCE(CASE WHEN p_sanitized ? 'last_name' THEN p_sanitized->>'last_name' END, p.last_name),
        preferred_name  = CASE WHEN p_sanitized ? 'preferred_name' THEN p_sanitized->>'preferred_name' ELSE p.preferred_name END,
        gender          = CASE WHEN p_sanitized ? 'gender' THEN p_sanitized->>'gender' ELSE p.gender END,
        grade           = CASE WHEN p_sanitized ? 'grade' THEN p_sanitized->>'grade' ELSE p.grade END,
        notes           = CASE WHEN p_sanitized ? 'notes' THEN p_sanitized->>'notes' ELSE p.notes END,
        buddy_request   = CASE WHEN p_sanitized ? 'buddy_request' THEN p_sanitized->>'buddy_request' ELSE p.buddy_request END,
        status          = CASE WHEN p_sanitized ? 'status' THEN p_sanitized->>'status' ELSE p.status END,
        rating          = CASE WHEN p_sanitized ? 'rating' THEN (p_sanitized->>'rating')::smallint ELSE p.rating END,
        years_played    = CASE WHEN p_sanitized ? 'years_played' THEN (p_sanitized->>'years_played')::smallint ELSE p.years_played END,
        jersey_number   = CASE WHEN p_sanitized ? 'jersey_number' THEN (p_sanitized->>'jersey_number')::smallint ELSE p.jersey_number END,
        willing_to_coach = COALESCE(CASE WHEN p_sanitized ? 'willing_to_coach' THEN (p_sanitized->>'willing_to_coach')::boolean END, p.willing_to_coach),
        division_id     = CASE WHEN p_sanitized ? 'division_id' THEN (p_sanitized->>'division_id')::uuid ELSE p.division_id END,
        team_id         = CASE WHEN p_sanitized ? 'team_id' THEN (p_sanitized->>'team_id')::uuid ELSE p.team_id END,
        date_of_birth   = CASE WHEN p_sanitized ? 'date_of_birth' THEN (p_sanitized->>'date_of_birth')::date ELSE p.date_of_birth END,
        guardian_contacts = CASE WHEN p_sanitized ? 'guardian_contacts' THEN p_sanitized->'guardian_contacts' ELSE p.guardian_contacts END,
        updated_at      = now()
    WHERE p.id = p_player_id;

    -- team_players is the relational source of truth for rosters (portals,
    -- summaries, scheduler filters read it). Keep it in sync whenever the
    -- denormalized players.team_id is patched, so Team Builder moves are
    -- visible everywhere.
    IF p_sanitized ? 'team_id' THEN
        DELETE FROM public.team_players tp WHERE tp.player_id = p_player_id;
        IF p_sanitized->>'team_id' IS NOT NULL THEN
            INSERT INTO public.team_players (team_id, player_id, organization_id, role, source)
            SELECT (p_sanitized->>'team_id')::uuid, p.id, p.organization_id, 'player', 'manual'
            FROM public.players p
            WHERE p.id = p_player_id
            ON CONFLICT (team_id, player_id) DO NOTHING;
        END IF;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_player_patch(p_player_id uuid, p_sanitized jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.apply_player_patch(p_player_id uuid, p_sanitized jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.apply_player_patch(p_player_id uuid, p_sanitized jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_bulk_update_players(p_player_ids uuid[], p_patch jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_org_id uuid;
    v_org_count integer;
    v_sanitized jsonb;
    v_id uuid;
    v_count integer := 0;
BEGIN
    IF p_player_ids IS NULL OR array_length(p_player_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'p_player_ids must be a non-empty array' USING ERRCODE = '22023';
    END IF;
    IF array_length(p_player_ids, 1) > 2000 THEN
        RAISE EXCEPTION 'bulk update limited to 2000 players' USING ERRCODE = '22023';
    END IF;

    SELECT count(DISTINCT organization_id), min(organization_id)
    INTO v_org_count, v_org_id
    FROM public.players
    WHERE id = ANY(p_player_ids);

    IF v_org_count <> 1 THEN
        RAISE EXCEPTION 'players must belong to exactly one organization' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    v_sanitized := public.sanitize_player_patch(p_patch);
    IF v_sanitized ? 'division_id' OR v_sanitized ? 'team_id' OR v_sanitized ? 'first_name'
        OR v_sanitized ? 'last_name' OR v_sanitized ? 'date_of_birth'
        OR v_sanitized ? 'guardian_contacts' THEN
        RAISE EXCEPTION 'field not allowed in bulk updates' USING ERRCODE = '22023';
    END IF;

    FOR v_id IN SELECT unnest(p_player_ids) LOOP
        PERFORM public.apply_player_patch(v_id, v_sanitized);
        v_count := v_count + 1;
    END LOOP;

    PERFORM public.record_audit_event(
        v_org_id,
        'player.bulk_updated',
        'players',
        NULL,
        jsonb_build_object('patch', v_sanitized, 'player_count', v_count)
    );

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.admin_bulk_update_players(p_player_ids uuid[], p_patch jsonb) IS 'Audited bulk patch (whitelisted scalar fields, single org) for the Players grid bulk bar.';

REVOKE ALL ON FUNCTION public.admin_bulk_update_players(p_player_ids uuid[], p_patch jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.admin_bulk_update_players(p_player_ids uuid[], p_patch jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.admin_bulk_update_players(p_player_ids uuid[], p_patch jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_import_job(p_import_job_id uuid, p_validation_errors jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
    AS $_$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_error_count integer := 0;
    v_total_promoted_count integer := 0;
    v_status text;
    v_result jsonb;
    v_gender_model text;
    v_season_settings_id uuid;
    v_waitlist_enabled boolean := true;
    v_created_divisions integer := 0;
    v_declared jsonb;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_validation_errors) <> 'array' THEN
        RAISE EXCEPTION 'p_validation_errors must be a jsonb array' USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_job
    FROM public.import_jobs
    WHERE id = p_import_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_job.job_type <> 'registration' THEN
        RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type
            USING ERRCODE = '22023';
    END IF;

    IF v_job.status = 'failed' THEN
        RAISE EXCEPTION 'Failed import job % cannot be finalized', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    -- The organization's declared player fields, read once for every row.
    v_declared := public.import_declared_fields(v_job.organization_id, 'player');

    v_error_count := jsonb_array_length(v_validation_errors);
    v_status := CASE WHEN v_error_count > 0 THEN 'completed_with_warnings' ELSE 'completed' END;

    -- Org division format: 'split' (default) -> gendered U8B/U8G; 'coed' -> U8.
    SELECT COALESCE(o.feature_flags->>'gender_model', 'split'),
           COALESCE((o.feature_flags->>'waitlist')::boolean, true)
    INTO v_gender_model, v_waitlist_enabled
    FROM public.organizations o
    WHERE o.id = v_job.organization_id;
    IF v_gender_model NOT IN ('split', 'coed') THEN
        v_gender_model := 'split';
    END IF;

    -- Season that auto-created divisions attach to (divisions are per-season).
    SELECT s.id
    INTO v_season_settings_id
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
    ORDER BY (s.status = 'active') DESC, s.season_start DESC NULLS LAST, s.created_at DESC
    LIMIT 1;

    -- Auto-create derived divisions that don't exist yet for that season.
    IF v_season_settings_id IS NOT NULL THEN
        WITH staged AS (
            SELECT
                public.import_payload_text(
                    sp.normalized_payload, 'age group', 'age_group', 'age'
                ) AS age_text,
                lower(left(COALESCE(
                    public.import_payload_text(sp.normalized_payload, 'gender'), ''
                ), 1)) AS g
            FROM public.staging_players sp
            WHERE sp.import_job_id = p_import_job_id
              AND sp.organization_id = v_job.organization_id
              AND sp.promoted_at IS NULL
              AND sp.normalized_payload IS NOT NULL
              AND COALESCE(jsonb_array_length(sp.validation_errors), 0) = 0
        ),
        derived AS (
            SELECT DISTINCT
                'U' || (age_text::int + 1)
                    || CASE
                        WHEN v_gender_model = 'coed' THEN ''
                        WHEN g IN ('m', 'b') THEN 'B'
                        WHEN g IN ('f', 'g') THEN 'G'
                        ELSE ''
                    END AS name,
                CASE
                    WHEN v_gender_model = 'coed' THEN 'coed'
                    WHEN g IN ('m', 'b') THEN 'boys'
                    WHEN g IN ('f', 'g') THEN 'girls'
                    ELSE 'coed'
                END AS gender_policy
            FROM staged
            WHERE age_text ~ '^[0-9]+$'
        ),
        created AS (
            INSERT INTO public.divisions (organization_id, season_settings_id, name, gender_policy)
            SELECT v_job.organization_id, v_season_settings_id, d.name, d.gender_policy::gender_policy_enum
            FROM derived d
            WHERE NOT EXISTS (
                SELECT 1 FROM public.divisions x
                WHERE x.organization_id = v_job.organization_id
                  AND x.season_settings_id = v_season_settings_id
                  AND lower(x.name) = lower(d.name)
            )
            ON CONFLICT (season_settings_id, name) DO NOTHING
            RETURNING id
        )
        SELECT count(*) INTO v_created_divisions FROM created;
    END IF;

    WITH pending AS MATERIALIZED (
        SELECT
            sp.id AS staging_id,
            sp.source_row_number,
            sp.organization_id,
            sp.normalized_payload,
            public.import_payload_text(
                sp.normalized_payload,
                'external_registration_id', 'gotsport_id', 'registration_id', 'player_id'
            ) AS external_registration_id,
            public.import_payload_text(sp.normalized_payload, 'division_id') AS division_id_text,
            public.import_payload_text(
                sp.normalized_payload,
                'division_name', 'division', 'group', 'program'
            ) AS explicit_division_name,
            -- Gendered division derived from age group + gender, honoring the
            -- org gender_model. A player of age N plays in division U(N+1).
            CASE
                WHEN public.import_payload_text(sp.normalized_payload, 'age group', 'age_group', 'age') ~ '^[0-9]+$'
                THEN 'U' || ((public.import_payload_text(sp.normalized_payload, 'age group', 'age_group', 'age'))::int + 1)
                    || CASE
                        WHEN v_gender_model = 'coed' THEN ''
                        WHEN lower(left(COALESCE(public.import_payload_text(sp.normalized_payload, 'gender'), ''), 1)) IN ('m', 'b') THEN 'B'
                        WHEN lower(left(COALESCE(public.import_payload_text(sp.normalized_payload, 'gender'), ''), 1)) IN ('f', 'g') THEN 'G'
                        ELSE ''
                    END
            END AS derived_division_name,
            public.import_payload_text(sp.normalized_payload, 'first_name') AS first_name,
            public.import_payload_text(sp.normalized_payload, 'last_name') AS last_name,
            public.import_payload_text(sp.normalized_payload, 'preferred_name', 'nickname') AS preferred_name,
            public.import_text_to_date(
                public.import_payload_text(sp.normalized_payload, 'date_of_birth', 'dob')
            ) AS date_of_birth,
            public.import_payload_text(sp.normalized_payload, 'grade') AS grade,
            public.import_payload_text(sp.normalized_payload, 'gender') AS gender,
            public.import_payload_text(sp.normalized_payload, 'birth_year') AS birth_year_text,
            lower(public.import_payload_text(sp.normalized_payload, 'skill_tier', 'skill_level')) AS skill_tier_text,
            public.import_payload_text(
                sp.normalized_payload,
                'years_played', 'years played',
                'how many years has your player played in an organized soccer program?'
            ) AS years_played_text,
            lower(COALESCE(public.import_payload_text(
                sp.normalized_payload, 'waitlist', 'waitlisted'
            ), '')) AS waitlist_text,
            public.import_payload_text(
                sp.normalized_payload,
                'play_up', 'play up',
                'are you coaching so this player can play up a division?'
            ) AS play_up_text,
            public.import_payload_text(sp.normalized_payload, 'buddy_request') AS buddy_request,
            -- Nullable: NULL means the coaching-interest column is genuinely
            -- absent from this row's payload (re-import should preserve the
            -- existing player's willing_to_coach), distinct from a present-
            -- but-negative answer, which lower()s to a non-matching string.
            lower(public.import_payload_text(
                sp.normalized_payload,
                'willing_to_coach', 'coach_volunteer',
                'can you coach for this player''s team?'
            )) AS coaching_answer,
            public.import_payload_text(sp.normalized_payload, 'team name') AS team_name,
            public.import_payload_text(sp.normalized_payload, 'team age') AS team_age,
            public.import_payload_text(sp.normalized_payload, 'team gender') AS team_gender,
            -- The allowlist (R0): only the fields the organization declared
            -- for players, keyed by their declared names. Every other column
            -- of the export is dropped here, whatever reached staging.
            public.import_declared_attributes(v_declared, sp.normalized_payload)
                AS custom_attributes
        FROM public.staging_players sp
        WHERE sp.import_job_id = p_import_job_id
          AND sp.organization_id = v_job.organization_id
          AND sp.promoted_at IS NULL
          AND sp.normalized_payload IS NOT NULL
          AND COALESCE(jsonb_array_length(sp.validation_errors), 0) = 0
    ),
    valid_candidates AS MATERIALIZED (
        SELECT
            p.*,
            COALESCE(p.explicit_division_name, p.derived_division_name) AS division_name,
            d.id AS division_id,
            CASE
                WHEN p.birth_year_text ~ '^\d{4}$' THEN p.birth_year_text::integer
                WHEN p.date_of_birth IS NOT NULL THEN EXTRACT(YEAR FROM p.date_of_birth)::integer
                ELSE NULL
            END AS birth_year,
            CASE
                WHEN p.skill_tier_text IN ('novice', 'developing', 'advanced') THEN p.skill_tier_text
                ELSE NULL
            END AS skill_tier,
            CASE
                WHEN p.years_played_text ~ '^[0-9]{1,2}$'
                     AND p.years_played_text::int BETWEEN 0 AND 30
                THEN p.years_played_text::smallint
            END AS years_played,
            CASE
                WHEN v_waitlist_enabled
                     AND p.waitlist_text IN ('true', 't', 'yes', 'y', '1') THEN 'waitlist'
                ELSE 'active'
            END AS import_status,
            -- NULL when the coaching-interest column is absent (preserve
            -- existing value on re-import); a boolean otherwise.
            CASE
                WHEN p.coaching_answer IS NULL THEN NULL
                ELSE p.coaching_answer IN ('true', 't', 'yes', 'y', '1', 'maybe', 'coach',
                    'head coach', 'assistant coach', 'volunteer', 'willing')
            END AS willing_to_coach,
            (p.custom_attributes
                || jsonb_strip_nulls(jsonb_build_object(
                    'team_name', p.team_name,
                    'team_age', p.team_age,
                    'team_gender', p.team_gender
                ))
                || CASE
                    WHEN p.play_up_text IS NOT NULL
                    THEN jsonb_build_object('play_up', p.play_up_text)
                    ELSE '{}'::jsonb
                END
                || CASE
                    WHEN p.coaching_answer IS NOT NULL AND p.coaching_answer <> ''
                    THEN jsonb_build_object('coaching_answer', p.coaching_answer)
                    ELSE '{}'::jsonb
                END
            ) AS final_custom_attributes
        FROM pending p
        LEFT JOIN LATERAL (
            SELECT divisions.id
            FROM public.divisions
            WHERE divisions.organization_id = p.organization_id
              AND (
                  divisions.id = CASE
                      WHEN p.division_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN p.division_id_text::uuid
                      ELSE NULL
                  END
                  -- Name matches are season-scoped (divisions are unique per
                  -- season); without this, a new season's import attaches
                  -- players to a prior season's same-named division.
                  OR (
                      (v_season_settings_id IS NULL
                       OR divisions.season_settings_id = v_season_settings_id)
                      AND (
                          lower(divisions.name) = lower(COALESCE(p.explicit_division_name, ''))
                          OR lower(divisions.name) = lower(COALESCE(p.derived_division_name, ''))
                      )
                  )
              )
            ORDER BY
                -- Prefer explicit id, then explicit name, then derived name.
                (divisions.id::text = p.division_id_text) DESC,
                (lower(divisions.name) = lower(COALESCE(p.explicit_division_name, ''))) DESC,
                divisions.created_at DESC, divisions.id
            LIMIT 1
        ) d ON true
        WHERE p.first_name IS NOT NULL
          AND p.last_name IS NOT NULL
          AND p.date_of_birth IS NOT NULL
    ),
    deduped_external AS MATERIALIZED (
        SELECT DISTINCT ON (organization_id, external_registration_id) *
        FROM valid_candidates
        WHERE external_registration_id IS NOT NULL
        ORDER BY organization_id, external_registration_id, source_row_number NULLS LAST, staging_id
    ),
    existing_matches AS MATERIALIZED (
        SELECT de.staging_id, matched_players.id AS player_id
        FROM deduped_external de
        JOIN LATERAL (
            SELECT players.id
            FROM public.players
            WHERE players.organization_id = de.organization_id
              AND players.external_registration_id = de.external_registration_id
            ORDER BY players.created_at, players.id
            LIMIT 1
        ) matched_players ON true
    ),
    updated_existing AS (
        UPDATE public.players p
        SET
            division_id = COALESCE(de.division_id, p.division_id),
            first_name = de.first_name,
            last_name = de.last_name,
            preferred_name = COALESCE(de.preferred_name, p.preferred_name),
            date_of_birth = de.date_of_birth,
            grade = COALESCE(de.grade, p.grade),
            gender = COALESCE(de.gender, p.gender),
            birth_year = COALESCE(de.birth_year, p.birth_year),
            skill_tier = COALESCE(de.skill_tier, p.skill_tier),
            years_played = COALESCE(de.years_played, p.years_played),
            status = CASE
                WHEN de.import_status = 'waitlist' THEN 'waitlist'
                WHEN p.status = 'waitlist' AND de.import_status = 'active' THEN 'active'
                ELSE p.status
            END,
            willing_to_coach = COALESCE(de.willing_to_coach, p.willing_to_coach),
            coach_volunteer = COALESCE(de.willing_to_coach, p.coach_volunteer),
            buddy_request = COALESCE(de.buddy_request, p.buddy_request),
            -- An existing player's undeclared keys go too; the import's own
            -- keys (play-up, coaching answer, team placement) stay.
            custom_attributes = public.import_kept_player_attributes(v_declared, p.custom_attributes)
                || de.final_custom_attributes,
            last_imported_at = v_now,
            import_source = 'gotsport',
            registration_history = COALESCE(p.registration_history, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object(
                    'import_job_id', p_import_job_id,
                    'imported_at', v_now,
                    'source', 'gotsport',
                    'operation', 'updated'
                ))
        FROM deduped_external de
        JOIN existing_matches em ON em.staging_id = de.staging_id
        WHERE p.id = em.player_id
        RETURNING p.id
    ),
    insert_source AS MATERIALIZED (
        SELECT de.*
        FROM deduped_external de
        LEFT JOIN existing_matches em ON em.staging_id = de.staging_id
        WHERE em.player_id IS NULL

        UNION ALL

        SELECT vc.*
        FROM valid_candidates vc
        WHERE vc.external_registration_id IS NULL
    ),
    inserted_new AS (
        INSERT INTO public.players (
            organization_id,
            division_id,
            first_name,
            last_name,
            preferred_name,
            external_registration_id,
            date_of_birth,
            grade,
            gender,
            birth_year,
            skill_tier,
            years_played,
            status,
            coach_volunteer,
            willing_to_coach,
            buddy_request,
            guardian_contacts,
            registration_history,
            contact_info,
            last_imported_at,
            import_source,
            custom_attributes
        )
        SELECT
            organization_id,
            division_id,
            first_name,
            last_name,
            preferred_name,
            external_registration_id,
            date_of_birth,
            grade,
            gender,
            birth_year,
            skill_tier,
            years_played,
            import_status,
            COALESCE(willing_to_coach, false),
            COALESCE(willing_to_coach, false),
            buddy_request,
            '[]'::jsonb,
            jsonb_build_array(jsonb_build_object(
                'import_job_id', p_import_job_id,
                'imported_at', v_now,
                'source', 'gotsport',
                'operation', 'inserted'
            )),
            '{}'::jsonb,
            v_now,
            'gotsport',
            final_custom_attributes
        FROM insert_source
        RETURNING id
    ),
    promoted AS (
        UPDATE public.staging_players sp
        SET
            promoted_at = v_now,
            promoted_by = auth.uid()
        WHERE sp.id IN (SELECT staging_id FROM valid_candidates)
        RETURNING sp.id
    )
    SELECT jsonb_build_object(
        'staged_rows', (SELECT count(*) FROM pending),
        'valid_staged_rows', (SELECT count(*) FROM valid_candidates),
        'promoted_rows', (SELECT count(*) FROM promoted),
        'updated_players', (SELECT count(*) FROM updated_existing),
        'inserted_players', (SELECT count(*) FROM inserted_new),
        'duplicate_external_rows',
            (SELECT count(*) FROM valid_candidates WHERE external_registration_id IS NOT NULL)
            - (SELECT count(*) FROM deduped_external),
        'without_external_id',
            (SELECT count(*) FROM valid_candidates WHERE external_registration_id IS NULL),
        'unmatched_division_rows',
            (SELECT count(*) FROM valid_candidates WHERE division_name IS NOT NULL AND division_id IS NULL),
        'waitlisted_rows',
            (SELECT count(*) FROM valid_candidates WHERE import_status = 'waitlist'),
        'created_divisions', v_created_divisions,
        'validation_error_rows', v_error_count,
        'status', v_status
    )
    INTO v_result;

    SELECT count(*)
    INTO v_total_promoted_count
    FROM public.staging_players
    WHERE import_job_id = p_import_job_id
      AND promoted_at IS NOT NULL;

    v_result := v_result || jsonb_build_object('total_promoted_rows', v_total_promoted_count);

    UPDATE public.import_jobs
    SET
        status = v_status,
        processed_rows = v_total_promoted_count,
        progress_percent = 100,
        completed_at = v_now,
        error_summary = jsonb_build_object('rowErrors', v_validation_errors),
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{finalize}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.completed',
        'import_job',
        p_import_job_id,
        v_result
    );

    RETURN v_result;
END;
$_$;

REVOKE ALL ON FUNCTION public.finalize_import_job(p_import_job_id uuid, p_validation_errors jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON FUNCTION public.finalize_import_job(p_import_job_id uuid, p_validation_errors jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.finalize_import_job(p_import_job_id uuid, p_validation_errors jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.minimise_import_people_data() RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
    -- Inside a player event's patch, fields, old or new: names, birth date,
    -- contact, guardian and free-text note values (and, as everywhere, any
    -- key naming an email).
    v_player_keys text[] := ARRAY[
        'first_name', 'last_name', 'preferred_name', 'nickname', 'full_name', 'name',
        'date_of_birth', 'dob', 'birth_year', 'notes',
        'contact_info', 'guardian_contacts', 'emergency_contacts', 'medical_info',
        'phone', 'address'
    ];
    -- At the top level of any event's metadata: every key whose name contains
    -- `email` (not a list: the writers found by grep, 2026-10-22, are
    -- coach.linked's `matched_email` and `coach_email` (20261020040000),
    -- guardian.linked's `matched_email` (20261021010000) and
    -- settings.timezone_updated's `admin_email` (20260917000000), and a
    -- future writer is caught by the name), unless its value is a boolean
    -- such as `has_email`; and `phone`.
    v_email_key text := 'email';
    v_finished text[] := ARRAY['completed', 'completed_with_warnings', 'failed'];
    v_coaches integer := 0;
    v_players integer := 0;
    v_records integer := 0;
    v_staging_players integer := 0;
    v_staging_rows integer := 0;
    v_staged_kept integer := 0;
    v_n integer := 0;
    v_audit integer := 0;
    v_jobs integer := 0;
BEGIN
    -- Each organization's declared fields, read once.
    CREATE TEMP TABLE IF NOT EXISTS pg_temp.minimise_declared (
        organization_id uuid PRIMARY KEY,
        coach jsonb NOT NULL,
        player jsonb NOT NULL
    ) ON COMMIT DROP;
    TRUNCATE pg_temp.minimise_declared;
    INSERT INTO pg_temp.minimise_declared (organization_id, coach, player)
    SELECT o.id,
           public.import_declared_fields(o.id, 'coach'),
           public.import_declared_fields(o.id, 'player')
    FROM public.organizations o;

    UPDATE public.coaches c
    SET
        custom_attributes = public.import_declared_attributes(
            d.coach, COALESCE(c.custom_attributes, '{}'::jsonb)),
        phone = NULL,
        contact_info = COALESCE(c.contact_info, '{}'::jsonb) - 'phone'
    FROM pg_temp.minimise_declared d
    WHERE d.organization_id = c.organization_id
      AND (c.phone IS NOT NULL
           OR COALESCE(c.contact_info, '{}'::jsonb) ? 'phone'
           OR c.custom_attributes IS DISTINCT FROM public.import_declared_attributes(
                  d.coach, COALESCE(c.custom_attributes, '{}'::jsonb)));
    GET DIAGNOSTICS v_coaches = ROW_COUNT;

    UPDATE public.players p
    SET
        custom_attributes = public.import_kept_player_attributes(d.player, p.custom_attributes),
        contact_info = '{}'::jsonb,
        guardian_contacts = '[]'::jsonb
    FROM pg_temp.minimise_declared d
    WHERE d.organization_id = p.organization_id
      AND (p.contact_info IS DISTINCT FROM '{}'::jsonb
           OR p.guardian_contacts IS DISTINCT FROM '[]'::jsonb
           OR p.custom_attributes IS DISTINCT FROM
              public.import_kept_player_attributes(d.player, p.custom_attributes));
    GET DIAGNOSTICS v_players = ROW_COUNT;

    -- A coach snapshot is `to_jsonb(coaches row)`; rollback restores from it.
    -- Each of a record's three payloads is scrubbed alone, and a NULL one
    -- stays NULL.
    WITH parts AS (
        SELECT
            r.id,
            k.payload_key,
            CASE
                WHEN jsonb_typeof(k.payload) = 'object' AND k.payload ? 'full_name' THEN
                    k.payload
                    || CASE WHEN k.payload ? 'phone'
                            THEN jsonb_build_object('phone', NULL) ELSE '{}'::jsonb END
                    || CASE WHEN jsonb_typeof(k.payload -> 'contact_info') = 'object'
                            THEN jsonb_build_object(
                                'contact_info', (k.payload -> 'contact_info') - 'phone')
                            ELSE '{}'::jsonb END
                    || jsonb_build_object(
                        'custom_attributes',
                        public.import_declared_attributes(
                            d.coach, COALESCE(k.payload -> 'custom_attributes', '{}'::jsonb)))
                ELSE k.payload
            END AS payload
        FROM public.import_application_records r
        JOIN pg_temp.minimise_declared d ON d.organization_id = r.organization_id
        CROSS JOIN LATERAL (VALUES
            ('previous_payload', r.previous_payload),
            ('applied_payload', r.applied_payload),
            ('rollback_payload', r.rollback_payload)
        ) AS k(payload_key, payload)
        WHERE r.target_table = 'coaches'
    ),
    scrubbed AS (
        SELECT
            id,
            (array_agg(payload) FILTER (WHERE payload_key = 'previous_payload'))[1] AS previous_payload,
            (array_agg(payload) FILTER (WHERE payload_key = 'applied_payload'))[1] AS applied_payload,
            (array_agg(payload) FILTER (WHERE payload_key = 'rollback_payload'))[1] AS rollback_payload
        FROM parts
        GROUP BY id
    )
    UPDATE public.import_application_records r
    SET
        previous_payload = s.previous_payload,
        applied_payload = s.applied_payload,
        rollback_payload = s.rollback_payload
    FROM scrubbed s
    WHERE r.id = s.id
      AND (r.previous_payload IS DISTINCT FROM s.previous_payload
           OR r.applied_payload IS DISTINCT FROM s.applied_payload
           OR r.rollback_payload IS DISTINCT FROM s.rollback_payload);
    GET DIAGNOSTICS v_records = ROW_COUNT;

    -- Staged people rows of a job that is over. Field and field-availability
    -- rows are not people and stay: a refused field row is kept on its job
    -- for replay.
    DELETE FROM public.staging_players sp
    USING public.import_jobs j
    WHERE j.id = sp.import_job_id
      AND j.status = ANY (v_finished);
    GET DIAGNOSTICS v_staging_players = ROW_COUNT;

    DELETE FROM public.staging_import_rows sr
    USING public.import_jobs j
    WHERE j.id = sr.import_job_id
      AND sr.import_type = 'coaches'
      AND j.status = ANY (v_finished);
    GET DIAGNOSTICS v_staging_rows = ROW_COUNT;

    -- Staged people rows of a job not yet over stay, reduced to the allowlist.
    UPDATE public.staging_players sp
    SET
        raw_payload = public.import_allowed_payload('players', d.player, sp.raw_payload),
        normalized_payload = CASE WHEN sp.normalized_payload IS NULL THEN NULL
            ELSE public.import_allowed_payload('players', d.player, sp.normalized_payload) END
    FROM pg_temp.minimise_declared d
    WHERE d.organization_id = sp.organization_id
      AND (sp.raw_payload IS DISTINCT FROM
               public.import_allowed_payload('players', d.player, sp.raw_payload)
           OR (sp.normalized_payload IS NOT NULL
               AND sp.normalized_payload IS DISTINCT FROM
                   public.import_allowed_payload('players', d.player, sp.normalized_payload)));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_staged_kept := v_n;

    UPDATE public.staging_import_rows sr
    SET
        raw_payload = public.import_allowed_payload('coaches', d.coach, sr.raw_payload),
        normalized_payload = CASE WHEN sr.normalized_payload IS NULL THEN NULL
            ELSE public.import_allowed_payload('coaches', d.coach, sr.normalized_payload) END
    FROM pg_temp.minimise_declared d
    WHERE d.organization_id = sr.organization_id
      AND sr.import_type = 'coaches'
      AND (sr.raw_payload IS DISTINCT FROM
               public.import_allowed_payload('coaches', d.coach, sr.raw_payload)
           OR (sr.normalized_payload IS NOT NULL
               AND sr.normalized_payload IS DISTINCT FROM
                   public.import_allowed_payload('coaches', d.coach, sr.normalized_payload)));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_staged_kept := v_staged_kept + v_n;

    WITH scrubbed AS (
        SELECT
            a.id,
            (
                SELECT COALESCE(jsonb_object_agg(
                    e.key,
                    CASE
                        WHEN ((strpos(lower(e.key), v_email_key) > 0
                               AND jsonb_typeof(e.value) NOT IN ('null', 'boolean'))
                              OR (e.key = 'phone' AND jsonb_typeof(e.value) <> 'null'))
                            THEN to_jsonb('[redacted]'::text)
                        WHEN (a.resource_type = 'players' OR a.action LIKE 'player.%')
                             AND e.key IN ('patch', 'fields', 'old', 'new')
                             AND jsonb_typeof(e.value) = 'object'
                            THEN (
                                SELECT COALESCE(jsonb_object_agg(
                                    n.key,
                                    CASE WHEN (n.key = ANY (v_player_keys)
                                               AND jsonb_typeof(n.value) <> 'null')
                                              OR (strpos(lower(n.key), v_email_key) > 0
                                               AND jsonb_typeof(n.value) NOT IN ('null', 'boolean'))
                                         THEN to_jsonb('[redacted]'::text)
                                         ELSE n.value END
                                ), '{}'::jsonb)
                                FROM jsonb_each(e.value) n
                            )
                        ELSE e.value
                    END
                ), '{}'::jsonb)
                FROM jsonb_each(a.metadata) e
            ) AS metadata
        FROM public.audit_log a
        WHERE jsonb_typeof(a.metadata) = 'object'
    )
    UPDATE public.audit_log a
    SET metadata = s.metadata
    FROM scrubbed s
    WHERE a.id = s.id
      AND a.metadata IS DISTINCT FROM s.metadata;
    GET DIAGNOSTICS v_audit = ROW_COUNT;

    -- A row error that quoted the value it refused ("Invalid date format:
    -- <value>", "Invalid email format: <value>") keeps its row and field and
    -- loses the value.
    WITH scrubbed AS (
        SELECT
            j.id,
            jsonb_set(j.error_summary, '{rowErrors}', (
                SELECT jsonb_agg(
                    CASE
                        WHEN jsonb_typeof(e.value) = 'object'
                             AND (e.value ->> 'message') ~ '^Invalid (date|email) format: '
                        THEN e.value || jsonb_build_object('message', regexp_replace(
                            e.value ->> 'message', '^Invalid (date|email) format: .*$',
                            'Invalid \1 format'))
                        ELSE e.value
                    END
                    ORDER BY e.ordinality)
                FROM jsonb_array_elements(j.error_summary -> 'rowErrors') WITH ORDINALITY e
            )) AS error_summary
        FROM public.import_jobs j
        WHERE jsonb_typeof(j.error_summary -> 'rowErrors') = 'array'
          AND jsonb_array_length(j.error_summary -> 'rowErrors') > 0
    )
    UPDATE public.import_jobs j
    SET error_summary = s.error_summary
    FROM scrubbed s
    WHERE j.id = s.id
      AND j.error_summary IS DISTINCT FROM s.error_summary;
    GET DIAGNOSTICS v_jobs = ROW_COUNT;

    DROP TABLE pg_temp.minimise_declared;

    RETURN jsonb_build_object(
        'coaches', v_coaches,
        'players', v_players,
        'import_application_records', v_records,
        'staging_players', v_staging_players,
        'staging_import_rows', v_staging_rows,
        'staged_rows_reduced', v_staged_kept,
        'audit_log', v_audit,
        'import_jobs', v_jobs
    );
END;
$_$;

REVOKE ALL ON FUNCTION public.minimise_import_people_data() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
