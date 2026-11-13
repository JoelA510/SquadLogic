-- Revert for 20261124010000_settings_scope.sql
--
-- Takes the settings cascade out: gives `standings_counts_outside` and `admin_create_season_from` back the bodies they had
-- before 20261124010000, writes each organization's standings value back into `organizations.feature_flags`, and drops
-- `admin_set_scoped_setting`, `admin_set_division_practice_settings`, `scoped_setting_value`, `scoped_settings` and
-- `scoped_setting_keys`. **Those bodies are the repository's, not read from production**: the end of this file checks
-- each restored body against the md5 the forward migration's guard was written against (carriage returns removed), so a
-- typo here fails the revert instead of shipping.
--
-- **What it keeps:** the organization level. For every organization, `feature_flags.standings_count_outside_results`
-- becomes exactly its organization row's value, and the key is removed where the organization has no row (an admin
-- unset it, or it never had one), so org_flag answers what the resolver answered at the organization level.
--
-- **What it loses, said by count:** every program's and every division's own value (the old code has no place for
-- them; they stay readable in the audit trail, one settings.updated row per change), the rows that held a completed
-- season at its value among them, so after the revert a completed season follows the organization's flag again. A NOTICE names how many. The
-- practice import, if it already calls `admin_set_division_practice_settings`, fails until the client before F11-4b is
-- deployed again; so does the Settings panel F11-4b added ("Settings by program and division", which reads
-- `scoped_settings`): revert F11-4b's commit first.
--
-- Order matters: the seam goes back to org_flag before the resolver it calls is dropped.
--
-- Verified: the harness applies this on a database built up to the migration, with a program value, a division value
-- and two organization values planted, and reads feature_flags and the catalogue afterwards.

BEGIN;

DO $revert$
DECLARE
    v_dropped integer;
BEGIN
    SELECT count(*) INTO v_dropped FROM public.scoped_settings WHERE program_id IS NOT NULL OR division_id IS NOT NULL;

    -- The organization level goes back where org_flag reads it: set where a row exists, removed where none does.
    UPDATE public.organizations o
       SET feature_flags = COALESCE(o.feature_flags, '{}'::jsonb)
                           || jsonb_build_object('standings_count_outside_results', s.value)
      FROM public.scoped_settings s
     WHERE s.organization_id = o.id AND s.program_id IS NULL AND s.division_id IS NULL
       AND s.key = 'standings_count_outside_results';
    UPDATE public.organizations o
       SET feature_flags = o.feature_flags - 'standings_count_outside_results'
     WHERE o.feature_flags ? 'standings_count_outside_results'
       AND NOT EXISTS (SELECT 1 FROM public.scoped_settings s
                        WHERE s.organization_id = o.id AND s.program_id IS NULL AND s.division_id IS NULL
                          AND s.key = 'standings_count_outside_results');

    RAISE NOTICE 'settings scope revert: % program or division value(s) dropped (the organization values are back in feature_flags)', v_dropped;
END;
$revert$;

