-- Smoke checks for 20261031010000_anonymous_signups_skip_password_check.sql
--
-- Run on the database built to head, so they hold for every later migration. What it proves, by
-- inserting into and updating the harness's `auth.users` (the trigger is the real one):
--   * posture: the check function is untouched (a definer with search_path=public, no client role may
--     execute it); `check_password_length_insert_trigger` is an enabled BEFORE INSERT row trigger on
--     auth.users with a condition that skips exactly an anonymous user, and
--     `check_password_length_trigger` an enabled, unconditional BEFORE UPDATE row trigger;
--   * an anonymous INSERT (no email, no metadata) is accepted, and `on_auth_user_created` gives it a
--     `profiles` row with a NULL email;
--   * a non-anonymous INSERT with no `password_length`, with 11, or with a non-number is refused, and
--     with 12 is accepted (the refusals are the controls: a check that refused nothing would show here);
--   * an UPDATE that changes `encrypted_password` is still checked, for an anonymous user too: refused
--     without a `password_length` of 12, accepted with one; an UPDATE that leaves the password alone
--     is not checked.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages. Every id is generated, every
-- email `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- Runs a statement and returns 'ok' or the first line of the error it raised, so a refusal is data.
CREATE FUNCTION pg_temp.attempt(p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
BEGIN
    EXECUTE p_sql;
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN left(SQLERRM, 300);
END;
$f$;

DO $$
DECLARE
    v_anon uuid := gen_random_uuid();
    v_anon2 uuid := gen_random_uuid();
    v_real uuid := gen_random_uuid();
    v_r text;
    v_email text;
BEGIN
    -- Posture.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = 'public.check_password_length_on_auth_users()'::regprocedure
                      AND p.prosecdef
                      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public')) THEN
        RAISE EXCEPTION 'the password-length check is not a definer with search_path=public';
    END IF;
    IF has_function_privilege('anon', 'public.check_password_length_on_auth_users()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.check_password_length_on_auth_users()', 'EXECUTE') THEN
        RAISE EXCEPTION 'a client role may execute the password-length trigger function';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'check_password_length_insert_trigger'
                      AND t.tgenabled = 'O' AND (t.tgtype & 1) <> 0 AND (t.tgtype & 2) <> 0
                      AND (t.tgtype & 4) <> 0 AND (t.tgtype & (8 | 16 | 32)) = 0
                      AND t.tgqual IS NOT NULL
                      AND pg_get_triggerdef(t.oid) LIKE '%WHEN (%is_anonymous IS NOT TRUE%') THEN
        RAISE EXCEPTION 'check_password_length_insert_trigger is not the BEFORE INSERT trigger that skips an anonymous user';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'check_password_length_trigger'
                      AND t.tgenabled = 'O' AND (t.tgtype & 1) <> 0 AND (t.tgtype & 2) <> 0
                      AND (t.tgtype & 16) <> 0 AND (t.tgtype & (4 | 8 | 32)) = 0
                      AND t.tgqual IS NULL) THEN
        RAISE EXCEPTION 'check_password_length_trigger is not an unconditional BEFORE UPDATE trigger';
    END IF;

    -- An anonymous insert passes, and the profile trigger accepts its NULL email.
    v_r := pg_temp.attempt(format($q$INSERT INTO auth.users (id, email, is_anonymous) VALUES (%L, NULL, true)$q$, v_anon));
    IF v_r <> 'ok' THEN RAISE EXCEPTION 'an anonymous insert was refused: %', v_r; END IF;
    SELECT p.email INTO v_email FROM public.profiles p WHERE p.id = v_anon;
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_anon) OR v_email IS NOT NULL THEN
        RAISE EXCEPTION 'an anonymous user did not get a profile with a NULL email (on_auth_user_created)';
    END IF;
    v_r := pg_temp.attempt(format($q$INSERT INTO auth.users (id, email, raw_user_meta_data, is_anonymous)
                                     VALUES (%L, NULL, '{"password_length": 3}', true)$q$, v_anon2));
    IF v_r <> 'ok' THEN RAISE EXCEPTION 'an anonymous insert carrying a short password_length was refused: %', v_r; END IF;

    -- A non-anonymous insert is still checked.
    v_r := pg_temp.attempt(format($q$INSERT INTO auth.users (id, email, is_anonymous)
                                     VALUES (%L, 'smoke-pw-a@example.test', false)$q$, gen_random_uuid()));
    IF v_r NOT LIKE '%Password must be at least 12 characters%' THEN
        RAISE EXCEPTION 'a non-anonymous insert with no password_length was not refused: %', v_r;
    END IF;
    v_r := pg_temp.attempt(format($q$INSERT INTO auth.users (id, email, raw_user_meta_data)
                                     VALUES (%L, 'smoke-pw-b@example.test', '{"password_length": 11}')$q$, gen_random_uuid()));
    IF v_r NOT LIKE '%Password must be at least 12 characters%' THEN
        RAISE EXCEPTION 'a non-anonymous insert with password_length 11 was not refused: %', v_r;
    END IF;
    v_r := pg_temp.attempt(format($q$INSERT INTO auth.users (id, email, raw_user_meta_data)
                                     VALUES (%L, 'smoke-pw-c@example.test', '{"password_length": "many"}')$q$, gen_random_uuid()));
    IF v_r NOT LIKE '%Invalid password metadata or length%' THEN
        RAISE EXCEPTION 'a non-anonymous insert with a non-numeric password_length was not refused: %', v_r;
    END IF;
    v_r := pg_temp.attempt(format($q$INSERT INTO auth.users (id, email, raw_user_meta_data)
                                     VALUES (%L, 'smoke-pw-d@example.test', '{"password_length": 12}')$q$, v_real));
    IF v_r <> 'ok' THEN RAISE EXCEPTION 'a non-anonymous insert with password_length 12 was refused: %', v_r; END IF;

    -- An UPDATE of the password is still checked, for an anonymous user as for anyone.
    v_r := pg_temp.attempt(format($q$UPDATE auth.users SET encrypted_password = 'changed-1' WHERE id = %L$q$, v_anon));
    IF v_r NOT LIKE '%Password must be at least 12 characters%' THEN
        RAISE EXCEPTION 'an anonymous user setting a password with no password_length was not refused: %', v_r;
    END IF;
    v_r := pg_temp.attempt(format($q$UPDATE auth.users SET encrypted_password = 'changed-2',
                                         raw_user_meta_data = '{"password_length": 12}' WHERE id = %L$q$, v_anon));
    IF v_r <> 'ok' THEN RAISE EXCEPTION 'an anonymous user setting a 12-character password was refused: %', v_r; END IF;
    v_r := pg_temp.attempt(format($q$UPDATE auth.users SET encrypted_password = 'changed-3',
                                         raw_user_meta_data = '{"password_length": 11}' WHERE id = %L$q$, v_real));
    IF v_r NOT LIKE '%Password must be at least 12 characters%' THEN
        RAISE EXCEPTION 'a real user setting an 11-character password was not refused: %', v_r;
    END IF;
    -- An update that leaves the password alone is not checked.
    v_r := pg_temp.attempt(format($q$UPDATE auth.users SET email = 'smoke-pw-e@example.test' WHERE id = %L$q$, v_real));
    IF v_r <> 'ok' THEN RAISE EXCEPTION 'an update that leaves the password alone was refused: %', v_r; END IF;
END;
$$;

ROLLBACK;
