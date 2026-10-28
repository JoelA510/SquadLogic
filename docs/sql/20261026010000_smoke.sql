-- Smoke checks for 20261026010000_natural_age_replaces_birthdates.sql
--
-- Run on the database built to head, so they hold for every later migration:
--   * the dropped columns stay dropped: no column named like a birth date or
--     `dob` on `players`, `coaches`, `staging_players` or
--     `staging_import_rows` (a catalogue scan, shown to fire on a planted
--     column first), and no `public` function body (comments and string
--     literals aside), view or policy names `date_of_birth` or `birth_year`
--     (shown to fire on a planted function and not on a literal);
--   * `players.natural_age` is a smallint whose check refuses 0 and 26;
--   * the SQL allowlist holds `natural_age` and no birth key;
--   * the finalizer, as an admin, on rows staged directly (as a caller who
--     bypasses import-validation could): the staged `natural_age` wins over
--     the age group, the age group stands in when there is none, a row with
--     neither (or a malformed one) is promoted with no natural age, a staged
--     birth date is stored nowhere; a re-import rewrites the natural age,
--     to nothing when the new row states none;
--   * the player writers refuse a patch naming `date_of_birth` 22023, alone
--     and in bulk;
--   * the posture of the replaced functions.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated, every email `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.r5_birth_columns() RETURNS text
LANGUAGE sql STABLE AS $f$
    SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname)
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('players', 'coaches', 'staging_players', 'staging_import_rows')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname ~* '(birth|dob)'
$f$;

CREATE FUNCTION pg_temp.r5_referrers() RETURNS text
LANGUAGE sql STABLE AS $f$
    SELECT string_agg(o, ', ' ORDER BY o) FROM (
        SELECT 'function ' || p.oid::regprocedure::text AS o
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '''[^'']*''', '', 'g')
               ~ '\m(date_of_birth|birth_year)\M'
        UNION ALL
        SELECT 'view ' || c.relname
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
           AND pg_get_viewdef(c.oid) ~ '\m(date_of_birth|birth_year)\M'
        UNION ALL
        SELECT format('policy %s on %s', policyname, tablename)
          FROM pg_policies
         WHERE schemaname = 'public'
           AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '\m(date_of_birth|birth_year)\M'
    ) s
$f$;

DO $$
DECLARE
    v_left text;
    v_refused integer := 0;
BEGIN
    -- Each scan must see a planted defect before its silence means anything.
    v_left := NULL;
    BEGIN
        ALTER TABLE public.staging_players ADD COLUMN __r5_dob date;
        CREATE FUNCTION public.__r5_smoke_probe() RETURNS integer
        LANGUAGE sql AS 'SELECT 1 AS birth_year';
        CREATE FUNCTION public.__r5_smoke_literal() RETURNS text
        LANGUAGE sql AS E'SELECT ''date_of_birth''::text -- birth_year\n';
        v_left := coalesce(pg_temp.r5_birth_columns(), '') || ' | ' || coalesce(pg_temp.r5_referrers(), '');
        RAISE EXCEPTION USING ERRCODE = 'P1026', MESSAGE = 'undo the planted probes';
    EXCEPTION WHEN SQLSTATE 'P1026' THEN NULL;
    END;
    IF v_left IS NULL OR v_left NOT LIKE '%staging_players.__r5_dob%'
       OR v_left NOT LIKE '%function __r5_smoke_probe()%' OR v_left LIKE '%__r5_smoke_literal%' THEN
        RAISE EXCEPTION 'control: the scans did not see a planted birth column and function, or counted a literal (found: %)',
            coalesce(v_left, 'nothing');
    END IF;
    v_left := pg_temp.r5_birth_columns();
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'objects 20261026010000 dropped are back: a people or staging table has a birth column: %', v_left;
    END IF;
    v_left := pg_temp.r5_referrers();
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'these still name a dropped birth column: %', v_left;
    END IF;
    RAISE NOTICE 'birth columns dropped: none on players, coaches or the two staging tables, and no function, view or policy names one (both scans shown to fire on a planted probe, not on a literal)';

    IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
         WHERE attrelid = 'public.players'::regclass AND attname = 'natural_age' AND NOT attisdropped)
       IS DISTINCT FROM 'smallint' THEN
        RAISE EXCEPTION 'players.natural_age is not a smallint';
    END IF;
    FOR v_left IN SELECT unnest(ARRAY['0', '26']) LOOP
        BEGIN
            INSERT INTO public.organizations (name, slug) VALUES ('R5 Check', 'r5-check');
            -- A player belongs to a season (20261108010000): the check below is the one that refuses.
            INSERT INTO public.season_settings (organization_id, name, status)
            SELECT id, 'R5 Check', 'active' FROM public.organizations WHERE slug = 'r5-check';
            INSERT INTO public.players (organization_id, first_name, last_name, natural_age)
            SELECT id, 'Check', 'Age', v_left::smallint FROM public.organizations WHERE slug = 'r5-check';
            RAISE EXCEPTION USING ERRCODE = 'P1027', MESSAGE = 'the check took ' || v_left;
        EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1;
        END;
    END LOOP;
    IF v_refused <> 2 THEN
        RAISE EXCEPTION 'the natural age check refused % of 0 and 26', v_refused;
    END IF;

    IF NOT ('natural_age' = ANY (public.import_allowed_keys('players')))
       OR public.import_allowed_keys('players') && ARRAY['date_of_birth', 'dob', 'birth_year'] THEN
        RAISE EXCEPTION 'the SQL allowlist is not natural_age without the birth keys: %',
            public.import_allowed_keys('players');
    END IF;
    RAISE NOTICE 'natural_age: a smallint refusing 0 and 26; the SQL allowlist holds it and no birth key';
END;
$$;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_job1 uuid := gen_random_uuid();
    v_job2 uuid := gen_random_uuid();
    v_result jsonb;
    v_ages text;
    v_text text;
    v_p uuid;
    v_denied integer := 0;
    v_base jsonb := '{"last_name": "Rfive", "gender": "F"}'::jsonb;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'r5-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'r5-admin@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org R5', 'smoke-org-r5')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status)
        VALUES (v_org, 'R5 Season', 'active');
    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by) VALUES
        (v_job1, v_org, 'registration', 'smoke/r5-1.csv', 'processing', v_admin),
        (v_job2, v_org, 'registration', 'smoke/r5-2.csv', 'processing', v_admin);
    INSERT INTO public.staging_players
        (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
        (v_org, v_job1, 1, '{}'::jsonb, v_base || '{"first_name": "Ana", "external_registration_id": "R5-A",
             "natural_age": "10", "age group": "9", "date_of_birth": "2014-06-07", "birth_year": "2014"}'::jsonb),
        (v_org, v_job1, 2, '{}'::jsonb, v_base || '{"first_name": "Bea", "external_registration_id": "R5-B",
             "age_group": "9"}'::jsonb),
        (v_org, v_job1, 3, '{}'::jsonb, v_base || '{"first_name": "Cy", "external_registration_id": "R5-C"}'::jsonb),
        (v_org, v_job1, 4, '{}'::jsonb, v_base || '{"first_name": "Di", "external_registration_id": "R5-D",
             "natural_age": "30", "age": "U9"}'::jsonb),
        (v_org, v_job2, 1, '{}'::jsonb, v_base || '{"first_name": "Ana", "external_registration_id": "R5-A",
             "natural_age": "11"}'::jsonb),
        (v_org, v_job2, 2, '{}'::jsonb, v_base || '{"first_name": "Bea", "external_registration_id": "R5-B"}'::jsonb);

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    v_result := public.finalize_import_job(v_job1);
    IF (v_result->>'inserted_players')::int <> 4 OR (v_result->>'promoted_rows')::int <> 4 THEN
        RAISE EXCEPTION 'the finalizer did not promote and insert all 4 rows, birth date or none: %', v_result;
    END IF;
    SELECT string_agg(first_name || ':' || coalesce(natural_age::text, '-'), ',' ORDER BY first_name)
      INTO v_ages FROM public.players WHERE organization_id = v_org;
    IF v_ages IS DISTINCT FROM 'Ana:10,Bea:9,Cy:-,Di:-' THEN
        RAISE EXCEPTION 'the stored natural ages are not the staged one, else the age group, else none: %', v_ages;
    END IF;
    SELECT string_agg(to_jsonb(p)::text, '') INTO v_text FROM public.players p WHERE organization_id = v_org;
    IF strpos(v_text, '2014-06-07') > 0
       OR EXISTS (SELECT 1 FROM public.players p, jsonb_object_keys(p.custom_attributes) k
                   WHERE p.organization_id = v_org AND k ~* '(birth|dob)') THEN
        RAISE EXCEPTION 'a staged birth date or year was stored on a player: %', v_text;
    END IF;
    RAISE NOTICE 'finalize: 4 of 4 promoted; natural ages Ana 10 (staged, over age group 9), Bea 9 (age group), Cy none, Di none (malformed); the staged birth date and year stored nowhere';

    v_result := public.finalize_import_job(v_job2);
    IF (v_result->>'updated_players')::int <> 2 THEN
        RAISE EXCEPTION 'the re-import did not update its 2 players: %', v_result;
    END IF;
    SELECT string_agg(first_name || ':' || coalesce(natural_age::text, '-'), ',' ORDER BY first_name)
      INTO v_ages FROM public.players WHERE organization_id = v_org AND first_name IN ('Ana', 'Bea');
    IF v_ages IS DISTINCT FROM 'Ana:11,Bea:-' THEN
        RAISE EXCEPTION 'a re-import did not rewrite the natural age as the birth date was: %', v_ages;
    END IF;
    RAISE NOTICE 'finalize re-import: the natural age is rewritten (Ana 11), and a row stating none leaves none (Bea), as the birth date was';

    SELECT id INTO v_p FROM public.players WHERE organization_id = v_org AND first_name = 'Ana';
    SET LOCAL ROLE authenticated;
    BEGIN
        PERFORM public.admin_update_player(v_p, '{"date_of_birth": "2014-06-07"}');
    EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
    END;
    BEGIN
        PERFORM public.admin_bulk_update_players(ARRAY[v_p], '{"date_of_birth": "2014-06-07"}');
    EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
    END;
    BEGIN
        PERFORM public.admin_update_player(v_p, '{"natural_age": 12}');
    EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
    END;
    PERFORM public.admin_update_player(v_p, '{"jersey_number": 4}');
    RESET ROLE;
    IF v_denied <> 3 THEN
        RAISE EXCEPTION 'only % of 3 patches naming date_of_birth or natural_age were refused 22023', v_denied;
    END IF;
    IF (SELECT jersey_number FROM public.players WHERE id = v_p) IS DISTINCT FROM 4::smallint THEN
        RAISE EXCEPTION 'the player writers no longer patch a player';
    END IF;
    RAISE NOTICE 'player writers: patches naming date_of_birth (alone and in bulk) or natural_age refused 22023; a jersey number still patched';
END;
$$;

DO $$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(f, ', ') INTO v_left FROM unnest(ARRAY[
        'public.admin_bulk_update_players(uuid[], jsonb)', 'public.finalize_import_job(uuid, jsonb)'
    ]) f
     WHERE NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid = to_regprocedure(f) AND p.prosecdef
            AND p.proconfig @> ARRAY['search_path=public']
            AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'));
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'posture changed (want SECURITY DEFINER, search_path=public, authenticated not anon): %', v_left;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.apply_player_patch(uuid, jsonb)'::regprocedure
                    AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC'])
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.finalize_import_job(uuid, jsonb)'::regprocedure
                       AND p.proconfig @> ARRAY['TimeZone=UTC'])
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.sanitize_player_patch(jsonb)'::regprocedure
                       AND p.provolatile = 'i' AND p.proconfig = ARRAY['search_path=public'])
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.import_allowed_keys(text)'::regprocedure
                       AND p.provolatile = 'i' AND p.proconfig = ARRAY['search_path=public']
                       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
        RAISE EXCEPTION 'posture changed on the patch helpers, the finalizer''s timezone or the allowlist';
    END IF;
    RAISE NOTICE 'posture: admin_bulk_update_players and finalize_import_job SECURITY DEFINER, search_path=public, EXECUTE for authenticated and not anon; the patch helpers and the finalizer keep their SET clauses; the allowlist callable by no client role';
END;
$$;

ROLLBACK;
