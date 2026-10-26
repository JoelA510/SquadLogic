-- Smoke checks for 20261030010000_demo_sessions.sql
--
-- Run on the database built to head, so they hold for every later migration:
--   * posture: the demo RPCs, the helpers and the fence functions are definers pinned to search_path
--     public and closed to `anon`; the purge and the health read are the service role's alone; the
--     retention sweeps are no signed-in caller's; `demo_seed` is closed to every client role; the
--     purge is scheduled every ten minutes; the league in `demo_seed` is whole;
--   * the copy: an anonymous visitor's `start_demo_session` makes an organization holding every seeded
--     player, team, coach and slot, flagged a demo and expiring in 30 minutes, the visitor its admin,
--     one `demo.started` row; a second call returns it;
--   * the fences: a visitor's membership of a REAL organization is refused (and the same insert passes
--     without the anonymous claim); a demo player's name cannot change and a team move can; no import
--     job can be created for a demo;
--   * expiry: a member of a demo is a member and an admin until it expires, and neither after;
--   * the purge: it deletes the expired demo and its visitor, and leaves a real organization with its
--     members, and a live demo;
--   * the races, with `dblink` (the pattern of 20261021030000's smoke): while one visitor's start is
--     open, a second start by the same visitor waits on the lock (55P03 under a 1-second lock timeout)
--     and, once the first commits, returns the same organization; with nine live demos, a start by one
--     visitor holds the lock and a start by another waits, and once the first commits the second is
--     refused at the cap, so the live count is ten and never eleven.
--
-- The races commit; they and everything they made are removed at the end. The rest is wrapped in
-- BEGIN ... ROLLBACK. Every id is generated, every name synthetic; there is no PII.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Posture.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('start_demo_session', 'purge_expired_demos', 'demo_health', 'is_demo_org',
                         'caller_is_anonymous', 'is_org_member', 'is_org_admin', 'demo_fence_player_write',
                         'demo_fence_coach_write', 'demo_fence_import_write', 'demo_fence_membership',
                         'demo_fence_invite')
       AND NOT (p.prosecdef = (p.proname <> 'caller_is_anonymous')
                AND 'search_path=public' = ANY (p.proconfig)
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'));
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'not a pinned function closed to anon: %', v_left;
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.start_demo_session()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.purge_expired_demos()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.demo_health()', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.purge_expired_demos()', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.demo_health()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.caller_is_anonymous()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.demo_fence_membership()', 'EXECUTE') THEN
        RAISE EXCEPTION 'the demo functions have the wrong client grants';
    END IF;
    IF has_function_privilege('authenticated', 'public.prune_old_audit_logs()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.prune_old_evaluation_runs()', 'EXECUTE') THEN
        RAISE EXCEPTION 'a retention sweep is callable by a signed-in user';
    END IF;
    IF has_schema_privilege('anon', 'demo_seed', 'USAGE') OR has_schema_privilege('authenticated', 'demo_seed', 'USAGE')
       OR EXISTS (SELECT 1 FROM information_schema.table_privileges
                   WHERE table_schema = 'demo_seed' AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
        RAISE EXCEPTION 'demo_seed is open to a client role';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-expired-demos' AND schedule = '*/10 * * * *') THEN
        RAISE EXCEPTION 'the purge is not scheduled every ten minutes';
    END IF;
    IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'demo\_fence\_%') <> 7
       OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'organizations_guard_demo_columns') THEN
        RAISE EXCEPTION 'a demo fence trigger is missing';
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage'
           AND policyname IN ('exports org-admin insert', 'raw-imports org-member insert')
           AND with_check LIKE '%is_demo_org%') <> 2 THEN
        RAISE EXCEPTION 'a bucket insert policy does not ask is_demo_org';
    END IF;
    IF (SELECT count(*) FROM demo_seed.teams) <> 128 OR (SELECT count(*) FROM demo_seed.players) <> 1259
       OR (SELECT count(*) FROM demo_seed.coaches) <> 251 OR (SELECT count(*) FROM demo_seed.practice_slots) <> 196 THEN
        RAISE EXCEPTION 'demo_seed does not hold the demo league';
    END IF;
    RAISE NOTICE 'posture: % demo functions pinned and closed to anon, purge scheduled every 10 minutes, % fence triggers, demo_seed closed to clients and holding % players on % teams',
        12, 7, (SELECT count(*) FROM demo_seed.players), (SELECT count(*) FROM demo_seed.teams);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The copy, the fences, expiry and the purge, in one rolled-back transaction.
-- ---------------------------------------------------------------------------
BEGIN;

