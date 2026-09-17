-- Smoke checks for 20260917000000_season_timezone_actor_context.sql
--
-- **These ASSERT rather than report**, and the substantive one at the bottom
-- EXECUTES the function rather than reading its source. That distinction is
-- the whole point of this file: the defect it closes was two audit rows, and
-- no amount of `prosrc` matching can count rows. Sections 1-3 are catalogue
-- checks that the shape is right; section 4 drives the RPC on a real org with
-- a real session and counts what landed in `audit_log`.
--
-- Section 4 seeds and then removes its own fixture, so it leaves the database
-- as it found it for anything running after.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Exactly ONE admin_set_season_timezone, and it is the four-argument one
-- ---------------------------------------------------------------------------
--
-- Enumerated by the ways this can be wrong rather than by the one way it can
-- be right. "Does the four-argument function exist" passes with the
-- three-argument one still standing beside it -- which would leave the
-- un-audited path callable and make the whole migration optional.
DO $$
DECLARE
    v_count int;
    v_args text;
BEGIN
    SELECT count(*), COALESCE(max(oidvectortypes(p.proargtypes)), '')
      INTO v_count, v_args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'admin_set_season_timezone';

    IF v_count = 0 THEN
        RAISE EXCEPTION 'admin_set_season_timezone is missing; the Settings control has no writer';
    END IF;
    IF v_count > 1 THEN
        RAISE EXCEPTION
            'admin_set_season_timezone has % overloads; the three-argument writer must be DROPped, not left callable beside the new one', v_count;
    END IF;
    IF v_args <> 'uuid, uuid, text, jsonb' THEN
        RAISE EXCEPTION
            'admin_set_season_timezone has signature (%), wanted (uuid, uuid, text, jsonb)', v_args;
    END IF;

    RAISE NOTICE 'admin_set_season_timezone: exactly 1 overload, (%)', v_args;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. It is still locked down and still validates, by oid
-- ---------------------------------------------------------------------------
--
-- `has_function_privilege` by **oid**, not by a signature string: a literal
-- `'public.admin_set_season_timezone(uuid, uuid, text)'` is exactly what went
-- stale when this migration changed the arity, and a stale signature raises
-- `undefined_function` rather than failing the check it was written for.
DO $$
DECLARE
    v_oid oid;
    v_src text;
    v_secdef boolean;
    v_config text[];
BEGIN
    SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig
      INTO v_oid, v_src, v_secdef, v_config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'admin_set_season_timezone';

    IF NOT v_secdef THEN
        RAISE EXCEPTION 'admin_set_season_timezone must be SECURITY DEFINER';
    END IF;
    IF v_config IS NULL OR NOT (v_config && ARRAY['search_path=public']) THEN
        RAISE EXCEPTION 'admin_set_season_timezone must SET search_path = public (LESSONS_LEARNED #1)';
    END IF;
    IF v_src !~* 'is_org_admin' THEN
        RAISE EXCEPTION 'admin_set_season_timezone must gate on is_org_admin()';
    END IF;
    IF v_src !~* 'pg_timezone_names' THEN
        RAISE EXCEPTION 'admin_set_season_timezone must validate the zone against pg_timezone_names';
    END IF;
    IF v_src !~* 'record_audit_event' THEN
        RAISE EXCEPTION 'admin_set_season_timezone must audit (CLAUDE.md: audit immutability)';
    END IF;
    IF v_src !~* 'p_actor_context' THEN
        RAISE EXCEPTION
            'admin_set_season_timezone does not read p_actor_context; the argument would be parsed and unread, which is how the impersonation context was lost to a second audit row in the first place';
    END IF;

    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION
            'anon can EXECUTE admin_set_season_timezone; a definer function that writes org state must not be reachable anonymously (LESSONS_LEARNED #5)';
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION
            'authenticated cannot EXECUTE admin_set_season_timezone; the Settings control would fail for every admin';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. `impersonated_by` and `admin_email` are DERIVED, not taken from the caller
-- ---------------------------------------------------------------------------
--
-- The argument exists so the server learns the one thing it cannot know. If it
-- ever starts copying the caller's claim about WHO IS ACTING into the audit
-- row, the row stops being evidence -- so the body must not read those keys off
-- `p_actor_context` at all.
DO $$
DECLARE
    v_src text;
BEGIN
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'admin_set_season_timezone';

    IF v_src ~* 'p_actor_context\s*->>?\s*''(impersonated_by|admin_email)'''
       OR v_src ~* 'v_context\s*->>?\s*''(impersonated_by|admin_email)''' THEN
        RAISE EXCEPTION
            'admin_set_season_timezone reads impersonated_by or admin_email off the caller-supplied context; both must be derived from auth.uid()';
    END IF;
    IF v_src !~* 'auth\.uid\(\)' THEN
        RAISE EXCEPTION 'admin_set_season_timezone does not read auth.uid(); the acting admin cannot be derived';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. THE BEHAVIOURAL CHECK: one complete row, not two half ones
