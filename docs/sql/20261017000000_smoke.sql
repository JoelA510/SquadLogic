-- Smoke checks for 20261017000000_exports_bucket.sql
--
-- What it proves, each as the caller the policy is written for (prelude.sql
-- stubs `auth.uid()` from `request.jwt.claim.sub`; Supabase's own reads the
-- same setting first):
--   * the `exports` bucket exists and is private;
--   * its policies are exactly a members' SELECT, an admins' INSERT and an
--     admins' DELETE, all TO authenticated (no UPDATE);
--   * an admin of organization A uploads under A's folder and reads both of
--     A's objects; a signed-in user with no membership (a coach, before
--     20261104010000 removed that role) is refused an upload with 42501 and
--     reads none;
--   * an admin of organization B reads none of A's objects and cannot upload
--     under A's folder;
--   * a name with no folder, a non-UUID folder, or another organization's
--     folder is refused with 42501 (RLS), never 22P02 (a cast error);
--   * an update by A's own admin changes nothing (no policy);
--   * the anonymous role reads nothing and cannot upload;
--   * a delete by that user, by B's admin or by the anonymous role removes
--     nothing, and one by A's admin removes the one file it names. That part
--     runs only where SQL deletes reach the policies: on Supabase,
--     `storage.protect_delete()` refuses every SQL delete on storage.objects
--     whatever the policies say (pgTAP run 39007939141), so there the delete
--     policy is held by the catalog check above and by the real-backend E2E,
--     which removes files through the Storage API. The harness's stand-in has
--     no such trigger, so the harness runs it; its NOTICE says which ran.
--
-- **The harness's storage stand-in.** scripts/dbharness/prelude.sql creates
-- `storage.objects` without RLS and without table grants, where Supabase has
-- both. Inside this transaction only, and only when they are missing, this
-- smoke turns RLS on and grants the API roles what Supabase grants them, so
-- the policies are judged as Supabase judges them. On a Supabase database
-- both are already in place and nothing is changed. Its NOTICE says which.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind. Every id is
-- generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) THEN
        ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'storage.objects had RLS off (the harness stand-in); turned on for this transaction';
    END IF;
    IF NOT has_table_privilege('authenticated', 'storage.objects', 'INSERT')
       OR NOT has_table_privilege('anon', 'storage.objects', 'INSERT') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;
        RAISE NOTICE 'storage.objects had no API-role grants (the harness stand-in); granted for this transaction';
    END IF;
END;
$$;