CREATE TEMP TABLE ds_ids (name text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO ds_ids VALUES
    ('visitor', gen_random_uuid()), ('real_admin', gen_random_uuid()), ('real_org', gen_random_uuid()),
    ('old_visitor', gen_random_uuid());

DO $$
DECLARE
    v_visitor uuid := (SELECT id FROM ds_ids WHERE name = 'visitor');
    v_old     uuid := (SELECT id FROM ds_ids WHERE name = 'old_visitor');
    v_admin   uuid := (SELECT id FROM ds_ids WHERE name = 'real_admin');
    v_real    uuid := (SELECT id FROM ds_ids WHERE name = 'real_org');
    v_res     jsonb;
    v_demo    uuid;
    v_msg     text;
    v_n       integer;
    v_player  uuid;
    v_team    uuid;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, is_anonymous)
    VALUES (v_visitor, NULL, '{"password_length": 12}', true),
           (v_old, NULL, '{"password_length": 12}', true),
           (v_admin, 'demo-smoke-admin@example.test', '{"password_length": 12}', false);
    UPDATE auth.users SET created_at = now() - interval '3 hours' WHERE id = v_old;
    INSERT INTO public.organizations (id, name, slug) VALUES (v_real, 'Smoke real org', 'demo-smoke-real-' || v_real);
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_real, v_admin, 'admin');

    -- ---- the copy ----
    PERFORM set_config('request.jwt.claim.sub', v_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_visitor, 'is_anonymous', true)::text, true);
    v_res := public.start_demo_session();
    v_demo := (v_res ->> 'organization_id')::uuid;
    IF (v_res ->> 'existing')::boolean OR v_demo IS NULL THEN
        RAISE EXCEPTION 'start_demo_session returned %', v_res;
    END IF;
    IF (SELECT array[count(*), count(DISTINCT team_id)] FROM public.players WHERE organization_id = v_demo)
       IS DISTINCT FROM ARRAY[(SELECT count(*) FROM demo_seed.players), (SELECT count(*) FROM demo_seed.teams)]::bigint[] THEN
        RAISE EXCEPTION 'the copy does not hold every seeded player on every seeded team';
    END IF;
    IF (SELECT count(*) FROM public.practice_slots WHERE organization_id = v_demo) <> (SELECT count(*) FROM demo_seed.practice_slots)
       OR (SELECT count(*) FROM public.coaches WHERE organization_id = v_demo) <> (SELECT count(*) FROM demo_seed.coaches)
       OR (SELECT count(*) FROM public.practice_slots WHERE organization_id = v_demo AND division_id IS NOT NULL) <> 4 THEN
        RAISE EXCEPTION 'the copy lost slots or coaches, or reserved a number of slots other than the four U4 sessions';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_demo AND demo_owner = v_visitor
                    AND demo_expires_at BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes') THEN
        RAISE EXCEPTION 'the demo is not flagged for its visitor with a 30-minute expiry';
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE organization_id = v_demo AND action = 'demo.started') <> 1
       OR NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = v_demo AND profile_id = v_visitor AND role = 'admin') THEN
        RAISE EXCEPTION 'the demo has no admin visitor or no demo.started row';
    END IF;
    IF (public.start_demo_session() ->> 'organization_id')::uuid IS DISTINCT FROM v_demo THEN
        RAISE EXCEPTION 'a second call did not return the same demo';
    END IF;
    RAISE NOTICE 'the copy: % players on % teams, % coaches, % practice slots (4 reserved), flagged for the visitor, expiring in 30 minutes, one demo.started row, a second call returns it',
        (SELECT count(*) FROM public.players WHERE organization_id = v_demo),
        (SELECT count(*) FROM public.teams WHERE organization_id = v_demo),
        (SELECT count(*) FROM public.coaches WHERE organization_id = v_demo),
        (SELECT count(*) FROM public.practice_slots WHERE organization_id = v_demo);

    -- ---- the anonymous fence ----
    BEGIN
        INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_real, v_visitor, 'admin');
        RAISE EXCEPTION 'an anonymous visitor joined a real organization';
    EXCEPTION WHEN insufficient_privilege THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg <> 'A demo visitor cannot create or join an organization' THEN
            RAISE EXCEPTION 'refused for another reason: %', v_msg;
        END IF;
    END;
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_visitor)::text, true);
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_real, v_visitor, 'coach');
    DELETE FROM public.organization_members WHERE organization_id = v_real AND profile_id = v_visitor;
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_visitor, 'is_anonymous', true)::text, true);
    RAISE NOTICE 'the anonymous fence: a visitor''s membership of a real organization is refused 42501, and the same insert passes without the anonymous claim';

    -- ---- the people and import fences ----
    SELECT p.id, t.id INTO v_player, v_team FROM public.players p JOIN public.teams t ON t.division_id = p.division_id AND t.id <> p.team_id
     WHERE p.organization_id = v_demo ORDER BY p.external_registration_id LIMIT 1;
    PERFORM public.admin_update_player(v_player, jsonb_build_object('team_id', v_team));
    IF (SELECT team_id FROM public.players WHERE id = v_player) <> v_team THEN
        RAISE EXCEPTION 'a demo player did not move teams';
    END IF;
    BEGIN
        PERFORM public.admin_update_player(v_player, '{"first_name": "Typed"}');
        RAISE EXCEPTION 'a demo player''s name changed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM public.create_import_job(v_demo, 'players', 'players.csv');
        RAISE EXCEPTION 'an import job was created for a demo';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'the people and import fences: a demo player moves teams, keeps their name, no import job is created';

    -- ---- expiry ----
    IF NOT (public.is_org_member(v_demo) AND public.is_org_admin(v_demo)) THEN
        RAISE EXCEPTION 'the visitor is not a member and admin of a live demo';
    END IF;
    UPDATE public.organizations SET demo_expires_at = now() - interval '1 minute' WHERE id = v_demo;
    IF public.is_org_member(v_demo) OR public.is_org_admin(v_demo) THEN
        RAISE EXCEPTION 'the visitor is still a member or admin of an expired demo';
    END IF;
    RAISE NOTICE 'expiry: a member and admin of a live demo, neither one minute after it expired';

    -- ---- the purge ----
    SELECT (public.purge_expired_demos() ->> 'orgs_deleted')::integer INTO v_n;
    IF v_n <> 1 OR EXISTS (SELECT 1 FROM public.organizations WHERE id = v_demo) THEN
        RAISE EXCEPTION 'the purge did not delete exactly the expired demo (deleted %)', v_n;
    END IF;
    IF EXISTS (SELECT 1 FROM public.players WHERE organization_id = v_demo)
       OR EXISTS (SELECT 1 FROM auth.users WHERE id = v_visitor OR id = v_old) THEN
        RAISE EXCEPTION 'the purge left the demo''s rows, its visitor or the hour-old orphan';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_real)
       OR NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = v_real AND profile_id = v_admin)
       OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_admin) THEN
        RAISE EXCEPTION 'the purge touched a real organization or its admin';
    END IF;
    RAISE NOTICE 'the purge: the expired demo, its visitor and the hour-old orphan are gone; the real organization and its admin are not';
