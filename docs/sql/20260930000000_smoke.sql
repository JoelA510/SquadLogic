-- Smoke checks for 20260930000000_location_coordinates.sql
--
-- Assertions RAISE; the NOTICEs are evidence of what each one examined, and
-- `scripts/dbharness/run.sh` turns seven of them into (checked) claims, each
-- proven by a plant in `scripts/dbharness/prove.sh` (plan §4 W14).
-- `prelude.sql` stubs `auth.uid()` from `request.jwt.claim.sub`, so the RPC
-- runs as a real admin, a real coach and another organisation's real admin.
--
-- **Every coordinate here is synthetic** (40.00/-75.00, 41.50/-73.50 and
-- values built from them). No venue's real position is in this file.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The columns, the CHECKs and the writer, read from the catalogue
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_cols int;
    v_checks int;
    v_write text[];
    v_select int;
    v_definer int;
BEGIN
    SELECT count(*) INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'locations'
       AND ((column_name IN ('latitude', 'longitude')
             AND data_type = 'numeric' AND numeric_precision = 7 AND numeric_scale = 4
             AND is_nullable = 'YES')
            OR (column_name = 'coordinates_set_at' AND data_type = 'timestamp with time zone')
            OR (column_name = 'coordinates_set_by' AND data_type = 'uuid'));
    IF v_cols <> 4 THEN
        RAISE EXCEPTION 'expected latitude/longitude numeric(7,4) nullable, coordinates_set_at timestamptz and coordinates_set_by uuid; found % of 4', v_cols;
    END IF;

    SELECT count(*) INTO v_checks
      FROM pg_constraint
     WHERE conrelid = 'public.locations'::regclass AND contype = 'c'
       AND conname IN ('locations_coordinates_both_or_neither', 'locations_coordinates_in_range');
    IF v_checks <> 2 THEN
        RAISE EXCEPTION 'expected the both-or-neither and range CHECKs on locations; found % of 2', v_checks;
    END IF;

    -- No new policy: still one SELECT policy and no write policy, so the RPC
    -- is the only client writer.
    SELECT array_agg(polname ORDER BY polname) INTO v_write
      FROM pg_policy WHERE polrelid = 'public.locations'::regclass AND polcmd <> 'r';
    IF v_write IS NOT NULL THEN
        RAISE EXCEPTION 'locations carries write policies %; its coordinate writer is the definer RPC', v_write;
    END IF;
    SELECT count(*) INTO v_select
      FROM pg_policy WHERE polrelid = 'public.locations'::regclass AND polcmd = 'r';
    IF v_select <> 1 THEN
        RAISE EXCEPTION 'expected exactly one SELECT policy on locations, found %', v_select;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'location.coordinates_set') THEN
        RAISE EXCEPTION 'the location.coordinates_set audit action is not registered';
    END IF;

    SELECT count(*) INTO v_definer
      FROM pg_proc p
     WHERE p.oid = 'public.admin_set_location_coordinates(uuid, numeric, numeric)'::regprocedure
       AND p.prosecdef
       AND 'search_path=public' = ANY (p.proconfig)
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_definer <> 1 THEN
        RAISE EXCEPTION 'admin_set_location_coordinates is not a definer RPC with a pinned search_path, executable by authenticated and not anon';
    END IF;

    RAISE NOTICE 'coordinates store: 4 columns (latitude/longitude numeric(7,4) nullable, set_at, set_by); 2 CHECKs; locations still 1 SELECT policy and 0 write policies; audit action registered; RPC definer, search_path pinned, authenticated yes, anon no';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The writer, as an admin, a coach and another organisation's admin
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_coach uuid := gen_random_uuid();
    v_outsider uuid := gen_random_uuid();
    v_org uuid;
    v_other_org uuid;
    v_loc uuid;
    v_other_loc uuid;
    v_res jsonb;
    v_code text;
    v_refused int;
    v_row public.locations%ROWTYPE;
    v_audit public.audit_log%ROWTYPE;
    v_n int;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'coord-admin@example.test', '{"password_length": 16}'),
        (v_coach, 'coord-coach@example.test', '{"password_length": 16}'),
        (v_outsider, 'coord-outsider@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'coord-admin@example.test'), (v_coach, 'coord-coach@example.test'),
        (v_outsider, 'coord-outsider@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 8.9 PR3', 'smoke-org-89-pr3')
        RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 8.9 PR3 other', 'smoke-org-89-pr3-other')
        RETURNING id INTO v_other_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_coach, 'coach'), (v_other_org, v_outsider, 'admin');
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Coordinate Park')
        RETURNING id INTO v_loc;
    INSERT INTO public.locations (organization_id, name) VALUES (v_other_org, 'Elsewhere Park')
        RETURNING id INTO v_other_loc;

    -- ---- (a) the admin sets a pair; it is rounded to 2 decimals -----------
    -- 40.1250 and -75.1250 sit exactly on the half: round() gives 40.13 and
    -- -75.13, while an unrounded write keeps all four decimals.
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_res := public.admin_set_location_coordinates(v_loc, 40.1250, -75.1250);
    SELECT * INTO v_row FROM public.locations WHERE id = v_loc;
    IF v_row.latitude IS DISTINCT FROM 40.13 OR v_row.longitude IS DISTINCT FROM -75.13
       OR v_row.latitude::text <> '40.1300' OR v_row.longitude::text <> '-75.1300' THEN
        RAISE EXCEPTION '(a) 40.1250/-75.1250 was stored as %/%, not rounded to 40.13/-75.13', v_row.latitude, v_row.longitude;
    END IF;
    IF v_row.coordinates_set_by IS DISTINCT FROM v_admin OR v_row.coordinates_set_at IS NULL
       OR (v_res->>'latitude')::numeric <> 40.13 THEN
        RAISE EXCEPTION '(a) the write did not record its author and time, or returned %', v_res;
    END IF;
    RAISE NOTICE 'coordinates: 40.1250/-75.1250 stored as 40.1300/-75.1300 -- rounded to 2 decimals, set_by the admin';

    -- ---- (b) a coach and another organisation's admin are refused ---------
    v_refused := 0;
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
    BEGIN
        PERFORM public.admin_set_location_coordinates(v_loc, 41.50, -73.50);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
    END;
    PERFORM set_config('request.jwt.claim.sub', v_outsider::text, true);
    BEGIN
        PERFORM public.admin_set_location_coordinates(v_loc, 41.50, -73.50);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
    END;
    SELECT * INTO v_row FROM public.locations WHERE id = v_loc;
    IF v_refused <> 2 OR v_row.latitude <> 40.13 OR v_row.longitude <> -75.13 THEN
        RAISE EXCEPTION '(b) % of 2 foreign callers refused; the pair is now %/%', v_refused, v_row.latitude, v_row.longitude;
    END IF;
    -- The positive control for (b): the outsider IS an admin, of their own
    -- organisation's venue, so the refusal above is about the location's org.
    PERFORM public.admin_set_location_coordinates(v_other_loc, 41.50, -73.50);
    IF (SELECT latitude FROM public.locations WHERE id = v_other_loc) IS DISTINCT FROM 41.50 THEN
        RAISE EXCEPTION '(b) the other organisation''s admin could not set their own venue';
    END IF;
    RAISE NOTICE 'coordinates: a coach and another organisation''s admin were each refused 42501, 2 of 2, and the pair is unchanged; that admin set their own venue';

    -- ---- (c) a half pair is refused, by the RPC and by the table ----------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_refused := 0;
    BEGIN PERFORM public.admin_set_location_coordinates(v_loc, 41.50, NULL);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1; END;
    BEGIN PERFORM public.admin_set_location_coordinates(v_loc, NULL, -73.50);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1; END;
    IF v_refused <> 2 THEN
        RAISE EXCEPTION '(c) only % of 2 half pairs were refused 22023 by the RPC', v_refused;
    END IF;
    RAISE NOTICE 'coordinates: the RPC refused both half pairs 22023, 2 of 2';
    -- A table-owner write bypasses the RPC; the CHECK is what refuses it.
    v_refused := 0;
    BEGIN UPDATE public.locations SET longitude = NULL WHERE id = v_loc;
    EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1; END;
    BEGIN UPDATE public.locations SET latitude = NULL WHERE id = v_loc;
    EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1; END;
    IF v_refused <> 2 THEN
        RAISE EXCEPTION '(c) only % of 2 half-pair owner writes were refused by the both-or-neither CHECK', v_refused;
    END IF;
    RAISE NOTICE 'coordinates: the both-or-neither CHECK refused both half-pair owner writes 23514, 2 of 2';

    -- ---- (d) out of range is refused, by the RPC and by the table ---------
    v_refused := 0;
    BEGIN PERFORM public.admin_set_location_coordinates(v_loc, 90.01, -75.00);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1; END;
    BEGIN PERFORM public.admin_set_location_coordinates(v_loc, -90.01, -75.00);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1; END;
    BEGIN PERFORM public.admin_set_location_coordinates(v_loc, 40.00, 180.01);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1; END;
    BEGIN PERFORM public.admin_set_location_coordinates(v_loc, 40.00, -180.01);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1; END;
    -- Checked as given, before rounding: 90.004 would round to 90.00.
    BEGIN PERFORM public.admin_set_location_coordinates(v_loc, 90.004, -75.00);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1; END;
    BEGIN PERFORM public.admin_set_location_coordinates(v_loc, 'NaN'::numeric, -75.00);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1; END;
    IF v_refused <> 6 THEN
        RAISE EXCEPTION '(d) only % of 6 out-of-range pairs were refused 22023 by the RPC', v_refused;
    END IF;
    RAISE NOTICE 'coordinates: the RPC refused 6 of 6 out-of-range pairs 22023 (lat 90.01, -90.01, 90.004 and NaN; long 180.01, -180.01)';
    v_refused := 0;
    BEGIN UPDATE public.locations SET latitude = 90.01 WHERE id = v_loc;
    EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1; END;
    BEGIN UPDATE public.locations SET longitude = -180.01 WHERE id = v_loc;
    EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1; END;
    IF v_refused <> 2 THEN
        RAISE EXCEPTION '(d) only % of 2 out-of-range owner writes were refused by the range CHECK', v_refused;
    END IF;
    RAISE NOTICE 'coordinates: the range CHECK refused both out-of-range owner writes 23514, 2 of 2';
    -- The positive control: the four boundaries are accepted, so neither the
    -- RPC nor the CHECK refuses everything.
    PERFORM public.admin_set_location_coordinates(v_loc, 90, 180);
    PERFORM public.admin_set_location_coordinates(v_loc, -90, -180);
    SELECT * INTO v_row FROM public.locations WHERE id = v_loc;
    IF v_row.latitude <> -90 OR v_row.longitude <> -180 THEN
        RAISE EXCEPTION '(d) the boundary pair -90/-180 was not stored: %/%', v_row.latitude, v_row.longitude;
    END IF;
    RAISE NOTICE 'coordinates: the boundaries 90/180 and -90/-180 were accepted';

    -- ---- (e) clearing: NULL, NULL empties the pair --------------------------
    v_res := public.admin_set_location_coordinates(v_loc, NULL, NULL);
    SELECT * INTO v_row FROM public.locations WHERE id = v_loc;
    IF v_row.latitude IS NOT NULL OR v_row.longitude IS NOT NULL THEN
        RAISE EXCEPTION '(e) NULL, NULL left %/%', v_row.latitude, v_row.longitude;
    END IF;
    RAISE NOTICE 'coordinates: NULL, NULL cleared the pair';

    -- ---- (f) every accepted write is audited with before and after --------
    -- The subject set is the list of accepted calls above, in order, not the
    -- audit log: (a) the set, the two boundary writes, the clear.
    SELECT count(*) INTO v_n FROM public.audit_log
     WHERE organization_id = v_org AND resource_id = v_loc AND action = 'location.coordinates_set';
    IF v_n <> 4 THEN
        RAISE EXCEPTION '(f) expected 4 location.coordinates_set rows for the venue (set, two boundaries, clear), found %', v_n;
    END IF;
    SELECT * INTO v_audit FROM public.audit_log
     WHERE resource_id = v_loc AND action = 'location.coordinates_set'
       AND metadata->>'operation' = 'set'
       AND metadata->'after' = jsonb_build_object('latitude', 40.13, 'longitude', -75.13);
    IF NOT FOUND OR v_audit.user_id IS DISTINCT FROM v_admin
       OR v_audit.resource_type <> 'location'
       OR v_audit.metadata->'before' <> jsonb_build_object('latitude', NULL, 'longitude', NULL) THEN
        RAISE EXCEPTION '(f) the first write''s audit row is missing or lacks its before (NULL) / after (40.13, -75.13)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_log
                    WHERE resource_id = v_loc AND action = 'location.coordinates_set'
                      AND metadata->>'operation' = 'cleared'
                      AND metadata->'before' = jsonb_build_object('latitude', -90, 'longitude', -180)
                      AND metadata->'after' = jsonb_build_object('latitude', NULL, 'longitude', NULL)) THEN
        RAISE EXCEPTION '(f) the clear''s audit row is missing or lacks its before (-90, -180) / after (NULL)';
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_log
     WHERE organization_id = v_other_org AND resource_id = v_other_loc AND action = 'location.coordinates_set';
    IF v_n <> 1 THEN
        RAISE EXCEPTION '(f) the other organisation''s own write left % audit rows, expected 1', v_n;
    END IF;
    RAISE NOTICE 'coordinates: every accepted write audited -- 4 of 4 on the venue, the first with before NULL/NULL and after 40.13/-75.13, the clear with before -90/-180 and after NULL/NULL';

    -- ---- (g) no direct client write: RLS leaves the RPC the only writer ---
    -- Either refusal counts: no UPDATE grant (42501), or RLS matching 0 rows.
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    BEGIN
        UPDATE public.locations SET latitude = 41.50, longitude = -73.50 WHERE id = v_loc;
        GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN insufficient_privilege THEN v_n := 0;
    END;
    SELECT count(*) INTO v_refused FROM public.locations WHERE id = v_loc;
    RESET ROLE;
    IF v_n <> 0 OR v_refused <> 1
       OR (SELECT latitude FROM public.locations WHERE id = v_loc) IS NOT NULL THEN
        RAISE EXCEPTION '(g) a direct authenticated UPDATE reached % row(s) (the admin reads % row)', v_n, v_refused;
    END IF;
    RAISE NOTICE 'coordinates: a direct UPDATE by the admin as authenticated wrote nothing, on the 1 row it can read';
END;
$$;

ROLLBACK;
