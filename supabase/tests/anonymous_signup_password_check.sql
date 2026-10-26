-- pgTAP: an anonymous sign-in carries no password (migration 20261031010000; plan
-- docs/changes/2026-10-22-demo-mode.md, D4).
--
-- `check_password_length_on_auth_users()`, the function behind `check_password_length_trigger` on
-- auth.users, used to refuse every insert without a `password_length` of 12 or more, which refused
-- every anonymous sign-in. It now returns at once for an INSERT whose `is_anonymous` is true, and
-- nothing else: a non-anonymous insert, and any change of `encrypted_password`, anonymous user or not,
-- are checked as before. The change test is IS DISTINCT FROM: an anonymous user's password is NULL
-- until they set one, and NULL <> 'x' is NULL, so the first password an anonymous user sets was never
-- checked. `on_auth_user_created` (handle_new_user) must also accept the NULL email an anonymous user
-- has.
--
-- The UPDATE path reads `raw_user_meta_data->>'password_length'` from the NEW row, so a password change
-- carries its length in the same update, as the app does (`AuthContext.updatePassword` sends
-- `data: { password_length }` with the new password). Each updated user below starts with an
-- `encrypted_password`, as a real one has; the anonymous one starts with NULL, as GoTrue makes it.

BEGIN;

SELECT plan(11);

SELECT lives_ok(
    $$INSERT INTO auth.users (id, email, encrypted_password, is_anonymous)
      VALUES ('e1000000-0000-4000-8000-000000000001', NULL, NULL, true)$$,
    'an anonymous insert, with no email, no metadata and no password, is accepted'
);
SELECT is(
    (SELECT count(*)::int FROM public.profiles
      WHERE id = 'e1000000-0000-4000-8000-000000000001' AND email IS NULL),
    1,
    'on_auth_user_created gave the anonymous user a profile with a NULL email'
);
SELECT throws_like(
    $$INSERT INTO auth.users (id, email, is_anonymous)
      VALUES ('e1000000-0000-4000-8000-000000000002', 'anon-pw-a@test.local', false)$$,
    '%Password must be at least 12 characters%',
    'a non-anonymous insert with no password_length is still refused'
);
SELECT throws_like(
    $$INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES ('e1000000-0000-4000-8000-000000000003', 'anon-pw-b@test.local', '{"password_length": 11}')$$,
    '%Password must be at least 12 characters%',
    'a non-anonymous insert with a password_length of 11 is still refused'
);
SELECT lives_ok(
    $$INSERT INTO auth.users (id, email, raw_user_meta_data, encrypted_password)
      VALUES ('e1000000-0000-4000-8000-000000000004', 'anon-pw-c@test.local',
              '{"password_length": 12}', 'hash-before')$$,
    'a non-anonymous insert with a password_length of 12 is accepted'
);
SELECT throws_like(
    $$UPDATE auth.users SET encrypted_password = 'changed-1'
       WHERE id = 'e1000000-0000-4000-8000-000000000001'$$,
    '%Password must be at least 12 characters%',
    'an anonymous user setting their first password with no password_length is refused'
);
SELECT lives_ok(
    $$UPDATE auth.users SET encrypted_password = 'changed-2',
             raw_user_meta_data = '{"password_length": 12}'
       WHERE id = 'e1000000-0000-4000-8000-000000000001'$$,
    'an anonymous user setting a 12-character password, length sent with it, is accepted'
);
SELECT throws_like(
    $$UPDATE auth.users SET encrypted_password = 'changed-3',
             raw_user_meta_data = '{"password_length": 11}'
       WHERE id = 'e1000000-0000-4000-8000-000000000004'$$,
    '%Password must be at least 12 characters%',
    'a real user changing their password to an 11-character one, length sent with it, is refused'
);
SELECT lives_ok(
    $$UPDATE auth.users SET email = 'anon-pw-d@test.local'
       WHERE id = 'e1000000-0000-4000-8000-000000000004'$$,
    'an update that leaves the password alone is not checked'
);
SELECT ok(
    EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = 'public.check_password_length_on_auth_users()'::regprocedure
               AND p.prosecdef
               AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public'))
    AND NOT has_function_privilege('anon', 'public.check_password_length_on_auth_users()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.check_password_length_on_auth_users()', 'EXECUTE'),
    'the check is a definer with a pinned search_path that no client role may execute'
);
SELECT is(
    (SELECT string_agg(pg_get_triggerdef(t.oid), E'\n' ORDER BY t.tgname)
       FROM pg_trigger t
      WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
        AND t.tgfoid = 'public.check_password_length_on_auth_users()'::regprocedure),
    'CREATE TRIGGER check_password_length_trigger BEFORE INSERT OR UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION check_password_length_on_auth_users()',
    'the one original trigger is untouched'
);

SELECT * FROM finish();
ROLLBACK;