END;
$$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- 3. The races. A second session (dblink) asks while the first has not committed.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS dblink;

CREATE TABLE public.ds_race_ids (name text PRIMARY KEY, id uuid NOT NULL);

DO $$
DECLARE
    v_visitor uuid := gen_random_uuid();
BEGIN
    INSERT INTO public.ds_race_ids VALUES ('v1', v_visitor), ('w1', gen_random_uuid()), ('w2', gen_random_uuid());
    INSERT INTO auth.users (id, email, raw_user_meta_data, is_anonymous)
    SELECT id, NULL, '{"password_length": 12}', true FROM public.ds_race_ids;
    PERFORM dblink_connect('ds_racer', format('dbname=%s host=%s port=%s user=%s',
        current_database(), split_part(current_setting('unix_socket_directories'), ',', 1),
        current_setting('port'), current_user));
END;
$$;

-- 3a. The same visitor twice: the second waits for the first.
BEGIN;
DO $$
DECLARE
    v_v1 uuid := (SELECT id FROM public.ds_race_ids WHERE name = 'v1');
    v_first jsonb;
    v_state text;
    v_msg text;
    v_wait text;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_v1::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_v1, 'is_anonymous', true)::text, true);
    v_first := public.start_demo_session();
    PERFORM set_config('smoke.demo_v1', v_first ->> 'organization_id', false);

    PERFORM dblink_exec('ds_racer', format('SET request.jwt.claim.sub = %L', v_v1));
    PERFORM dblink_exec('ds_racer', format('SET request.jwt.claims = %L',
        jsonb_build_object('sub', v_v1, 'is_anonymous', true)::text));
    PERFORM dblink_exec('ds_racer', 'SET lock_timeout = ''1s''');
    BEGIN
        PERFORM dblink_exec('ds_racer', 'BEGIN');
        PERFORM * FROM dblink('ds_racer', 'SELECT public.start_demo_session()') AS t(r jsonb);
        v_wait := 'returned';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_wait := v_state || ' ' || v_msg;
    END;
    PERFORM dblink_exec('ds_racer', 'ROLLBACK');
    -- The control: the second session is not simply unable to run.
    IF (SELECT r FROM dblink('ds_racer', 'SELECT 1') AS t(r integer)) <> 1 THEN
        RAISE EXCEPTION 'the second session cannot run a statement';
    END IF;
    IF v_wait NOT LIKE '55P03%' THEN
        RAISE EXCEPTION 'a second start by the same visitor, while the first was open, gave "%" instead of waiting', v_wait;
    END IF;
    RAISE NOTICE 'race, one visitor: while the first start was open, the second timed out waiting (55P03: the lock, with the unique index behind it)';