-- public.standings_counts_outside(uuid): the body it had before 20261124010000.
CREATE OR REPLACE FUNCTION public.standings_counts_outside(p_division_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE((SELECT public.org_flag(d.organization_id, 'standings_count_outside_results', false)
                       FROM public.divisions d
                      WHERE d.id = p_division_id
                        AND public.is_org_member(d.organization_id)), false)
$$;

COMMENT ON FUNCTION public.standings_counts_outside(uuid) IS
    'Whether a division''s standings count its teams'' results against outside clubs (teams.is_external). Today the organization''s standings_count_outside_results setting, false unless set; the program and division levels (F11-4) replace this one body. It runs with its owner''s rights because view_league_standings calls it as its reader and org_flag is closed to client roles; it answers false for a division of an organization the caller is not a member of. 20261122010000.';

-- public.admin_create_season_from(uuid, text, integer, date, date): the body it had before 20261124010000.
CREATE OR REPLACE FUNCTION public.admin_create_season_from(
    p_source_season_id uuid,
    p_name text,
    p_season_year integer,
    p_season_start date DEFAULT NULL,
    p_season_end date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_name text := btrim(COALESCE(p_name, ''));
    v_org uuid;
    v_source public.season_settings%ROWTYPE;
    v_new_id uuid;
    v_shift integer;
    v_season_cols text;
    v_division_cols text;
    v_division_exprs text;
    v_programs integer := 0;
    v_divisions integer := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_source_season_id IS NULL THEN
        RAISE EXCEPTION 'p_source_season_id is required' USING ERRCODE = '23502';
    END IF;

    SELECT s.organization_id INTO v_org FROM public.season_settings s WHERE s.id = p_source_season_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the season''s organization'
            USING ERRCODE = '42501';
    END IF;

    -- The organization's season lock, then every season of it, so two admins at once are
    -- serialised and the source cannot change under the copy.
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    PERFORM 1 FROM public.season_settings s WHERE s.organization_id = v_org ORDER BY s.id FOR UPDATE;

    SELECT * INTO v_source FROM public.season_settings s WHERE s.id = p_source_season_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'season % no longer exists', p_source_season_id USING ERRCODE = '42501';
    END IF;

    IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'a season name must be 1 to 80 characters' USING ERRCODE = '22023';
    END IF;
    IF p_season_year IS NULL OR p_season_year NOT BETWEEN 2000 AND 2100 THEN
        RAISE EXCEPTION 'the season year (the year the season starts) must be between 2000 and 2100'
            USING ERRCODE = '22023', DETAIL = 'season_year_invalid';
    END IF;
    IF p_season_start IS NOT NULL AND p_season_end IS NOT NULL AND p_season_end < p_season_start THEN
        RAISE EXCEPTION 'the season cannot end before it starts' USING ERRCODE = '22023', DETAIL = 'season_dates_invalid';
    END IF;

    -- Decision 4: a division's birth-date window moves with the season year (one year for
    -- the next season). A source with no year moves it one year.
    v_shift := COALESCE(p_season_year - v_source.season_year, 1);

    -- The season: the catalogue's columns copied, the rest the new season's own. A draft.
    SELECT string_agg(quote_ident(c), ', ') INTO v_season_cols
      FROM unnest(public.rollover_season_columns()) AS c;
    BEGIN
        EXECUTE format(
            'INSERT INTO public.season_settings (organization_id, name, status, season_year, season_start, season_end, %s) '
            'SELECT s.organization_id, $2, ''draft'', $3, $4, $5, %s FROM public.season_settings s WHERE s.id = $1 '
            'RETURNING id',
            v_season_cols,
            (SELECT string_agg('s.' || quote_ident(c), ', ') FROM unnest(public.rollover_season_columns()) AS c))
        INTO v_new_id
        USING p_source_season_id, v_name, p_season_year, p_season_start, p_season_end;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'a season named "%" already exists', v_name USING ERRCODE = '23505';
    END;

    -- Programs: the source's own (non-default) programs, linked by copied_from_program_id; the
    -- new season's trigger-made default is the source default's copy.
    INSERT INTO public.programs (organization_id, season_settings_id, name, copied_from_program_id)
    SELECT p.organization_id, v_new_id, p.name, p.id
      FROM public.programs p
     WHERE p.season_settings_id = p_source_season_id AND NOT p.is_default;
    GET DIAGNOSTICS v_programs = ROW_COUNT;
    UPDATE public.programs np
       SET copied_from_program_id = sp.id
      FROM public.programs sp
     WHERE np.season_settings_id = v_new_id AND np.is_default
       AND sp.season_settings_id = p_source_season_id AND sp.is_default;

    -- Divisions: every catalogue column, a window shifted, each in the copy of its program.
    SELECT string_agg(quote_ident(c), ', ') INTO v_division_cols
      FROM unnest(public.rollover_division_columns()) AS c;
    SELECT string_agg(
               CASE WHEN c IN ('birthdate_start', 'birthdate_end')
                    THEN format('(d.%I + make_interval(years => $3))::date', c)
                    ELSE format('d.%I', c) END, ', ')
      INTO v_division_exprs
      FROM unnest(public.rollover_division_columns()) AS c;
    EXECUTE format(
        'INSERT INTO public.divisions (season_settings_id, program_id, %s) '
        'SELECT $2, np.id, %s FROM public.divisions d '
        'JOIN public.programs sp ON sp.id = d.program_id '
        'JOIN public.programs np ON np.season_settings_id = $2 AND np.copied_from_program_id = sp.id '
        'WHERE d.season_settings_id = $1',
        v_division_cols, v_division_exprs)
    USING p_source_season_id, v_new_id, v_shift;
    GET DIAGNOSTICS v_divisions = ROW_COUNT;

    -- A division the join dropped would be silently lost: the copy must be whole.
    IF v_divisions <> (SELECT count(*) FROM public.divisions d WHERE d.season_settings_id = p_source_season_id) THEN
        RAISE EXCEPTION 'season % was not copied whole: % of its divisions found a program', p_source_season_id, v_divisions
            USING ERRCODE = 'XX000';
    END IF;

    PERFORM public.record_audit_event(
        v_org,
        'season.created_from',
        'season_settings',
        v_new_id,
        jsonb_build_object(
            'source_season_id', p_source_season_id,
            'name', v_name,
            'season_year', p_season_year,
            'divisions_copied', v_divisions,
            'programs_copied', v_programs,
            'window_shift_years', v_shift
        )
    );

    RETURN jsonb_build_object(
        'id', v_new_id,
        'organization_id', v_org,
        'name', v_name,
        'status', 'draft',
        'season_year', p_season_year,
        'source_season_id', p_source_season_id,
        'divisions_copied', v_divisions,
        'programs_copied', v_programs
    );
END;
$$;
COMMENT ON FUNCTION public.admin_create_season_from(uuid, text, integer, date, date) IS
    'Admin-only: a new draft season from any season of the organization: its divisions (every column of rollover_division_columns(), birth-date windows shifted by the difference in season years) and programs, and no player, coach or team; season settings from rollover_season_columns(). Takes the organization''s season lock. Audited as season.created_from. 20261111010000.';

DROP FUNCTION public.admin_set_scoped_setting(text, text, uuid, jsonb);
DROP FUNCTION public.admin_set_division_practice_settings(uuid, integer, integer);
DROP FUNCTION public.scoped_setting_value(uuid, text);
DROP TABLE public.scoped_settings;
DROP FUNCTION public.scoped_settings_enforce_tenancy();
DROP TABLE public.scoped_setting_keys;

-- The restored bodies are the ones the forward migration replaced, or nothing commits.
DO $check$
DECLARE
    v_spec record;
    v_md5 text;
BEGIN
    FOR v_spec IN
        SELECT * FROM (VALUES
            ('public.standings_counts_outside(uuid)', '599e5e168256adcd6ff7e67ef4de6594'),
            ('public.admin_create_season_from(uuid, text, integer, date, date)', '446991cc4145987cad805bd47cc865b4')
        ) AS s(signature, expected_md5)
    LOOP
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure(v_spec.signature);
        IF v_md5 IS DISTINCT FROM v_spec.expected_md5 THEN
            RAISE EXCEPTION 'revert: % is not the body it had before 20261124010000 (md5 %)', v_spec.signature, v_md5;
        END IF;
    END LOOP;
    IF to_regclass('public.scoped_settings') IS NOT NULL OR to_regclass('public.scoped_setting_keys') IS NOT NULL
       OR to_regprocedure('public.scoped_setting_value(uuid,text)') IS NOT NULL
       OR to_regprocedure('public.admin_set_scoped_setting(text,text,uuid,jsonb)') IS NOT NULL
       OR to_regprocedure('public.admin_set_division_practice_settings(uuid,integer,integer)') IS NOT NULL
       OR to_regprocedure('public.scoped_settings_enforce_tenancy()') IS NOT NULL THEN
        RAISE EXCEPTION 'revert: an object of 20261124010000 is still there';
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.standings_counts_outside(uuid)'))
       OR NOT has_function_privilege('authenticated', 'public.standings_counts_outside(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'revert: standings_counts_outside lost its rights or its grant';
    END IF;
END;
$check$;

COMMIT;
