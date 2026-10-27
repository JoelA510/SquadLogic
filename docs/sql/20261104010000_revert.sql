-- Revert for 20261104010000_admin_only.sql
--
-- Restores every object the migration dropped or replaced, as it stood after
-- 20261103020000: the fourteen coach-only functions (`is_current_team_coach`,
-- `coached_team_ids_of`, `get_my_coached_team_ids`, `admin_get_coached_team_ids`,
-- `coach_field_ids_of`, `coach_covers_permit_scope`, `coach_reads_facility_permit`,
-- `coach_reads_facility_permit_file`, `caller_coaches_practice_slot`,
-- `request_coach_practice_preference`, `division_teams_of`, `get_my_division_teams`,
-- `admin_get_division_teams`, `link_my_coach_record`); the replaced bodies of
-- `facility_permit_json` (with its `p_coach_only` parameter), the four permit writers,
-- `get_facility_permits`, `get_team_roster`, `get_team_staff`, `rotate_calendar_token`,
-- `create_org_invite`, `admin_change_member_role`, `import_allowed_keys`,
-- `finalize_coach_import_job`, `rollback_coach_import_job` and
-- `reconcile_prod_rls_drift`; the eight read policies (their old names and coach arms); both
-- role CHECKs with `coach`; and the global unique on `coaches.email`; each function with its
-- comment, grants and posture.
--
-- **Revert 20261104020000 first.** The restored coach arms read `coaches.user_id`, which that
-- migration dropped; the SQL-language helpers are checked against it when they are created.
--
-- **What it cannot restore, and what it keeps.** No `coach_team_requests` row is deleted: the
-- links a coach import wrote stay as data (the restored finalizer neither reads nor replaces
-- them), and so does every `coaches` row. The `coaches_email_normalised` CHECK and the
-- per-organization unique go; the global unique is re-added and the revert REFUSES (55000) while
-- two organizations hold the same coach email, since one coach record cannot serve both. The
-- admin-only roles stay admin-only: no member is changed.
--
-- **Revert the frontend with it.** The app deployed with 20261104010000 no longer calls any of
-- the coach functions; reverting the migration alone changes nothing the app uses.
--
-- The DDL is pg_get_functiondef's of a harness build at 20261103020000, so each function body
-- is that build's text byte for byte. Each function's grants are revoked from every client role
-- before the build's are restated, so the default privileges cannot widen them.
--
-- Verified: the harness compares a fingerprint of every restored object (signature, posture,
-- grants, comment and body md5 of the 28 functions, the eight policies' expressions, both role
-- CHECKs and the email keys) with the one read off a build at 20261103020000.

BEGIN;

DO $$
DECLARE
    v_dup bigint;
    v_links bigint;
