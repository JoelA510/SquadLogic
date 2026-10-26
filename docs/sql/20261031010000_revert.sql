-- Revert for 20261031010000_anonymous_signups_skip_password_check.sql
--
-- Puts the one combined trigger back, as 20240405180000 created it:
--   CREATE TRIGGER check_password_length_trigger BEFORE INSERT OR UPDATE ON auth.users
--   FOR EACH ROW EXECUTE FUNCTION public.check_password_length_on_auth_users()
-- and drops the insert trigger the migration added. The function was never touched. Every INSERT
-- into `auth.users` is checked again, so an anonymous sign-in fails again and the demo cannot start:
-- unset `VITE_DEMO_ENABLED` first (the plan's rollback step 1).
--
-- What it keeps: every anonymous user already created, and their `profiles` rows.
--
-- Verified: the harness compares the trigger's definition with the one above, that nothing else
-- calls the function, that the function itself is as it was, and that an anonymous insert with no
-- `password_length` is refused again.

BEGIN;

DROP TRIGGER IF EXISTS check_password_length_insert_trigger ON auth.users;
DROP TRIGGER IF EXISTS check_password_length_trigger ON auth.users;

CREATE TRIGGER check_password_length_trigger
    BEFORE INSERT OR UPDATE ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.check_password_length_on_auth_users();

DO $$
DECLARE
    v_defs text;
BEGIN
    SELECT string_agg(pg_get_triggerdef(t.oid), E'\n' ORDER BY t.tgname) INTO v_defs
      FROM pg_trigger t
     WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
       AND t.tgfoid = 'public.check_password_length_on_auth_users()'::regprocedure;
    IF v_defs IS DISTINCT FROM 'CREATE TRIGGER check_password_length_trigger BEFORE INSERT OR UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION check_password_length_on_auth_users()' THEN
        RAISE EXCEPTION 'the password-length trigger is not the one 20240405180000 created: %', v_defs;
    END IF;
END;
$$;

COMMIT;