-- ---------------------------------------------------------------------------
--
-- Sections 1-3 read source. This one runs the function twice on a real
-- organization with a real session -- once plainly, once "viewing as" another
-- profile -- and counts `audit_log`. Two rows for one change, or one row
-- missing either half of the story, fails here.
--
-- **Rows are identified by id set, not by "the newest".** The first attempt
-- ordered by `created_at DESC, id DESC` and read the WRONG row: both audit
-- rows are written by `now()`, which is the TRANSACTION timestamp and
-- therefore identical, and `id` is a random uuid so the tiebreak was a coin
-- toss. The check failed against correct behaviour -- a check that fails for a
-- reason other than the one it names is worse than no check. Taking the ids
-- before each call and reading the ones that are new is exact.
DO $$
DECLARE
    v_org uuid;
    v_admin uuid := gen_random_uuid();
    v_target uuid := gen_random_uuid();
    v_season uuid;
    v_seen uuid[];
    v_written bigint;
    v_row public.audit_log%ROWTYPE;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES (v_admin, 'tz-actor-admin@example.test', jsonb_build_object('password_length', 16)),
           (v_target, 'tz-actor-target@example.test', jsonb_build_object('password_length', 16));
    -- `ON CONFLICT DO UPDATE`, not `DO NOTHING`: a trigger on `auth.users`
    -- already creates the profile row, and `DO NOTHING` would leave its email
    -- to whatever that trigger derived -- which the `admin_email` assertion
    -- below then reads. Setting it here makes the expected value this smoke's
    -- own, rather than a second component's.
    INSERT INTO public.profiles (id, email)
    VALUES (v_admin, 'tz-actor-admin@example.test'), (v_target, 'tz-actor-target@example.test')
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
    INSERT INTO public.organizations (name, slug) VALUES ('TZ Actor Org', 'tz-actor-org')
    RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role)
    VALUES (v_org, v_admin, 'admin');
    INSERT INTO public.season_settings (organization_id, name, timezone)
    VALUES (v_org, 'TZ Actor Season', 'UTC')
    RETURNING id INTO v_season;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

    -- -- a plain change ---------------------------------------------------
    SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_seen
      FROM public.audit_log WHERE organization_id = v_org;
    PERFORM public.admin_set_season_timezone(v_org, v_season, 'America/New_York');

    SELECT count(*) INTO v_written
      FROM public.audit_log WHERE organization_id = v_org AND NOT (id = ANY(v_seen));
    IF v_written <> 1 THEN
        RAISE EXCEPTION 'a plain timezone change wrote % audit row(s); expected exactly 1', v_written;
    END IF;
    SELECT * INTO v_row
      FROM public.audit_log WHERE organization_id = v_org AND NOT (id = ANY(v_seen));

    IF v_row.action <> 'settings.timezone_updated' THEN
        RAISE EXCEPTION 'the plain change was audited as %, not settings.timezone_updated', v_row.action;
    END IF;
    IF v_row.metadata->>'timezone' <> 'America/New_York'
       OR v_row.metadata->>'previous_timezone' <> 'UTC' THEN
        RAISE EXCEPTION 'the plain change did not record both values: %', v_row.metadata;
    END IF;
    IF v_row.metadata ? 'target_user_id' THEN
        RAISE EXCEPTION 'a change made by an admin as themselves claims an impersonation target: %', v_row.metadata;
    END IF;

    -- -- the same change, made while viewing as another profile ------------
    SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_seen
      FROM public.audit_log WHERE organization_id = v_org;
    PERFORM public.admin_set_season_timezone(
        v_org, v_season, 'America/Chicago',
        jsonb_build_object('target_user_id', v_target)
    );

    SELECT count(*) INTO v_written
      FROM public.audit_log WHERE organization_id = v_org AND NOT (id = ANY(v_seen));
    -- **The defect, stated as a number.** Before this migration the client
    -- fired its own record_audit_event beside the RPC under impersonation, so
    -- this count was 2 -- and neither row told the whole story.
    IF v_written <> 1 THEN
        RAISE EXCEPTION
            'an impersonated timezone change wrote % audit row(s); expected exactly 1 complete row, not one per writer', v_written;
    END IF;
    SELECT * INTO v_row
      FROM public.audit_log WHERE organization_id = v_org AND NOT (id = ANY(v_seen));

    IF v_row.metadata->>'timezone' <> 'America/Chicago'
       OR v_row.metadata->>'previous_timezone' <> 'America/New_York' THEN
        RAISE EXCEPTION 'the impersonated change lost the value half of the story: %', v_row.metadata;
    END IF;
    IF (v_row.metadata->>'target_user_id')::uuid IS DISTINCT FROM v_target THEN
        RAISE EXCEPTION 'the impersonated change lost the target: %', v_row.metadata;
    END IF;
    -- Derived, not taken from the caller: the caller sent neither of these.
    IF (v_row.metadata->>'impersonated_by')::uuid IS DISTINCT FROM v_admin THEN
        RAISE EXCEPTION 'impersonated_by was not derived from auth.uid(): %', v_row.metadata;
    END IF;
    IF v_row.metadata->>'admin_email' <> 'tz-actor-admin@example.test' THEN
        RAISE EXCEPTION 'admin_email was not derived from profiles: %', v_row.metadata;
    END IF;
    IF v_row.user_id <> v_admin THEN
        RAISE EXCEPTION 'audit_log.user_id is % but the acting admin is %', v_row.user_id, v_admin;
    END IF;

    -- -- a malformed target is refused, not silently dropped ---------------
    BEGIN
        PERFORM public.admin_set_season_timezone(
            v_org, v_season, 'UTC', jsonb_build_object('target_user_id', 'not-a-uuid')
        );
        RAISE EXCEPTION 'a non-uuid target_user_id was accepted; an impersonated change would read as a direct one';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;  -- 22023, as intended
    END;

    RAISE NOTICE 'actor context: 2 changes, 2 audit rows, both complete; a non-uuid target refused';

    DELETE FROM public.organizations WHERE id = v_org;
    DELETE FROM public.profiles WHERE id IN (v_admin, v_target);
    DELETE FROM auth.users WHERE id IN (v_admin, v_target);
END;
$$;