BEGIN
    SELECT count(*) INTO v_dup FROM (
        SELECT email FROM public.coaches GROUP BY email HAVING count(DISTINCT organization_id) > 1
    ) d;
    IF v_dup > 0 THEN
        RAISE EXCEPTION 'refusing to restore the global unique on coaches.email: % address(es) belong to coaches in more than one organization', v_dup
            USING ERRCODE = '55000';
    END IF;
    SELECT count(*) INTO v_links FROM public.coach_team_requests;
    RAISE NOTICE 'this revert restores the coach arms and the global coach email key; % coach_team_requests row(s) stay as data, and nothing reads them but team generation', v_links;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. The coach-only functions, as they stood at 20261103020000.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_current_team_coach(p_team_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.is_current_team_coach(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_current_team_coach(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.coached_team_ids_of(p_organization_id uuid, p_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    -- Today is worked out once per team, not once per assignment row.
    WITH mine AS MATERIALIZED (
        SELECT a.team_id, a.effective_from, a.effective_to
          FROM public.team_coach_assignments a
          JOIN public.coaches c ON c.id = a.coach_id
         WHERE a.organization_id = p_organization_id
           AND c.user_id = p_user_id
           AND EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.organization_id = p_organization_id AND m.profile_id = p_user_id)
    ), days AS MATERIALIZED (
        SELECT t.team_id, public.team_local_today(t.team_id) AS today
          FROM (SELECT DISTINCT team_id FROM mine) t
    )
    SELECT DISTINCT m.team_id
      FROM mine m
      JOIN days d ON d.team_id = m.team_id
     WHERE m.effective_from <= d.today
       AND (m.effective_to IS NULL OR m.effective_to >= d.today);
$function$;
REVOKE ALL ON FUNCTION public.coached_team_ids_of(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.coached_team_ids_of(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_my_coached_team_ids(p_organization_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT public.coached_team_ids_of(p_organization_id, auth.uid());
$function$;
REVOKE ALL ON FUNCTION public.get_my_coached_team_ids(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_coached_team_ids(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_get_coached_team_ids(p_organization_id uuid, p_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'admin_get_coached_team_ids requires an organization admin' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT public.coached_team_ids_of(p_organization_id, p_user_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_get_coached_team_ids(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_coached_team_ids(uuid,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.coach_field_ids_of(p_organization_id uuid, p_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    WITH mine AS MATERIALIZED (
        SELECT t AS team_id FROM public.coached_team_ids_of(p_organization_id, p_user_id) t
    )
    SELECT gs.field_id
      FROM public.games g
      JOIN public.game_slots gs ON gs.id = g.game_slot_id
     WHERE g.organization_id = p_organization_id
       AND gs.organization_id = p_organization_id
       AND gs.field_id IS NOT NULL
       AND (g.home_team_id IN (SELECT team_id FROM mine) OR g.away_team_id IN (SELECT team_id FROM mine))
    UNION
    SELECT ps.field_id
      FROM public.practice_assignments pa
      JOIN public.practice_slots ps ON ps.id IN (pa.practice_slot_id, pa.slot_id)
     WHERE pa.organization_id = p_organization_id
       AND ps.organization_id = p_organization_id
       AND ps.field_id IS NOT NULL
       AND pa.team_id IN (SELECT team_id FROM mine);
$function$;
REVOKE ALL ON FUNCTION public.coach_field_ids_of(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.coach_field_ids_of(uuid,uuid) TO service_role;
COMMENT ON FUNCTION public.coach_field_ids_of(uuid,uuid) IS 'Internal: the fields where a team the user currently coaches has a game (games on a game_slots field) or a practice (practice_assignments on a practice_slots field). No client role may execute it. 20261102010000.';

CREATE OR REPLACE FUNCTION public.coach_covers_permit_scope(p_organization_id uuid, p_location_id uuid, p_field_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1
          FROM public.coach_field_ids_of(p_organization_id, auth.uid()) c(field_id)
         WHERE (p_field_id IS NOT NULL AND c.field_id = p_field_id)
            OR (p_location_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.fields f
                     WHERE f.id = c.field_id AND f.location_id = p_location_id
                       AND f.organization_id = p_organization_id))
    );
$function$;
REVOKE ALL ON FUNCTION public.coach_covers_permit_scope(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.coach_covers_permit_scope(uuid,uuid,uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.coach_covers_permit_scope(uuid,uuid,uuid) IS 'Policy helper: true when one of the CALLER''s coached-team fields is the scope''s field or lies at the scope''s venue. Asks about the caller only. 20261102010000.';

CREATE OR REPLACE FUNCTION public.coach_reads_facility_permit(p_permit_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1
          FROM public.facility_permit_scopes s
         WHERE s.permit_id = p_permit_id
           AND public.coach_covers_permit_scope(s.organization_id, s.location_id, s.field_id)
    );
$function$;
REVOKE ALL ON FUNCTION public.coach_reads_facility_permit(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.coach_reads_facility_permit(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.coach_reads_facility_permit(uuid) IS 'Policy helper: true when some scope of the permit concerns a field where a team the caller currently coaches has a game or a practice. 20261102010000.';

CREATE OR REPLACE FUNCTION public.coach_reads_facility_permit_file(p_organization_id uuid, p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1
          FROM public.facility_permits p
         WHERE p.organization_id = p_organization_id
           AND p.file_path = p_name
           AND public.coach_reads_facility_permit(p.id)
    );
$function$;
REVOKE ALL ON FUNCTION public.coach_reads_facility_permit_file(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.coach_reads_facility_permit_file(uuid,text) TO authenticated, service_role;
COMMENT ON FUNCTION public.coach_reads_facility_permit_file(uuid,text) IS 'Policy helper for the facility-permits bucket: true when the object is the live file_path of a permit the caller may read as a coach, so a replaced or orphaned file is never theirs. 20261102010000.';

CREATE OR REPLACE FUNCTION public.caller_coaches_practice_slot(p_practice_slot_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1
          FROM public.practice_slots ps
          JOIN public.practice_assignments pa
            ON COALESCE(pa.practice_slot_id, pa.slot_id) = ps.id
           AND pa.organization_id = ps.organization_id
          JOIN public.team_coach_assignments tca
            ON tca.team_id = pa.team_id
           AND tca.organization_id = ps.organization_id
          JOIN public.coaches c
            ON c.id = tca.coach_id
           AND c.organization_id = ps.organization_id
         WHERE ps.id = p_practice_slot_id
           AND c.user_id = auth.uid()
           AND tca.effective_from <= current_date
           AND (tca.effective_to IS NULL OR tca.effective_to >= current_date)
    );
$function$;
REVOKE ALL ON FUNCTION public.caller_coaches_practice_slot(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.caller_coaches_practice_slot(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.caller_coaches_practice_slot(uuid) IS 'True when the caller coaches (team_coach_assignments, current today) a team with a practice_assignments row on the slot. The one enumerator the lighting-override request RPC and read policy share.';

CREATE OR REPLACE FUNCTION public.request_coach_practice_preference(p_coach_id uuid, p_dimension text, p_level text, p_value jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_value jsonb := NULLIF(p_value, 'null'::jsonb);
    v_org uuid;
    v_is_self boolean;
    v_id uuid;
BEGIN
    IF p_coach_id IS NULL OR p_dimension IS NULL OR p_level IS NULL THEN
        RAISE EXCEPTION 'p_coach_id, p_dimension and p_level are required'
            USING ERRCODE = '23502';
    END IF;

    SELECT c.organization_id INTO v_org FROM public.coaches c WHERE c.id = p_coach_id;

    -- An unknown coach and a coach who is not the caller refuse alike, so the
    -- RPC cannot be used to probe which coach ids exist.
    v_is_self := v_uid IS NOT NULL AND EXISTS (
        SELECT 1
          FROM public.coaches c
         WHERE c.id = p_coach_id
           AND c.user_id = v_uid
    );
    IF v_org IS NULL
       OR NOT ((v_is_self AND public.is_org_member(v_org)) OR public.is_org_admin(v_org)) THEN
        RAISE EXCEPTION 'Access denied: only the coach themself or an admin of their organization requests a coach practice preference'
            USING ERRCODE = '42501';
    END IF;

    IF p_dimension = 'venue' AND jsonb_typeof(v_value) = 'string' AND NOT EXISTS (
        SELECT 1 FROM public.locations l
         WHERE l.organization_id = v_org AND l.id::text = v_value #>> '{}'
    ) THEN
        RAISE EXCEPTION 'venue % is not a location of the coach''s organization', v_value #>> '{}'
            USING ERRCODE = '23503';
    END IF;

    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, dimension, level, value, status, requested_by)
    VALUES (v_org, p_coach_id, p_dimension, p_level, v_value, 'requested', v_uid)
    RETURNING id INTO v_id;

    PERFORM public.record_audit_event(
        v_org,
        'coach_preference.requested',
        'coach_practice_preference',
        v_id,
        jsonb_build_object(
            'coach_id', p_coach_id, 'dimension', p_dimension, 'level', p_level,
            'value', v_value, 'by_coach', v_is_self
        )
    );

    RETURN jsonb_build_object(
        'id', v_id, 'organization_id', v_org, 'coach_id', p_coach_id,
        'dimension', p_dimension, 'level', p_level, 'value', v_value, 'status', 'requested'
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.request_coach_practice_preference(uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_coach_practice_preference(uuid,text,text,jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION public.request_coach_practice_preference(uuid,text,text,jsonb) IS 'A coach (for themself) or an org admin requests a practice preference. Never in force until decided. Audited as coach_preference.requested.';

CREATE OR REPLACE FUNCTION public.division_teams_of(p_organization_id uuid, p_user_id uuid)
 RETURNS TABLE(division_id uuid, division_name text, team_id uuid, team_name text, coach_names text[], is_mine boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    WITH mine AS MATERIALIZED (
        SELECT t.id, t.division_id
          FROM public.teams t
         WHERE t.organization_id = p_organization_id
           AND t.id IN (SELECT public.coached_team_ids_of(p_organization_id, p_user_id))
    ), peers AS MATERIALIZED (
        -- Today is worked out once per team, in its season's zone.
        SELECT t.id, t.name, t.division_id, public.team_local_today(t.id) AS today
          FROM public.teams t
         WHERE t.organization_id = p_organization_id
           AND t.division_id IN (SELECT m.division_id FROM mine m WHERE m.division_id IS NOT NULL)
    )
    SELECT p.division_id,
           d.name,
           p.id,
           p.name,
           COALESCE((SELECT array_agg(c.full_name ORDER BY (a.role = 'lead') DESC, c.full_name, c.id)
                       FROM public.team_coach_assignments a
                       JOIN public.coaches c ON c.id = a.coach_id
                      WHERE a.team_id = p.id
                        AND a.organization_id = p_organization_id
                        AND a.effective_from <= p.today
                        AND (a.effective_to IS NULL OR a.effective_to >= p.today)
                        AND c.full_name IS NOT NULL), '{}'::text[]),
           p.id IN (SELECT m.id FROM mine m)
      FROM peers p
      JOIN public.divisions d ON d.id = p.division_id AND d.organization_id = p_organization_id
     ORDER BY d.name, p.name, p.id;
$function$;
REVOKE ALL ON FUNCTION public.division_teams_of(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.division_teams_of(uuid,uuid) TO service_role;
COMMENT ON FUNCTION public.division_teams_of(uuid,uuid) IS 'Internal: each team in a division where the user currently coaches a team, with its current coaches'' names; no contacts. 20261028010000.';

CREATE OR REPLACE FUNCTION public.get_my_division_teams(p_organization_id uuid)
 RETURNS TABLE(division_id uuid, division_name text, team_id uuid, team_name text, coach_names text[], is_mine boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'get_my_division_teams requires a signed-in caller' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT * FROM public.division_teams_of(p_organization_id, auth.uid()) t
                  ORDER BY t.division_name, t.team_name, t.team_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_my_division_teams(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_division_teams(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_my_division_teams(uuid) IS 'The teams in the caller''s divisions (where they currently coach a team): division, team, current coaches'' names, and whether the caller coaches it. No contact details. 20261028010000.';

CREATE OR REPLACE FUNCTION public.admin_get_division_teams(p_organization_id uuid, p_user_id uuid)
 RETURNS TABLE(division_id uuid, division_name text, team_id uuid, team_name text, coach_names text[], is_mine boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'admin_get_division_teams requires an organization admin' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT * FROM public.division_teams_of(p_organization_id, p_user_id) t
                  ORDER BY t.division_name, t.team_name, t.team_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_get_division_teams(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_division_teams(uuid,uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.admin_get_division_teams(uuid,uuid) IS 'An org admin''s role preview of get_my_division_teams for another member. 20261028010000.';

CREATE OR REPLACE FUNCTION public.link_my_coach_record()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.link_my_coach_record() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_my_coach_record() TO authenticated, service_role;
COMMENT ON FUNCTION public.link_my_coach_record() IS 'Links the caller to the coach row matching their verified email in an organization they belong to. Idempotent; audited. 20261020040000.';

-- ---------------------------------------------------------------------------
-- 2. The replaced functions, as they stood at 20261103020000.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.facility_permit_json(p_permit_id uuid, p_today date, p_coach_only boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT jsonb_build_object(
        'id', p.id,
        'organization_id', p.organization_id,
        'issuer', p.issuer,
        'permit_number', p.permit_number,
        'valid_from', p.valid_from,
        'valid_to', p.valid_to,
        'notes', p.notes,
        'status', public.facility_permit_status(p.valid_from, p.valid_to, p_today),
        'days_left', p.valid_to - p_today,
        'file', CASE WHEN p.file_path IS NULL THEN NULL
                     ELSE jsonb_build_object('path', p.file_path, 'name', p.file_name,
                                             'mime', p.file_mime, 'size', p.file_size) END,
        'scopes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', s.id,
                       'kind', CASE WHEN s.field_id IS NOT NULL THEN 'field' ELSE 'location' END,
                       'field_id', s.field_id,
                       'location_id', COALESCE(s.location_id, f.location_id),
                       'field_name', f.name,
                       'location_name', COALESCE(l.name, fl.name),
                       -- Retired: the field's or its venue's end date has passed (by containment).
                       'retired', NOT (public.field_is_live_on(f.effective_to, p_today)
                                       AND public.field_is_live_on(COALESCE(l.effective_to, fl.effective_to), p_today))
                   ) ORDER BY COALESCE(l.name, fl.name), f.name NULLS FIRST, s.id)
              FROM public.facility_permit_scopes s
              LEFT JOIN public.fields f ON f.id = s.field_id
              LEFT JOIN public.locations l ON l.id = s.location_id
              LEFT JOIN public.locations fl ON fl.id = f.location_id
             WHERE s.permit_id = p.id
               AND (NOT p_coach_only
                    OR public.coach_covers_permit_scope(s.organization_id, s.location_id, s.field_id))
        ), '[]'::jsonb),
        'created_at', p.created_at,
        'updated_at', p.updated_at
    )
    FROM public.facility_permits p
    WHERE p.id = p_permit_id;
$function$;
REVOKE ALL ON FUNCTION public.facility_permit_json(uuid,date,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.facility_permit_json(uuid,date,boolean) TO service_role;
COMMENT ON FUNCTION public.facility_permit_json(uuid,date,boolean) IS 'Internal: a permit as the RPCs return it: its fields, status and days_left on p_today, the file (path, name, mime, size) or null, and its scopes with names and a retired flag. p_coach_only keeps only the scopes that concern the caller''s fields. 20261102010000.';

-- The permit writers and the read call the three-argument view again.

CREATE OR REPLACE FUNCTION public.admin_create_facility_permit(p_organization_id uuid, p_issuer text, p_permit_number text, p_valid_from date, p_valid_to date, p_notes text, p_location_ids uuid[], p_field_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_issuer text := btrim(COALESCE(p_issuer, ''));
    v_number text := NULLIF(btrim(COALESCE(p_permit_number, '')), '');
    v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
    v_locations uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_location_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL);
    v_fields uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_field_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL);
    v_permit public.facility_permits%ROWTYPE;
    v_view jsonb;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_valid_from IS NULL OR p_valid_to IS NULL THEN
        RAISE EXCEPTION 'a permit needs the dates it is valid from and to' USING ERRCODE = '23502';
    END IF;

    PERFORM public.facility_permit_check(v_issuer, v_number, v_notes, p_valid_from, p_valid_to,
                                         v_locations, v_fields, p_organization_id);

    INSERT INTO public.facility_permits (organization_id, issuer, permit_number, valid_from, valid_to, notes, created_by)
    VALUES (p_organization_id, v_issuer, v_number, p_valid_from, p_valid_to, v_notes, auth.uid())
    RETURNING * INTO v_permit;

    INSERT INTO public.facility_permit_scopes (permit_id, organization_id, location_id)
    SELECT v_permit.id, p_organization_id, x FROM unnest(v_locations) x;
    INSERT INTO public.facility_permit_scopes (permit_id, organization_id, field_id)
    SELECT v_permit.id, p_organization_id, x FROM unnest(v_fields) x;

    v_view := public.facility_permit_json(v_permit.id, public.org_local_today(p_organization_id), false);

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', v_permit.id,
        jsonb_build_object('setting', 'facility.permit', 'operation', 'created', 'current', v_view)
    );

    RETURN v_view;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_create_facility_permit(uuid,text,text,date,date,text,uuid[],uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_facility_permit(uuid,text,text,date,date,text,uuid[],uuid[]) TO authenticated, service_role;
COMMENT ON FUNCTION public.admin_create_facility_permit(uuid,text,text,date,date,text,uuid[],uuid[]) IS 'Admin-only: record a permit (issuer, text number, inclusive dates, notes) covering the named venues and fields, all of this organization''s and at least one (22023 otherwise). Audited as facility.permit/created. A permit blocks nothing. 20261102010000.';

CREATE OR REPLACE FUNCTION public.admin_update_facility_permit(p_organization_id uuid, p_permit_id uuid, p_issuer text, p_permit_number text, p_valid_from date, p_valid_to date, p_notes text, p_location_ids uuid[], p_field_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_issuer text := btrim(COALESCE(p_issuer, ''));
    v_number text := NULLIF(btrim(COALESCE(p_permit_number, '')), '');
    v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
    v_locations uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_location_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL);
    v_fields uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_field_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL);
    v_today date;
    v_permit public.facility_permits%ROWTYPE;
    v_previous jsonb;
    v_view jsonb;
BEGIN
    IF p_organization_id IS NULL OR p_permit_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id and p_permit_id are required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_valid_from IS NULL OR p_valid_to IS NULL THEN
        RAISE EXCEPTION 'a permit needs the dates it is valid from and to' USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_permit FROM public.facility_permits
     WHERE id = p_permit_id AND organization_id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'permit % was not found in organization %', p_permit_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    PERFORM public.facility_permit_check(v_issuer, v_number, v_notes, p_valid_from, p_valid_to,
                                         v_locations, v_fields, p_organization_id);

    v_today := public.org_local_today(p_organization_id);
    v_previous := public.facility_permit_json(p_permit_id, v_today, false);

    UPDATE public.facility_permits
       SET issuer = v_issuer, permit_number = v_number, valid_from = p_valid_from,
           valid_to = p_valid_to, notes = v_notes
     WHERE id = p_permit_id;

    -- The scope set is replaced: what is no longer named goes, what is new is added, what stays is untouched.
    DELETE FROM public.facility_permit_scopes s
     WHERE s.permit_id = p_permit_id
       AND NOT (COALESCE(s.location_id = ANY (v_locations), false)
                OR COALESCE(s.field_id = ANY (v_fields), false));
    INSERT INTO public.facility_permit_scopes (permit_id, organization_id, location_id)
    SELECT p_permit_id, p_organization_id, x FROM unnest(v_locations) x
     WHERE NOT EXISTS (SELECT 1 FROM public.facility_permit_scopes s WHERE s.permit_id = p_permit_id AND s.location_id = x);
    INSERT INTO public.facility_permit_scopes (permit_id, organization_id, field_id)
    SELECT p_permit_id, p_organization_id, x FROM unnest(v_fields) x
     WHERE NOT EXISTS (SELECT 1 FROM public.facility_permit_scopes s WHERE s.permit_id = p_permit_id AND s.field_id = x);

    v_view := public.facility_permit_json(p_permit_id, v_today, false);

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', p_permit_id,
        jsonb_build_object('setting', 'facility.permit', 'operation', 'updated',
                           'previous', v_previous, 'current', v_view)
    );

    RETURN v_view;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_update_facility_permit(uuid,uuid,text,text,date,date,text,uuid[],uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_facility_permit(uuid,uuid,text,text,date,date,text,uuid[],uuid[]) TO authenticated, service_role;
COMMENT ON FUNCTION public.admin_update_facility_permit(uuid,uuid,text,text,date,date,text,uuid[],uuid[]) IS 'Admin-only: change a permit and replace its scope set; the file is untouched. Audited with the previous and current permit. 20261102010000.';

CREATE OR REPLACE FUNCTION public.admin_set_facility_permit_file(p_organization_id uuid, p_permit_id uuid, p_object_path text, p_file_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    c_uuid constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    v_name text := btrim(COALESCE(p_file_name, ''));
    v_permit public.facility_permits%ROWTYPE;
    v_meta jsonb;
    v_mime text;
    v_size bigint;
    v_today date;
    v_previous jsonb;
    v_view jsonb;
BEGIN
    IF p_organization_id IS NULL OR p_permit_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id and p_permit_id are required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_object_path IS NULL OR v_name = '' THEN
        RAISE EXCEPTION 'p_object_path and p_file_name are required' USING ERRCODE = '23502';
    END IF;
    IF char_length(v_name) > 255 OR v_name ~ '[/\\]' THEN
        RAISE EXCEPTION 'the file name must be 1 to 255 characters with no slash' USING ERRCODE = '22023', DETAIL = 'file_name';
    END IF;

    SELECT * INTO v_permit FROM public.facility_permits
     WHERE id = p_permit_id AND organization_id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'permit % was not found in organization %', p_permit_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    -- The object is <organization>/<permit>/<uuid>.<ext>: this permit's own folder, nothing else.
    -- The two folders are compared exactly (a stored path is checked against the permit's own
    -- lowercase ids by the table's CHECK); the file's name and extension are read without regard to case.
    IF array_length(string_to_array(p_object_path, '/'), 1) IS DISTINCT FROM 3
       OR split_part(p_object_path, '/', 1) <> p_organization_id::text
       OR split_part(p_object_path, '/', 2) <> p_permit_id::text
       OR split_part(p_object_path, '/', 3) !~* ('^' || c_uuid || '\.(pdf|jpg|jpeg|png)$') THEN
        RAISE EXCEPTION 'the object must be <organization>/<permit>/<uuid>.<pdf|jpg|jpeg|png> in this permit''s folder'
            USING ERRCODE = '22023', DETAIL = 'object_path';
    END IF;
    IF v_permit.file_path IS NOT DISTINCT FROM p_object_path THEN
        RAISE EXCEPTION 'that object is already this permit''s file' USING ERRCODE = '22023', DETAIL = 'already_attached';
    END IF;

    -- It must really be there, and be what the bucket's limits admit. The Storage API enforces the
    -- bucket's type and size on upload; this reads what it recorded.
    SELECT o.metadata INTO v_meta FROM storage.objects o
     WHERE o.bucket_id = 'facility-permits' AND o.name = p_object_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no uploaded object %', p_object_path USING ERRCODE = '22023', DETAIL = 'object_missing';
    END IF;
    v_mime := v_meta ->> 'mimetype';
    IF v_mime IS NULL OR v_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png') THEN
        RAISE EXCEPTION 'the object is %, not a PDF, JPEG or PNG', COALESCE(v_mime, 'of unknown type')
            USING ERRCODE = '22023', DETAIL = 'file_type';
    END IF;
    IF (v_meta ->> 'size') IS NULL OR (v_meta ->> 'size') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'the object has no readable size' USING ERRCODE = '22023', DETAIL = 'file_size';
    END IF;
    v_size := (v_meta ->> 'size')::bigint;
    IF v_size < 1 OR v_size > 10485760 THEN
        RAISE EXCEPTION 'the object is % bytes; a permit file is 1 byte to 10 MiB', v_size
            USING ERRCODE = '22023', DETAIL = 'file_size';
    END IF;

    v_today := public.org_local_today(p_organization_id);
    v_previous := public.facility_permit_json(p_permit_id, v_today, false);

    UPDATE public.facility_permits
       SET file_path = p_object_path, file_name = v_name, file_mime = v_mime, file_size = v_size
     WHERE id = p_permit_id;

    v_view := public.facility_permit_json(p_permit_id, v_today, false);

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', p_permit_id,
        jsonb_build_object('setting', 'facility.permit',
                           'operation', CASE WHEN v_permit.file_path IS NULL THEN 'file_attached' ELSE 'file_replaced' END,
                           'previous_file', v_previous -> 'file', 'current_file', v_view -> 'file')
    );

    RETURN jsonb_build_object('permit', v_view, 'previous_path', v_permit.file_path);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_set_facility_permit_file(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_facility_permit_file(uuid,uuid,text,text) TO authenticated, service_role;
COMMENT ON FUNCTION public.admin_set_facility_permit_file(uuid,uuid,text,text) IS 'Admin-only: attach (or replace) the permit''s file. The object must exist in the facility-permits bucket under this permit''s folder with an allowed type and size. Returns {permit, previous_path}; the caller removes the previous object after this commits. Audited as file_attached or file_replaced. 20261102010000.';

CREATE OR REPLACE FUNCTION public.admin_delete_facility_permit(p_organization_id uuid, p_permit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_permit public.facility_permits%ROWTYPE;
    v_previous jsonb;
BEGIN
    IF p_organization_id IS NULL OR p_permit_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id and p_permit_id are required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_permit FROM public.facility_permits
     WHERE id = p_permit_id AND organization_id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'permit % was not found in organization %', p_permit_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    v_previous := public.facility_permit_json(p_permit_id, public.org_local_today(p_organization_id), false);

    DELETE FROM public.facility_permits WHERE id = p_permit_id;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', p_permit_id,
        jsonb_build_object('setting', 'facility.permit', 'operation', 'deleted', 'previous', v_previous)
    );

    RETURN jsonb_build_object('id', p_permit_id, 'deleted', true, 'file_path', v_permit.file_path);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_delete_facility_permit(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_facility_permit(uuid,uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.admin_delete_facility_permit(uuid,uuid) IS 'Admin-only: delete a permit and its scopes. Returns {id, deleted, file_path}; the caller removes the object after this commits. The audit row keeps the whole permit. 20261102010000.';

CREATE OR REPLACE FUNCTION public.get_facility_permits(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_admin boolean;
    v_today date;
    v_permits jsonb;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '23502';
    END IF;
    v_admin := public.is_org_admin(p_organization_id);
    -- Anyone but an admin must be a coach of a team right now: a coach-role member with no
    -- assignment is no coach to the server (20261021010000).
    IF NOT v_admin AND NOT EXISTS (
        SELECT 1 FROM public.coached_team_ids_of(p_organization_id, auth.uid())
    ) THEN
        RAISE EXCEPTION 'Access denied: permits are read by an administrator or a coach of a team' USING ERRCODE = '42501';
    END IF;

    v_today := public.org_local_today(p_organization_id);

    SELECT COALESCE(jsonb_agg(public.facility_permit_json(p.id, v_today, NOT v_admin)
                              ORDER BY p.valid_to, p.issuer, p.id), '[]'::jsonb)
      INTO v_permits
      FROM public.facility_permits p
     WHERE p.organization_id = p_organization_id
       AND (v_admin OR public.coach_reads_facility_permit(p.id));

    RETURN jsonb_build_object('today', v_today, 'lead_days', 30, 'permits', v_permits);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_facility_permits(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_facility_permits(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_facility_permits(uuid) IS 'An admin or staff member reads every permit of the organization; a coach of a team reads the permits that concern a field where a team they currently coach has a game or a practice (or its venue), with only those scopes; anyone else gets 42501. Returns {today, lead_days, permits}: each permit with scope names, a retired flag per scope, and status and days_left on the organization''s own day. 20261102010000.';

CREATE OR REPLACE FUNCTION public.get_team_roster(p_team_id uuid)
 RETURNS TABLE(player_id uuid, first_name text, last_name text, preferred_name text, jersey_number smallint, gender text, years_played smallint, rating smallint, willing_to_coach boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
           CASE WHEN v_admin THEN p.gender END,
           CASE WHEN v_admin THEN p.years_played END,
           CASE WHEN v_admin THEN p.rating END,
           CASE WHEN v_admin THEN p.willing_to_coach END
      FROM public.team_players tp
      JOIN public.players p ON p.id = tp.player_id
     WHERE tp.team_id = p_team_id
     ORDER BY p.last_name, p.first_name, p.id;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_team_roster(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_team_roster(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_team_roster(uuid) IS 'Team roster: admins/staff read names, jersey number, gender, years played, rating and coaching interest; a current coach of the team reads names and jersey number only. No contact details. 20261021010000; guardians out 20261024010000; contacts out 20261025010000.';

CREATE OR REPLACE FUNCTION public.get_team_staff(p_team_id uuid)
 RETURNS TABLE(coach_id uuid, full_name text, role text, status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
           CASE WHEN v_admin THEN c.status END
      FROM public.team_coach_assignments a
      JOIN public.coaches c ON c.id = a.coach_id
     WHERE a.team_id = p_team_id
       AND a.effective_from <= v_today
       AND (a.effective_to IS NULL OR a.effective_to >= v_today)
     ORDER BY (a.role = 'lead') DESC, c.full_name, c.id;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_team_staff(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_team_staff(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_team_staff(uuid) IS 'Current coaches of a team: name and role, and status to admins/staff; admins/staff and a current coach of the team. No contact details. 20261021010000; guardians out 20261024010000; contacts out 20261025010000.';

CREATE OR REPLACE FUNCTION public.rotate_calendar_token(p_team_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_new_token uuid := gen_random_uuid();
    v_org_id uuid;
    v_expires timestamptz := now() + interval '90 days';
BEGIN
    SELECT organization_id INTO v_org_id FROM public.teams WHERE id = p_team_id;

    -- An unknown team and a refused caller answer alike.
    IF v_org_id IS NULL
       OR NOT (public.is_org_admin(v_org_id) OR public.is_current_team_coach(p_team_id)) THEN
        RETURN json_build_object('status', 'error', 'message', 'Access denied');
    END IF;

    INSERT INTO public.team_calendar_tokens (team_id, token, expires_at, rotated_at)
    VALUES (p_team_id, v_new_token, v_expires, now())
    ON CONFLICT (team_id) DO UPDATE
       SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, rotated_at = EXCLUDED.rotated_at;

    PERFORM public.record_audit_event(
        v_org_id,
        'calendar.token_rotated',
        'team',
        p_team_id,
        jsonb_build_object('new_expires_at', v_expires::text)
    );

    RETURN json_build_object(
        'status', 'success',
        'calendar_token', v_new_token,
        'expires_at', v_expires::text
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.rotate_calendar_token(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rotate_calendar_token(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.rotate_calendar_token(uuid) IS 'Rotates a team''s calendar feed token; admins/staff and the team''s current coaches only. Audited. 20261021020000.';

CREATE OR REPLACE FUNCTION public.create_org_invite(p_org_id uuid, p_role text, p_expires_in interval DEFAULT '7 days'::interval)
 RETURNS TABLE(code text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.create_org_invite(uuid,text,interval) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_org_invite(uuid,text,interval) TO authenticated, service_role;
COMMENT ON FUNCTION public.create_org_invite(uuid,text,interval) IS 'Admin-only. Mints a single-use invite code for the given org + role.';

CREATE OR REPLACE FUNCTION public.admin_change_member_role(p_organization_id uuid, p_profile_id uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.admin_change_member_role(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_change_member_role(uuid,uuid,text) TO authenticated, service_role;
COMMENT ON FUNCTION public.admin_change_member_role(uuid,uuid,text) IS 'Audited org member role change; blocks demoting last admin.';

CREATE OR REPLACE FUNCTION public.import_allowed_keys(p_import_type text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
    SELECT CASE p_import_type
        WHEN 'players' THEN ARRAY[
            'first_name', 'last_name', 'preferred_name', 'nickname', 'external_registration_id',
            'gotsport_id', 'registration_id', 'player_id', 'natural_age',
            'age group', 'age_group', 'age', 'gender', 'grade', 'division_id', 'division_name',
            'division', 'group', 'program', 'skill_tier', 'skill_level', 'years_played',
            'years played',
            'how many years has your player played in an organized soccer program?', 'waitlist',
            'waitlisted', 'play_up', 'play up',
            'are you coaching so this player can play up a division?', 'willing_to_coach',
            'coach_volunteer', 'can you coach for this player''s team?', 'buddy_request',
            'buddy_id', 'buddy_external_registration_id', 'buddy_registration_id',
            'friend_request', 'mutual_buddy_code', 'buddy_code', 'friend_code', 'team name',
            'team age', 'team gender'
        ]::text[]
        WHEN 'coaches' THEN ARRAY[
            'full_name', 'email', 'status', 'coach_status', 'can_coach_multiple_teams',
            'multiple_teams', 'multi_team', 'certifications', 'certification', 'first_name',
            'last_name'
        ]::text[]
        ELSE ARRAY[]::text[]
    END;
$function$;
REVOKE ALL ON FUNCTION public.import_allowed_keys(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.import_allowed_keys(text) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_coach_import_job(p_import_job_id uuid, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_row public.staging_import_rows%ROWTYPE;
    v_existing public.coaches%ROWTYPE;
    v_after public.coaches%ROWTYPE;
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_email text;
    v_full_name text;
    v_status text;
    v_can_multi_text text;
    v_can_multi boolean;
    v_certifications jsonb;
    v_contact_info jsonb;
    v_custom_attributes jsonb;
    v_declared jsonb;
    v_previous_payload jsonb;
    v_existing_found boolean;
    v_inserted_count integer := 0;
    v_updated_count integer := 0;
    v_invalid_count integer := 0;
    v_cross_org_conflict_count integer := 0;
    v_blocked_assignment_count integer := 0;
    v_total_applied_count integer := 0;
    v_status_result text;
    v_result jsonb;
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

    -- The organization's declared coach fields, read once for every row.
    v_declared := public.import_declared_fields(v_job.organization_id, 'coach');

    -- Deliberately row-oriented for the coach slice: each applied row needs an
    -- exact rollback snapshot and independent conflict outcome. The Edge
    -- Function caps imports at 5,000 rows; set-based promotion can replace
    -- this once field-slot promotion shares the same ledger.
    FOR v_row IN
        SELECT *
        FROM public.staging_import_rows
        WHERE import_job_id = p_import_job_id
          AND organization_id = v_job.organization_id
          AND import_type = 'coaches'
          AND applied_at IS NULL
          AND normalized_payload IS NOT NULL
          AND COALESCE(jsonb_array_length(validation_errors), 0) = 0
        ORDER BY source_row_number NULLS LAST, id
    LOOP
        v_email := lower(public.import_payload_text(v_row.normalized_payload, 'email'));
        v_full_name := public.import_payload_text(v_row.normalized_payload, 'full_name');
        v_status := lower(COALESCE(
            public.import_payload_text(v_row.normalized_payload, 'status', 'coach_status'),
            'active'
        ));
        v_can_multi_text := public.import_payload_text(
            v_row.normalized_payload,
            'can_coach_multiple_teams',
            'multiple_teams',
            'multi_team'
        );
        v_certifications := public.import_text_to_jsonb_array(
            public.import_payload_text(v_row.normalized_payload, 'certifications', 'certification')
        );
        -- The coach's email is how they sign in; no phone is stored (R0).
        v_contact_info := jsonb_strip_nulls(jsonb_build_object('email', v_email));
        -- The allowlist (R0): only the fields the organization declared for
        -- coaches, keyed by their declared names. Every other column of the
        -- export (a child's details, guardians' addresses and phones, the
        -- coach's own birth date) is dropped here, whatever reached staging.
        v_custom_attributes := public.import_declared_attributes(v_declared, v_row.normalized_payload);

        IF v_email IS NULL
           OR v_full_name IS NULL
           OR v_status NOT IN ('active', 'pending-confirmation', 'inactive') THEN
            v_invalid_count := v_invalid_count + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Coach row is missing full_name/email or has an invalid status',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

        SELECT *
        INTO v_existing
        FROM public.coaches c
        WHERE lower(c.email) = v_email
        ORDER BY c.created_at, c.id
        LIMIT 1;
        v_existing_found := FOUND;

        IF v_existing_found AND v_existing.organization_id <> v_job.organization_id THEN
            v_cross_org_conflict_count := v_cross_org_conflict_count + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Coach email already belongs to another organization',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

        IF v_existing_found
           AND v_status = 'inactive'
           AND EXISTS (
                SELECT 1
                FROM public.teams t
                WHERE t.organization_id = v_job.organization_id
                  AND (
                    t.coach_id = v_existing.id
                    OR v_existing.id = ANY(COALESCE(t.assistant_coach_ids, '{}'::uuid[]))
                  )
           ) THEN
            v_blocked_assignment_count := v_blocked_assignment_count + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Assigned coaches cannot be marked inactive by import',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

        IF v_existing_found THEN
            v_previous_payload := to_jsonb(v_existing);
            v_can_multi := CASE
                WHEN v_can_multi_text IS NULL THEN COALESCE(v_existing.can_coach_multiple_teams, false)
                ELSE public.import_text_to_bool(v_can_multi_text)
            END;

            UPDATE public.coaches
            SET
                full_name = v_full_name,
                email = v_email,
                certifications = COALESCE(NULLIF(v_certifications, '[]'::jsonb), v_existing.certifications),
                can_coach_multiple_teams = v_can_multi,
                status = v_status,
                contact_info = (COALESCE(v_existing.contact_info, '{}'::jsonb) - 'phone') || v_contact_info,
                last_imported_at = v_now,
                import_source = 'coach_csv',
                custom_attributes = public.import_declared_attributes(
                    v_declared, COALESCE(v_existing.custom_attributes, '{}'::jsonb)
                ) || v_custom_attributes,
                updated_at = v_now
            WHERE id = v_existing.id
              AND organization_id = v_job.organization_id
            RETURNING * INTO v_after;

            INSERT INTO public.import_application_records (
                organization_id,
                import_job_id,
                import_type,
                target_table,
                target_id,
                operation,
                previous_payload,
                applied_payload,
                applied_at,
                applied_by
            )
            VALUES (
                v_job.organization_id,
                p_import_job_id,
                'coaches',
                'coaches',
                v_after.id,
                'updated',
                v_previous_payload,
                to_jsonb(v_after),
                v_now,
                auth.uid()
            )
            ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

            v_updated_count := v_updated_count + 1;
        ELSE
            v_can_multi := COALESCE(public.import_text_to_bool(v_can_multi_text), false);

            INSERT INTO public.coaches (
                organization_id,
                full_name,
                email,
                certifications,
                can_coach_multiple_teams,
                status,
                contact_info,
                last_imported_at,
                import_source,
                custom_attributes
            )
            VALUES (
                v_job.organization_id,
                v_full_name,
                v_email,
                v_certifications,
                v_can_multi,
                v_status,
                v_contact_info,
                v_now,
                'coach_csv',
                v_custom_attributes
            )
            RETURNING * INTO v_after;

            INSERT INTO public.import_application_records (
                organization_id,
                import_job_id,
                import_type,
                target_table,
                target_id,
                operation,
                previous_payload,
                applied_payload,
                applied_at,
                applied_by
            )
            VALUES (
                v_job.organization_id,
                p_import_job_id,
                'coaches',
                'coaches',
                v_after.id,
                'inserted',
                NULL,
                to_jsonb(v_after),
                v_now,
                auth.uid()
            );

            v_inserted_count := v_inserted_count + 1;
        END IF;

        UPDATE public.staging_import_rows
        SET
            applied_at = v_now,
            applied_by = auth.uid()
        WHERE id = v_row.id;
    END LOOP;

    SELECT count(*)
    INTO v_total_applied_count
    FROM public.import_application_records
    WHERE import_job_id = p_import_job_id
      AND import_type = 'coaches';

    v_status_result := CASE
        WHEN jsonb_array_length(v_validation_errors) > 0
          OR v_invalid_count > 0
          OR v_cross_org_conflict_count > 0
          OR v_blocked_assignment_count > 0
        THEN 'completed_with_warnings'
        ELSE 'completed'
    END;

    v_result := jsonb_build_object(
        'status', v_status_result,
        'staged_rows', (
            SELECT count(*)
            FROM public.staging_import_rows
            WHERE import_job_id = p_import_job_id
              AND import_type = 'coaches'
        ),
        'inserted_coaches', v_inserted_count,
        'updated_coaches', v_updated_count,
        'invalid_rows', v_invalid_count,
        'cross_org_conflict_rows', v_cross_org_conflict_count,
        'blocked_assignment_rows', v_blocked_assignment_count,
        'validation_error_rows', jsonb_array_length(v_validation_errors),
        'total_applied_rows', v_total_applied_count
    );

    UPDATE public.import_jobs
    SET
        status = v_status_result,
        processed_rows = v_total_applied_count,
        progress_percent = 100,
        completed_at = v_now,
        error_summary = jsonb_build_object('rowErrors', v_validation_errors),
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{coach_finalize}',
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
$function$;
REVOKE ALL ON FUNCTION public.finalize_coach_import_job(uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_coach_import_job(uuid,jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rollback_coach_import_job(p_import_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_record public.import_application_records%ROWTYPE;
    v_previous jsonb;
    v_now timestamptz := timezone('utc', now());
    v_deleted_count integer := 0;
    v_restored_count integer := 0;
    v_blocked_count integer := 0;
    v_pending_record_count integer := 0;
    v_result jsonb;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
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

    SELECT count(*)
    INTO v_pending_record_count
    FROM public.import_application_records
    WHERE import_job_id = p_import_job_id
      AND organization_id = v_job.organization_id
      AND import_type = 'coaches'
      AND target_table = 'coaches'
      AND rolled_back_at IS NULL;

    IF v_pending_record_count = 0 THEN
        RAISE EXCEPTION 'Import job % has no coach application records to roll back', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    FOR v_record IN
        SELECT *
        FROM public.import_application_records
        WHERE import_job_id = p_import_job_id
          AND organization_id = v_job.organization_id
          AND import_type = 'coaches'
          AND target_table = 'coaches'
          AND rolled_back_at IS NULL
        ORDER BY applied_at DESC, id DESC
    LOOP
        IF v_record.operation = 'inserted' THEN
            IF EXISTS (
                SELECT 1
                FROM public.teams t
                WHERE t.organization_id = v_job.organization_id
                  AND (
                    t.coach_id = v_record.target_id
                    OR v_record.target_id = ANY(COALESCE(t.assistant_coach_ids, '{}'::uuid[]))
                  )
            ) THEN
                v_blocked_count := v_blocked_count + 1;
                CONTINUE;
            END IF;

            DELETE FROM public.coaches c
            WHERE c.id = v_record.target_id
              AND c.organization_id = v_job.organization_id;

            UPDATE public.import_application_records
            SET
                rolled_back_at = v_now,
                rolled_back_by = auth.uid(),
                rollback_payload = jsonb_build_object('deleted', true)
            WHERE id = v_record.id;

            v_deleted_count := v_deleted_count + 1;
        ELSIF v_record.operation = 'updated' THEN
            v_previous := v_record.previous_payload;

            UPDATE public.coaches
            SET
                full_name = v_previous->>'full_name',
                email = v_previous->>'email',
                phone = v_previous->>'phone',
                certifications = COALESCE(v_previous->'certifications', '[]'::jsonb),
                can_coach_multiple_teams = COALESCE(
                    (v_previous->>'can_coach_multiple_teams')::boolean,
                    false
                ),
                status = v_previous->>'status',
                contact_info = COALESCE(v_previous->'contact_info', '{}'::jsonb),
                last_imported_at = NULLIF(v_previous->>'last_imported_at', '')::timestamptz,
                import_source = v_previous->>'import_source',
                custom_attributes = COALESCE(v_previous->'custom_attributes', '{}'::jsonb),
                updated_at = v_now
            WHERE id = v_record.target_id
              AND organization_id = v_job.organization_id;

            UPDATE public.import_application_records
            SET
                rolled_back_at = v_now,
                rolled_back_by = auth.uid(),
                rollback_payload = v_previous
            WHERE id = v_record.id;

            v_restored_count := v_restored_count + 1;
        END IF;
    END LOOP;

    v_result := jsonb_build_object(
        'status', CASE WHEN v_blocked_count > 0 THEN 'completed_with_warnings' ELSE 'rolled_back' END,
        'deleted_coaches', v_deleted_count,
        'restored_coaches', v_restored_count,
        'blocked_assigned_coaches', v_blocked_count
    );

    UPDATE public.import_jobs
    SET
        status = CASE WHEN v_blocked_count > 0 THEN 'completed_with_warnings' ELSE 'needs_fix' END,
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{coach_rollback}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.rolled_back',
        'import_job',
        p_import_job_id,
        v_result
    );

    RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.rollback_coach_import_job(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rollback_coach_import_job(uuid) TO authenticated, service_role;

DROP FUNCTION public.facility_permit_json(uuid, date);

-- ---------------------------------------------------------------------------
-- 3. The read policies, as they stood at 20261103020000.
-- ---------------------------------------------------------------------------

ALTER POLICY coaches_select_admin ON public.coaches RENAME TO coaches_select_admin_or_self;
ALTER POLICY coaches_select_admin_or_self ON public.coaches
    USING ((is_org_admin(organization_id) OR (is_org_member(organization_id) AND (user_id = ( SELECT auth.uid() AS uid)))));

ALTER POLICY team_coach_assignments_select_admin ON public.team_coach_assignments RENAME TO team_coach_assignments_select_admin_or_self;
ALTER POLICY team_coach_assignments_select_admin_or_self ON public.team_coach_assignments
    USING ((is_org_admin(organization_id) OR (is_org_member(organization_id) AND (coach_id IN ( SELECT c.id
   FROM coaches c
  WHERE (c.user_id = ( SELECT auth.uid() AS uid)))))));

ALTER POLICY "Coach practice preferences: admins read" ON public.coach_practice_preferences RENAME TO "Coach practice preferences: admins and the coach read";
ALTER POLICY "Coach practice preferences: admins and the coach read" ON public.coach_practice_preferences
    USING ((is_org_member(organization_id) AND (is_org_admin(organization_id) OR (EXISTS ( SELECT 1
   FROM coaches c
  WHERE ((c.id = coach_practice_preferences.coach_id) AND (c.organization_id = coach_practice_preferences.organization_id) AND (c.user_id = ( SELECT auth.uid() AS uid))))))));

ALTER POLICY "Practice lighting overrides: admins read" ON public.practice_lighting_overrides RENAME TO "Practice lighting overrides: admins and the slot's coaches read";
ALTER POLICY "Practice lighting overrides: admins and the slot's coaches read" ON public.practice_lighting_overrides
    USING ((is_org_member(organization_id) AND (is_org_admin(organization_id) OR caller_coaches_practice_slot(practice_slot_id))));

ALTER POLICY "Facility permits: admins select" ON public.facility_permits RENAME TO "Facility permits: admins and scheduled coaches select";
ALTER POLICY "Facility permits: admins and scheduled coaches select" ON public.facility_permits
    USING ((is_org_admin(organization_id) OR coach_reads_facility_permit(id)));

ALTER POLICY "Facility permit scopes: admins select" ON public.facility_permit_scopes RENAME TO "Facility permit scopes: admins and scheduled coaches select";
ALTER POLICY "Facility permit scopes: admins and scheduled coaches select" ON public.facility_permit_scopes
    USING ((is_org_admin(organization_id) OR coach_covers_permit_scope(organization_id, location_id, field_id)));

ALTER POLICY team_calendar_tokens_select ON public.team_calendar_tokens
    USING ((is_org_admin(( SELECT t.organization_id
   FROM teams t
  WHERE (t.id = team_calendar_tokens.team_id))) OR is_current_team_coach(team_id)));

COMMENT ON TABLE public.team_calendar_tokens IS 'A team''s calendar feed credential, moved out of teams so only admins/staff and the team''s current coaches read it. Written by the teams insert trigger and rotate_calendar_token only. 20261021020000; guardians out 20261024010000.';

ALTER POLICY "facility-permits select" ON storage.objects
    USING (((bucket_id = 'facility-permits'::text) AND
CASE
    WHEN (name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$'::text) THEN (is_org_admin(((storage.foldername(name))[1])::uuid) OR coach_reads_facility_permit_file(((storage.foldername(name))[1])::uuid, name))
    ELSE false
END));

-- ---------------------------------------------------------------------------
-- 4. The role CHECKs with `coach`, and the global coach email key.
-- ---------------------------------------------------------------------------

ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_role_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_role_check
    CHECK (role = ANY (ARRAY['admin'::text, 'coach'::text, 'staff'::text, 'tenant_admin'::text]));

ALTER TABLE public.organization_invites DROP CONSTRAINT organization_invites_role_check;
ALTER TABLE public.organization_invites ADD CONSTRAINT organization_invites_role_check
    CHECK (role = ANY (ARRAY['admin'::text, 'coach'::text, 'staff'::text]));

ALTER TABLE public.coaches DROP CONSTRAINT coaches_organization_id_email_key;
ALTER TABLE public.coaches DROP CONSTRAINT coaches_email_normalised;
ALTER TABLE public.coaches ADD CONSTRAINT coaches_email_key UNIQUE (email);
COMMENT ON COLUMN public.coaches.email IS NULL;

-- ---------------------------------------------------------------------------
-- 5. reconcile_prod_rls_drift, last: its spec names coaches_select_admin_or_self again.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reconcile_prod_rls_drift()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_spec record;
    v_pol record;
    v_ddl text;
    v_have record;
    v_probe record;
    v_created text[] := ARRAY[]::text[];
    v_verified text[] := ARRAY[]::text[];
    v_dropped text[] := ARRAY[]::text[];
    -- Stated, not read back from the catalogue this function rewrites.
    -- CHANGED (20261022030000): the team chat table is dropped (R2), so it
    -- is no longer a table the broad policy may sit on.
    c_broad_tables text[] := ARRAY['coaches','teams','locations','fields','divisions','game_assignments',
                                   'import_jobs','imports','organization_schemas',
                                   'schedule_evaluations'];
    c_member_write_tables text[] := ARRAY['practice_slots','field_subunits','scheduler_runs'];
BEGIN
    -- 1. Every repo policy on the affected tables, created if missing.
    --    Columns: table, policy, command, roles, USING, WITH CHECK -- each
    --    clause copied verbatim from the source line cited.
    FOR v_spec IN
        SELECT * FROM (VALUES
            -- CHANGED (20261021020000): coaches are read by admins and staff,
            -- and a coach reads their own row; the member-wide policy is gone
            -- and must not come back from here.
            ('coaches', 'coaches_select_admin_or_self', 'SELECT', 'authenticated',
             'public.is_org_admin(organization_id) OR (public.is_org_member(organization_id) AND user_id = (SELECT auth.uid()))', NULL),
            -- 20260331000000_definitive_schema.sql:1036
            ('teams', 'Teams: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260331000000_definitive_schema.sql:1061
            ('game_assignments', 'Game Assignments: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260331000000_definitive_schema.sql:1132
            ('imports', 'Imports: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260331000000_definitive_schema.sql:1137
            ('import_jobs', 'Import Jobs: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- CHANGED (20261018030000): "Users can view their organization's
            -- import jobs" (20260404120000_phase_4_observability.sql:42) is no
            -- longer a repo policy; it repeated the member SELECT above.
            -- 20260331000000_definitive_schema.sql:1167
            ('schedule_evaluations', 'Schedule Evaluations: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- REMOVED (20261022030000): the team chat table and its read
            -- policy are dropped (R2); creating it here would fail.
            -- 20260502001000_division_roster_constraints.sql:103
            ('divisions', 'Divisions: org members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260502001000_division_roster_constraints.sql:107
            ('divisions', 'Divisions: org admins insert', 'INSERT', 'authenticated',
             NULL, 'public.is_org_admin(organization_id)'),
            -- 20260502001000_division_roster_constraints.sql:111
            ('divisions', 'Divisions: org admins update', 'UPDATE', 'authenticated',
             'public.is_org_admin(organization_id)', 'public.is_org_admin(organization_id)'),
            -- 20260502001000_division_roster_constraints.sql:116
            ('divisions', 'Divisions: org admins delete', 'DELETE', 'authenticated',
             'public.is_org_admin(organization_id)', NULL),
            -- 20260504050000_admin_upsert_organization_schema_rpc.sql:13
            ('organization_schemas', 'Schema Access: Org Members Select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:19
            ('locations', 'Locations: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:24
            ('fields', 'Fields: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:29
            ('field_subunits', 'Field Subunits: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:34
            ('practice_slots', 'Practice Slots: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- NEW in 20260928000000 (the repo had no member SELECT on
            -- scheduler_runs): the sibling split of
            -- 20260602010000_consolidated_rls_security_hardening.sql:48-57,
            -- same names and clauses. The admin write keeps the SECURITY
            -- INVOKER persist_practice_schedule working for admins.
            ('scheduler_runs', 'scheduler_runs_select_member', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- CHANGED (20261018030000): scheduler_runs_write_admin (FOR ALL)
            -- is split by command, with the same expression.
            ('scheduler_runs', 'scheduler_runs_insert_admin', 'INSERT', 'authenticated',
             NULL, 'public.is_org_admin(organization_id)'),
            ('scheduler_runs', 'scheduler_runs_update_admin', 'UPDATE', 'authenticated',
             'public.is_org_admin(organization_id)', 'public.is_org_admin(organization_id)'),
            ('scheduler_runs', 'scheduler_runs_delete_admin', 'DELETE', 'authenticated',
             'public.is_org_admin(organization_id)', NULL)
        ) AS s(tbl, pol, cmd, roles, using_expr, check_expr)
    LOOP
        v_ddl := format('ON public.%I FOR %s TO %s', v_spec.tbl, v_spec.cmd, v_spec.roles)
              -- `||`, not format(): format('%s', NULL) is '' and would emit `USING ()`.
              || COALESCE(' USING (' || v_spec.using_expr || ')', '')
              || COALESCE(' WITH CHECK (' || v_spec.check_expr || ')', '');

        SELECT permissive, cmd, roles, qual, with_check INTO v_have
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = v_spec.tbl AND policyname = v_spec.pol;

        IF NOT FOUND THEN
            EXECUTE format('CREATE POLICY %I ', v_spec.pol) || v_ddl;
            v_created := v_created || (v_spec.tbl || ': ' || v_spec.pol);
            CONTINUE;
        END IF;

        -- Same name already there: it must mean the same thing. Build the
        -- spec under a probe name, let Postgres deparse both, compare, drop.
        EXECUTE format('CREATE POLICY %I ', '__reconcile_prod_rls_drift_probe') || v_ddl;
        SELECT permissive, cmd, roles, qual, with_check INTO v_probe
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = v_spec.tbl
           AND policyname = '__reconcile_prod_rls_drift_probe';
        EXECUTE format('DROP POLICY %I ON public.%I', '__reconcile_prod_rls_drift_probe', v_spec.tbl);
        IF v_have IS DISTINCT FROM v_probe THEN
            RAISE EXCEPTION
                'reconcile_prod_rls_drift: public.% already has "%" but it differs from the repo definition (have: %, repo: %); refusing to call it reconciled',
                v_spec.tbl, v_spec.pol, v_have, v_probe;
        END IF;
        v_verified := v_verified || (v_spec.tbl || ': ' || v_spec.pol);
    END LOOP;

    -- 2. The dashboard-only broad member-write policy, wherever it exists.
    --    Found on a table the drift report did not name, it may be that
    --    table's only read path and nothing above replaces it -- so refuse
    --    rather than silently cut members off there.
    FOR v_pol IN
        SELECT schemaname, tablename
          FROM pg_policies
         WHERE policyname = 'Enforce Org Membership: ALL'
           AND NOT (schemaname = 'public' AND tablename = ANY (c_broad_tables))
    LOOP
        RAISE EXCEPTION
            'reconcile_prod_rls_drift: "Enforce Org Membership: ALL" is on %.%, which the drift report did not name and this migration restores no read policy for; refusing to drop it blind',
            v_pol.schemaname, v_pol.tablename;
    END LOOP;
    FOR v_pol IN
        SELECT schemaname, tablename, policyname
          FROM pg_policies
         WHERE policyname = 'Enforce Org Membership: ALL'
         ORDER BY schemaname, tablename
    LOOP
        EXECUTE format('DROP POLICY %I ON %I.%I', v_pol.policyname, v_pol.schemaname, v_pol.tablename);
        v_dropped := v_dropped || (v_pol.tablename || ': ' || v_pol.policyname);
    END LOOP;

    -- 3. The repo's own member-write hole, under its older name (header).
    FOR v_pol IN
        SELECT tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = ANY (c_member_write_tables)
           AND policyname = 'org_member_access'
         ORDER BY tablename
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', v_pol.policyname, v_pol.tablename);
        v_dropped := v_dropped || (v_pol.tablename || ': ' || v_pol.policyname);
    END LOOP;

    -- 3b. CHANGED (20261018030000): the repo policies this spec replaced, where
    --     they are still present -- scheduler_runs_write_admin (now split by
    --     command, created above if missing) and the legacy import_jobs
    --     SELECT (it repeats "Import Jobs: members access", ensured above).
    --     Left beside their replacements they are the advisors' findings
    --     again, under a "reconciled" notice.
    FOR v_pol IN
        SELECT tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND ((tablename = 'scheduler_runs' AND policyname = 'scheduler_runs_write_admin')
             OR (tablename = 'import_jobs' AND policyname = 'Users can view their organization''s import jobs'))
         ORDER BY tablename
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', v_pol.policyname, v_pol.tablename);
        v_dropped := v_dropped || (v_pol.tablename || ': ' || v_pol.policyname);
    END LOOP;

    -- 3c. CHANGED (20261021020000): the member-wide coaches read the spec
    --     above replaced. Re-added by drift, it would be ORed with the
    --     narrowed policy and every member would read every coach row again.
    FOR v_pol IN
        SELECT tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'coaches'
           AND policyname = 'Coaches: members access'
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', v_pol.policyname, v_pol.tablename);
        v_dropped := v_dropped || (v_pol.tablename || ': ' || v_pol.policyname);
    END LOOP;

    -- 4. Enforced, not declared: the end state is checked before commit,
    --    across EVERY table in `public` rather than a list. A write policy
    --    with any clause lacking an admin gate aborts here unless the
    --    allowlist names it -- so a member-write policy nobody reported fails
    --    loudly instead of surviving under a "reconciled" notice. Text-level;
    --    see 20260928000000_reconcile_prod_rls_drift.sql's header for what
    --    its smoke adds.
    FOR v_pol IN
        SELECT p.tablename, p.policyname
          FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.cmd <> 'SELECT'
           AND ((p.qual IS NOT NULL AND p.qual !~ '(is_org_admin\(|''admin''::text)')
             OR (p.with_check IS NOT NULL AND p.with_check !~ '(is_org_admin\(|''admin''::text)'))
           AND NOT EXISTS (SELECT 1 FROM public.rls_member_write_allowlist() a
                            WHERE a.tablename = p.tablename AND a.policyname = p.policyname)
    LOOP
        RAISE EXCEPTION
            'reconcile_prod_rls_drift: public.% still has write policy "%" that is not admin-gated; refusing to call it reconciled',
            v_pol.tablename, v_pol.policyname;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Enforce Org Membership: ALL') THEN
        RAISE EXCEPTION 'reconcile_prod_rls_drift: "Enforce Org Membership: ALL" survived its own drop';
    END IF;
    -- CHANGED (20261021020000): coaches has one read, the narrowed one.
    FOR v_pol IN
        SELECT policyname
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'coaches'
           AND permissive = 'PERMISSIVE' AND cmd IN ('SELECT', 'ALL')
           AND policyname <> 'coaches_select_admin_or_self'
    LOOP
        RAISE EXCEPTION
            'reconcile_prod_rls_drift: public.coaches still has read policy "%" beside coaches_select_admin_or_self; refusing to call it reconciled',
            v_pol.policyname;
    END LOOP;

    RETURN jsonb_build_object(
        'created', to_jsonb(v_created),
        'verified', to_jsonb(v_verified),
        'dropped', to_jsonb(v_dropped)
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.reconcile_prod_rls_drift() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_prod_rls_drift() TO service_role;
COMMENT ON FUNCTION public.reconcile_prod_rls_drift() IS 'Idempotent: creates the repo''s member/admin policies on the tables of migration 20260928000000 where missing (aborting on a same-named mismatch), drops "Enforce Org Membership: ALL" and "org_member_access" on practice_slots/field_subunits/scheduler_runs, then refuses any non-allowlisted non-admin write policy in public. Spec as of 20261022030000: scheduler_runs admin write split by command and the legacy import_jobs SELECT gone (20261018030000), coaches read by admins and the coach themselves (20261021020000), the team chat table dropped (20261022030000). Owner-only.';

COMMIT;
