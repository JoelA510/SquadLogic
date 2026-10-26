-- An anonymous sign-in is not a password (demo mode, plan
-- docs/changes/2026-10-22-demo-mode.md, D4; owner decision 2026-10-26).
--
-- **Why.** `check_password_length_trigger` (BEFORE INSERT OR UPDATE on `auth.users`, 20240405180000)
-- calls `public.check_password_length_on_auth_users()`, which refuses any insert whose
-- `raw_user_meta_data` lacks a `password_length` of at least 12. An anonymous sign-in
-- (`signInAnonymously`) creates a user with no password and no metadata, so every anonymous sign-in
-- failed and the demo could not start. The client does not fake a `password_length` (that would make
-- the policy a thing the browser can satisfy by lying); the check learns that an anonymous user has
-- no password to measure.
--
-- **What changes: the function only, no trigger DDL.** `auth.users` is owned by
-- `supabase_auth_admin`; the deploy role (`postgres`) holds only its TRIGGER privilege, so a
-- `DROP TRIGGER` or `CREATE TRIGGER` on it fails in production ("must be owner of relation users").
-- The function is `postgres`'s, so it is replaced in place, from its latest body (20240405180000;
-- `search_path` pinned by 20260421001209, restated here because CREATE OR REPLACE resets a
-- function's SET clauses), with two changes:
--   1. An INSERT whose `NEW.is_anonymous` is true returns at once. Nothing else is skipped: a
--      non-anonymous insert without a `password_length` of 12 or more is refused as before.
--   2. The UPDATE test is `NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password`, not
--      `<>`. An anonymous user has a NULL password, and `NULL <> 'x'` is NULL, so the old test never
--      fired for the first password an anonymous user sets: it went unchecked. Now that change is
--      checked like any other, anonymous user or not (it needs a `password_length` of 12 or more in
--      the same update, which is what the app sends with a new password,
--      `AuthContext.updatePassword`). A real user's change of password behaves as before.
-- The trigger, its events, the function's grants and the other trigger on this table
-- (`on_auth_user_created`) are not touched.
--
-- **The starting body is checked.** Production's function text (read 2026-10-26) is the repository's
-- with its comments stripped, the same logic; its `prosrc` md5 is `bfc595ef5b1716f20b70f5182f4d5bf4`.
-- A build from the repository holds the file's text: `57d76d793fc197f2eb30ed703f9484f5` (the file has
-- CRLF line ends), or `be77982e229de6bf3d2c11da747ecbc0` with the carriage returns removed; the revert
-- script restores `3a276b042eca8c7dab98bf46b26a55e2` (also without trailing blanks), so a revert can be
-- followed by this migration again. The migration refuses to replace a body whose md5 is none of those
-- four, rather than overwrite a function it has not seen.
--
-- **The other `auth.users` trigger.** `on_auth_user_created` (AFTER INSERT, 20260421022121) runs
-- `handle_new_user()`, which upserts a `profiles` row from the new user. `profiles.email` is
-- nullable (that migration dropped the NOT NULL for phone and social sign-ups), so an anonymous
-- user, whose email is NULL, gets a profile with a NULL email. The smoke and pgTAP insert an
-- anonymous user and require it.
--
-- Revert: docs/sql/20261031010000_revert.sql. Smoke: docs/sql/20261031010000_smoke.sql.
-- pgTAP: supabase/tests/anonymous_signup_password_check.sql.

BEGIN;

DO $$
DECLARE
    v_md5 text;
BEGIN
    SELECT md5(p.prosrc) INTO v_md5
      FROM pg_proc p WHERE p.oid = 'public.check_password_length_on_auth_users()'::regprocedure;
    IF v_md5 NOT IN ('bfc595ef5b1716f20b70f5182f4d5bf4',   -- production, read 2026-10-26
                     '57d76d793fc197f2eb30ed703f9484f5',   -- built from 20240405180000 (CRLF)
                     'be77982e229de6bf3d2c11da747ecbc0',   -- the same without carriage returns
                     '3a276b042eca8c7dab98bf46b26a55e2')   -- as the revert script restores it
    THEN
        RAISE EXCEPTION 'check_password_length_on_auth_users() has a body this migration has not seen (md5 %): not replacing it', v_md5;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_password_length_on_auth_users()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    pwd_len INT;
BEGIN
    -- An anonymous sign-in sets no password, so there is none to measure. INSERT only: an anonymous
    -- user who later sets one is an UPDATE of encrypted_password and is checked below.
    IF TG_OP = 'INSERT' AND NEW.is_anonymous IS TRUE THEN
        RETURN NEW;
    END IF;

    -- Only check if the encrypted_password has changed (implies a new password is being set).
    -- IS DISTINCT FROM, not <>: an anonymous user's password is NULL until they set one.
    IF (TG_OP = 'UPDATE' AND NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password) OR (TG_OP = 'INSERT') THEN
        -- Extract password_length from raw_user_meta_data
        pwd_len := (NEW.raw_user_meta_data->>'password_length')::INT;

        -- Enforce minimum length of 12
        IF pwd_len IS NULL OR pwd_len < 12 THEN
            RAISE EXCEPTION 'Security Policy Violation: Password must be at least 12 characters. (Database Enforcement)';
        END IF;
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Security Policy Violation: Invalid password metadata or length. Detail: %', SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------------
-- End state.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_src text;
    v_defs text;
BEGIN
    SELECT p.prosrc INTO v_src
      FROM pg_proc p
     WHERE p.oid = 'public.check_password_length_on_auth_users()'::regprocedure
       AND p.prosecdef
       AND p.prorettype = 'trigger'::regtype
       AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public');
    IF v_src IS NULL THEN
        RAISE EXCEPTION 'the password-length check is not a trigger-returning definer with search_path=public';
    END IF;
    IF v_src NOT LIKE '%TG_OP = ''INSERT'' AND NEW.is_anonymous IS TRUE%' THEN
        RAISE EXCEPTION 'the password-length check does not skip an anonymous INSERT';
    END IF;
    IF v_src NOT LIKE '%NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password%'
       OR v_src LIKE '%encrypted_password <> OLD.encrypted_password%'
       OR v_src NOT LIKE '%pwd_len IS NULL OR pwd_len < 12%' THEN
        RAISE EXCEPTION 'the password-length check lost its UPDATE rule or its length rule';
    END IF;

    -- The one original trigger, untouched.
    SELECT string_agg(pg_get_triggerdef(t.oid), E'\n' ORDER BY t.tgname) INTO v_defs
      FROM pg_trigger t
     WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
       AND t.tgfoid = 'public.check_password_length_on_auth_users()'::regprocedure;
    IF v_defs IS DISTINCT FROM 'CREATE TRIGGER check_password_length_trigger BEFORE INSERT OR UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION check_password_length_on_auth_users()'
       OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                       WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'check_password_length_trigger'
                         AND t.tgenabled = 'O') THEN
        RAISE EXCEPTION 'check_password_length_trigger is not the one enabled BEFORE INSERT OR UPDATE trigger: %', v_defs;
    END IF;
END;
$$;

COMMIT;
