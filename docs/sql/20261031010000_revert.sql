-- Revert for 20261031010000_anonymous_signups_skip_password_check.sql
--
-- Restores `public.check_password_length_on_auth_users()` to the body 20240405180000 created (with the
-- `search_path = public` 20260421001209 pinned, and without the carriage returns and trailing blanks
-- the file carries): every INSERT into `auth.users` needs a `password_length` of 12 or more again, so
-- an anonymous sign-in fails again and the demo cannot start, and an UPDATE is checked only when
-- `encrypted_password <> OLD.encrypted_password` (never for a NULL one). Unset `VITE_DEMO_ENABLED`
-- first (the plan's rollback step 1). The trigger was never touched, so it is not recreated.
--
-- What it keeps: every anonymous user already created, and their `profiles` rows.
--
-- Verified: the harness compares md5 of the restored body with carriage returns and trailing blanks
-- removed (3a276b042eca8c7dab98bf46b26a55e2, the build's text at 20261030010000), the definer and
-- `search_path` settings, the unchanged trigger, and that an anonymous insert with no
-- `password_length` is refused again.

BEGIN;

CREATE OR REPLACE FUNCTION public.check_password_length_on_auth_users()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    pwd_len INT;
BEGIN
    -- Only check if the encrypted_password has changed (implies a new password is being set)
    IF (TG_OP = 'UPDATE' AND NEW.encrypted_password <> OLD.encrypted_password) OR (TG_OP = 'INSERT') THEN
        -- Extract password_length from raw_user_meta_data
        pwd_len := (NEW.raw_user_meta_data->>'password_length')::INT;

        -- Enforce minimum length of 12
        IF pwd_len IS NULL OR pwd_len < 12 THEN
            RAISE EXCEPTION 'Security Policy Violation: Password must be at least 12 characters. (Database Enforcement)';
        END IF;

        -- Cleanup: Remove password_length from metadata after check to keep it clean (Optional)
        -- NEW.raw_user_meta_data := NEW.raw_user_meta_data - 'password_length';
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Security Policy Violation: Invalid password metadata or length. Detail: %', SQLERRM;
END;
$$;

DO $$
DECLARE
    v_md5 text;
BEGIN
    SELECT md5(regexp_replace(replace(p.prosrc, E'\r', ''), '[ \t]+$', '', 'gn')) INTO v_md5
      FROM pg_proc p WHERE p.oid = 'public.check_password_length_on_auth_users()'::regprocedure;
    IF v_md5 IS DISTINCT FROM '3a276b042eca8c7dab98bf46b26a55e2' THEN
        RAISE EXCEPTION 'the restored password-length check is not the 20240405180000 body (md5 %)', v_md5;
    END IF;
END;
$$;

COMMIT;
