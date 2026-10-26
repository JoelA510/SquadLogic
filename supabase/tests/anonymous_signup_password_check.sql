-- pgTAP: an anonymous sign-in carries no password (migration 20261031010000; plan
-- docs/changes/2026-10-22-demo-mode.md, D4).
--
-- `check_password_length_trigger` on auth.users used to refuse every insert without a `password_length`
-- of 12 or more, which refused every anonymous sign-in. The insert check is now its own trigger with a
-- condition that skips an INSERT whose `is_anonymous` is true, and nothing else: a non-anonymous
-- insert, and any update of `encrypted_password`, anonymous user or not, are checked as before. `on_auth_user_created` (handle_new_user) must also accept the NULL
-- email an anonymous user has.

BEGIN;

SELECT plan(11);

SELECT lives_ok(
    $$INSERT INTO auth.users (id, email, is_anonymous)
      VALUES ('e1000000-0000-4000-8000-000000000001', NULL, true)$$,
    'an anonymous insert, with no email and no metadata, is accepted'
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
    $$INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES ('e1000000-0000-4000-8000-000000000004', 'anon-pw-c@test.local', '{"password_length": 12}')$$,
    'a non-anonymous insert with a password_length of 12 is accepted'
);
SELECT throws_like(
    $$UPDATE auth.users SET encrypted_password = 'changed-1'
       WHERE id = 'e1000000-0000-4000-8000-000000000001'$$,
    '%Password must be at least 12 characters%',
    'an anonymous user setting a password with no password_length is refused'
);
SELECT lives_ok(
    $$UPDATE auth.users SET encrypted_password = 'changed-2',
             raw_user_meta_data = '{"password_length": 12}'
       WHERE id = 'e1000000-0000-4000-8000-000000000001'$$,
    'an anonymous user setting a 12-character password is accepted'
);
SELECT throws_like(
    $$UPDATE auth.users SET encrypted_password = 'changed-3',
             raw_user_meta_data = '{"password_length": 11}'
       WHERE id = 'e1000000-0000-4000-8000-000000000004'$$,
    '%Password must be at least 12 characters%',
    'a real user setting an 11-character password is refused'
);
SELECT lives_ok(
    $$UPDATE auth.users SET email = 'anon-pw-d@test.local'
       WHERE id = 'e1000000-0000-4000-8000-000000000004'$$,
    'an update that leaves the password alone is not checked'
);
SELECT is(
    (SELECT string_agg(t.tgname || ':' || (t.tgqual IS NOT NULL)::text, ', ' ORDER BY t.tgname)
       FROM pg_trigger t
      WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
        AND t.tgfoid = 'public.check_password_length_on_auth_users()'::regprocedure),
    'check_password_length_insert_trigger:true, check_password_length_trigger:false',
    'the insert check skips an anonymous user by a condition; the update check has none'
);
SELECT ok(
    (SELECT p.prosecdef FROM pg_proc p
      WHERE p.oid = 'public.check_password_length_on_auth_users()'::regprocedure)
    AND NOT has_function_privilege('anon', 'public.check_password_length_on_auth_users()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.check_password_length_on_auth_users()', 'EXECUTE'),
    'the check is still a definer no client role may execute'
);

SELECT * FROM finish();
ROLLBACK;