-- One upload as p_user ('anon' when NULL): 'ok' or the SQLSTATE it raised.
CREATE FUNCTION pg_temp.exports_upload(p_user uuid, p_name text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_state text;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', CASE WHEN p_user IS NULL THEN 'anon' ELSE 'authenticated' END, true);
    BEGIN
        IF p_user IS NULL THEN SET LOCAL ROLE anon; ELSE SET LOCAL ROLE authenticated; END IF;
        INSERT INTO storage.objects (bucket_id, name) VALUES ('exports', p_name);
        RESET ROLE;
        RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    RESET ROLE;
    RETURN v_state;
END;
$$;

-- One delete of p_name as p_user ('anon' when NULL): the rows removed, or the
-- SQLSTATE it raised.
CREATE FUNCTION pg_temp.exports_delete(p_user uuid, p_name text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_rows integer;
    v_state text;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', CASE WHEN p_user IS NULL THEN 'anon' ELSE 'authenticated' END, true);
    BEGIN
        IF p_user IS NULL THEN SET LOCAL ROLE anon; ELSE SET LOCAL ROLE authenticated; END IF;
        DELETE FROM storage.objects WHERE bucket_id = 'exports' AND name = p_name;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        RESET ROLE;
        RETURN v_rows::text;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    RESET ROLE;
    RETURN v_state;
END;
$$;

-- How many `exports` objects under p_prefix p_user ('anon' when NULL) can read.
CREATE FUNCTION pg_temp.exports_visible(p_user uuid, p_prefix text) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    v integer;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', CASE WHEN p_user IS NULL THEN 'anon' ELSE 'authenticated' END, true);
    IF p_user IS NULL THEN SET LOCAL ROLE anon; ELSE SET LOCAL ROLE authenticated; END IF;
    SELECT count(*) INTO v FROM storage.objects WHERE bucket_id = 'exports' AND name LIKE p_prefix || '%';
    RESET ROLE;
    RETURN v;
END;
$$;

DO $$
DECLARE
    v_admin_a uuid := gen_random_uuid();
    v_stranger_a uuid := gen_random_uuid();   -- signed in, a member of no organization
    v_admin_b uuid := gen_random_uuid();
    v_org_a uuid;
    v_org_b uuid;
    v_res text;
    v_rows integer;
    v_policies text;
BEGIN
    -- 1. The bucket, private.
    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'exports') THEN
        RAISE EXCEPTION 'the exports bucket does not exist';
    END IF;
    IF (SELECT public FROM storage.buckets WHERE id = 'exports') IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'the exports bucket is not private';
    END IF;

    -- 2. Exactly its three policies, all for authenticated callers only.
    SELECT string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ','), ' ' ORDER BY policyname)
      INTO v_policies
      FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND (policyname LIKE 'exports%' OR qual LIKE '%''exports''%' OR with_check LIKE '%''exports''%');
    IF v_policies IS DISTINCT FROM
       'exports org-admin delete:DELETE:authenticated exports org-admin insert:INSERT:authenticated exports org-member select:SELECT:authenticated' THEN
        RAISE EXCEPTION 'the exports policies are not exactly a members'' SELECT and an admins'' INSERT and DELETE for authenticated: %', v_policies;
    END IF;
    RAISE NOTICE 'the exports bucket is private, with exactly a members'' SELECT and an admins'' INSERT and DELETE policy, all TO authenticated';

    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin_a, 'exports-admin-a@example.test', '{"password_length": 16}'),
        (v_stranger_a, 'exports-stranger-a@example.test', '{"password_length": 16}'),
        (v_admin_b, 'exports-admin-b@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin_a, 'exports-admin-a@example.test'),
        (v_stranger_a, 'exports-stranger-a@example.test'),
        (v_admin_b, 'exports-admin-b@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Exports A', 'smoke-exports-a')
        RETURNING id INTO v_org_a;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Exports B', 'smoke-exports-b')
        RETURNING id INTO v_org_b;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org_a, v_admin_a, 'admin'),
        (v_org_b, v_admin_b, 'admin');

    -- 3. A's admin uploads under A's folder; a signed-in user with no membership is refused.
    v_res := pg_temp.exports_upload(v_admin_a, v_org_a || '/master-schedule-smoke.csv');
    IF v_res <> 'ok' THEN RAISE EXCEPTION 'A''s admin could not upload under A''s folder: %', v_res; END IF;
    v_res := pg_temp.exports_upload(v_admin_a, v_org_a || '/teams/team-smoke.csv');
    IF v_res <> 'ok' THEN RAISE EXCEPTION 'A''s admin could not upload a team file under A''s folder: %', v_res; END IF;
    v_res := pg_temp.exports_upload(v_stranger_a, v_org_a || '/teams/planted-by-stranger.csv');
    IF v_res <> '42501' THEN RAISE EXCEPTION 'a non-member uploading under A''s folder gave % (want 42501: only admins upload)', v_res; END IF;

    -- 4. A's admin reads both; the non-member and B's admin read none of them.
    IF pg_temp.exports_visible(v_admin_a, v_org_a::text) <> 2 THEN
        RAISE EXCEPTION 'A''s admin does not read A''s 2 exports (read %)', pg_temp.exports_visible(v_admin_a, v_org_a::text);
    END IF;
    IF pg_temp.exports_visible(v_stranger_a, v_org_a::text) <> 0 THEN
        RAISE EXCEPTION 'a non-member reads % of A''s exports', pg_temp.exports_visible(v_stranger_a, v_org_a::text);
    END IF;
    IF pg_temp.exports_visible(v_admin_b, v_org_a::text) <> 0 THEN
        RAISE EXCEPTION 'B''s admin reads % of A''s exports', pg_temp.exports_visible(v_admin_b, v_org_a::text);
    END IF;
    IF pg_temp.exports_visible(v_admin_b, '') <> 0 THEN
        RAISE EXCEPTION 'B''s admin reads % exports in all', pg_temp.exports_visible(v_admin_b, '');
    END IF;
    RAISE NOTICE 'A''s admin uploaded 2 under A''s folder and read 2 of 2; a non-member was refused 42501 and read 0; B''s admin read 0';

    -- 5-6. Refusals: another organization's folder, no folder, a non-UUID folder.
    v_res := pg_temp.exports_upload(v_admin_b, v_org_a || '/planted-by-b.csv');
    IF v_res <> '42501' THEN RAISE EXCEPTION 'B''s admin uploading under A''s folder gave % (want 42501)', v_res; END IF;
    v_res := pg_temp.exports_upload(v_admin_a, v_org_b || '/planted-by-a.csv');
    IF v_res <> '42501' THEN RAISE EXCEPTION 'A''s admin uploading under B''s folder gave % (want 42501)', v_res; END IF;
    v_res := pg_temp.exports_upload(v_admin_a, 'master-schedule-no-folder.csv');
    IF v_res <> '42501' THEN RAISE EXCEPTION 'an upload with no folder gave % (want 42501)', v_res; END IF;
    v_res := pg_temp.exports_upload(v_admin_a, 'not-an-org/master.csv');
    IF v_res <> '42501' THEN RAISE EXCEPTION 'an upload under a non-UUID folder gave % (want 42501)', v_res; END IF;
    RAISE NOTICE 'uploads under another organization''s folder, no folder, or a non-UUID folder were each refused 42501, 4 of 4';

    -- 7. No update, even by A's own admin.
    PERFORM set_config('request.jwt.claim.sub', v_admin_a::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;
    UPDATE storage.objects SET name = name || '.renamed'
     WHERE bucket_id = 'exports' AND name LIKE v_org_a || '/%';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN RESET ROLE; RAISE EXCEPTION 'A''s admin updated % export(s)', v_rows; END IF;
    RESET ROLE;
    IF (SELECT count(*) FROM storage.objects
         WHERE bucket_id = 'exports' AND name LIKE v_org_a || '/%' AND name NOT LIKE '%.renamed') <> 2 THEN
        RAISE EXCEPTION 'A''s exports changed under an update with no policy';
    END IF;
    RAISE NOTICE 'an update by A''s admin changed 0 rows; both exports are as uploaded';

    -- 8. The anonymous role.
    IF pg_temp.exports_visible(NULL, '') <> 0 THEN
        RAISE EXCEPTION 'the anonymous role reads % exports', pg_temp.exports_visible(NULL, '');
    END IF;
    v_res := pg_temp.exports_upload(NULL, v_org_a || '/anon.csv');
    IF v_res <> '42501' THEN RAISE EXCEPTION 'an anonymous upload gave % (want 42501)', v_res; END IF;
    RAISE NOTICE 'the anonymous role read 0 exports and its upload was refused 42501';

    -- 9. Deletes, where SQL deletes reach the policies (see the header).
    IF EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'storage.objects'::regclass AND NOT t.tgisinternal
                  AND t.tgfoid = ANY (SELECT oid FROM pg_proc WHERE proname = 'protect_delete')) THEN
        RAISE NOTICE 'deletes not tried in SQL: storage.protect_delete() refuses them here; the catalog check holds the DELETE policy';
    ELSE
        v_res := pg_temp.exports_delete(v_stranger_a, v_org_a || '/master-schedule-smoke.csv');
        IF v_res <> '0' THEN RAISE EXCEPTION 'a non-member deleting A''s export gave % (want 0 rows)', v_res; END IF;
        v_res := pg_temp.exports_delete(v_admin_b, v_org_a || '/master-schedule-smoke.csv');
        IF v_res <> '0' THEN RAISE EXCEPTION 'B''s admin deleting A''s export gave % (want 0 rows)', v_res; END IF;
        v_res := pg_temp.exports_delete(NULL, v_org_a || '/master-schedule-smoke.csv');
        IF v_res <> '0' THEN RAISE EXCEPTION 'an anonymous delete of A''s export gave % (want 0 rows)', v_res; END IF;
        v_res := pg_temp.exports_delete(v_admin_a, v_org_a || '/teams/team-smoke.csv');
        IF v_res <> '1' THEN RAISE EXCEPTION 'A''s admin deleting A''s team export gave % (want 1 row)', v_res; END IF;
        IF (SELECT array_agg(name ORDER BY name) FROM storage.objects
             WHERE bucket_id = 'exports' AND name LIKE v_org_a || '/%')
           IS DISTINCT FROM ARRAY[v_org_a || '/master-schedule-smoke.csv'] THEN
            RAISE EXCEPTION 'after the deletes A''s exports are not exactly the master: %',
                (SELECT array_agg(name ORDER BY name) FROM storage.objects WHERE bucket_id = 'exports');
        END IF;
        RAISE NOTICE 'deletes by a non-member, B''s admin and the anonymous role removed 0 rows each; A''s admin removed the 1 file it named, and only that one';
    END IF;
END;
$$;

ROLLBACK;