END;
$$;
COMMIT;

DO $$
DECLARE
    v_org text := current_setting('smoke.demo_v1');
    v_second text;
BEGIN
    SELECT r ->> 'organization_id' INTO v_second
      FROM dblink('ds_racer', 'SELECT public.start_demo_session()') AS t(r jsonb);
    IF v_second IS DISTINCT FROM v_org
       OR (SELECT count(*) FROM public.organizations WHERE demo_owner = (SELECT id FROM public.ds_race_ids WHERE name = 'v1')) <> 1 THEN
        RAISE EXCEPTION 'after the first committed, the second start gave % (the first made %)', v_second, v_org;
    END IF;
    RAISE NOTICE 'race, one visitor: once the first committed, the second start returned the same organization, and the visitor has one';
END;
$$;

-- 3b. Two visitors at the cap: with the live count at nine, only one gets the tenth.
DO $$
BEGIN
    -- Leave the live count at 9, whatever else is live: v1's demo plus fillers.
    INSERT INTO public.organizations (name, slug, demo_expires_at)
    SELECT 'Smoke filler ' || g, 'demo-smoke-filler-' || g || '-' || gen_random_uuid(), now() + interval '20 minutes'
      FROM generate_series(1, 9 - (SELECT count(*) FROM public.organizations WHERE demo_expires_at > now())::int) g;
    IF (SELECT count(*) FROM public.organizations WHERE demo_expires_at > now()) <> 9 THEN
        RAISE EXCEPTION 'the live count is % before the cap race, not 9',
            (SELECT count(*) FROM public.organizations WHERE demo_expires_at > now());
    END IF;
END;
$$;

BEGIN;
DO $$
DECLARE
    v_w1 uuid := (SELECT id FROM public.ds_race_ids WHERE name = 'w1');
    v_w2 uuid := (SELECT id FROM public.ds_race_ids WHERE name = 'w2');
    v_state text;
    v_msg text;
    v_wait text;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_w1::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_w1, 'is_anonymous', true)::text, true);
    PERFORM public.start_demo_session();

    PERFORM dblink_exec('ds_racer', format('SET request.jwt.claim.sub = %L', v_w2));
    PERFORM dblink_exec('ds_racer', format('SET request.jwt.claims = %L',
        jsonb_build_object('sub', v_w2, 'is_anonymous', true)::text));
    BEGIN
        PERFORM dblink_exec('ds_racer', 'BEGIN');
        PERFORM * FROM dblink('ds_racer', 'SELECT public.start_demo_session()') AS t(r jsonb);
        v_wait := 'returned';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_wait := v_state || ' ' || v_msg;
    END;
    PERFORM dblink_exec('ds_racer', 'ROLLBACK');
    IF v_wait NOT LIKE '55P03%' THEN
        RAISE EXCEPTION 'at the cap, a second visitor''s start while the tenth was open gave "%" instead of waiting', v_wait;
    END IF;
END;
$$;
COMMIT;

DO $$
DECLARE
    v_state text;
    v_msg text;
    v_result text;
    v_live integer;
BEGIN
    BEGIN
        PERFORM * FROM dblink('ds_racer', 'SELECT public.start_demo_session()') AS t(r jsonb);
        v_result := 'returned';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_result := v_state || ' ' || v_msg;
    END;
    SELECT count(*) INTO v_live FROM public.organizations WHERE demo_expires_at > now();
    IF v_result NOT LIKE 'P0001 %busy%' OR v_live <> 10 THEN
        RAISE EXCEPTION 'at the cap the second visitor got "%" and the live count is % (want a capacity refusal and 10)', v_result, v_live;
    END IF;
    RAISE NOTICE 'race, the cap: with nine live demos one visitor got the tenth, the other waited and was then refused for capacity; live demos 10, never 11';
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Everything the races committed goes.
-- ---------------------------------------------------------------------------
SELECT dblink_disconnect('ds_racer') IS NOT NULL AS disconnected \gset
DELETE FROM public.organizations WHERE demo_expires_at IS NOT NULL;
DELETE FROM auth.users WHERE id IN (SELECT id FROM public.ds_race_ids);
DROP TABLE public.ds_race_ids;
DROP EXTENSION dblink;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.organizations WHERE demo_expires_at IS NOT NULL)
       OR EXISTS (SELECT 1 FROM auth.users WHERE is_anonymous) THEN
        RAISE EXCEPTION 'the races left a demo organization or an anonymous user behind';
    END IF;
END;
$$;
