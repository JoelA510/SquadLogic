-- An anonymous sign-in is not a password (demo mode, plan
-- docs/changes/2026-10-22-demo-mode.md, D4; owner decision 2026-10-26).
--
-- **Why.** `check_password_length_trigger` (BEFORE INSERT OR UPDATE on `auth.users`, 20240405180000)
-- calls `public.check_password_length_on_auth_users()`, which in this repository refuses any insert
-- whose `raw_user_meta_data` lacks a `password_length` of at least 12. An anonymous sign-in
-- (`signInAnonymously`) creates a user with no password and no metadata, so with that trigger every
-- anonymous sign-in failed and the demo could not start. The client does not fake a
-- `password_length` (that would make the policy a thing the browser can satisfy by lying); the
-- check learns that an anonymous user has no password to measure.
--
-- **What changes: the trigger, not the function.** The one trigger becomes two, both calling the
-- same, untouched function:
--   * `check_password_length_insert_trigger`: BEFORE INSERT, `WHEN (NEW.is_anonymous IS NOT TRUE)`.
--     An anonymous insert never reaches the function; every other insert does, as before.
--   * `check_password_length_trigger` (same name): BEFORE UPDATE, no condition. An UPDATE that
--     changes `encrypted_password` is still checked, whoever the user is, so an anonymous user who
--     later sets a password must carry a `password_length` of 12 or more like anyone else.
-- Nothing else moves: the function, its grants and the other trigger on this table
-- (`on_auth_user_created`) are not touched. The skip is for `is_anonymous IS TRUE` only (a NULL is
-- not anonymous), and only on INSERT.
--
-- **Why not replace the function.** This migration was first written as a replacement of
-- `check_password_length_on_auth_users()` from the repository's text, which the convention asks to
-- check against production's by md5. Production's body was read on 2026-10-26 (enabled trigger,
-- body md5 `bfc595ef5b1716f20b70f5182f4d5bf4`) and equals neither the build's text
-- (`57d76d793fc197f2eb30ed703f9484f5`; `be77982e229de6bf3d2c11da747ecbc0` with the file's carriage
-- returns removed) nor any normalisation of it tried (blanks, comments, whitespace). And the
-- repository's body refuses every insert without a `password_length`, which the sign-up form
-- (`Login.jsx` sends none) would trip on, while production has confirmed a self sign-up since. So
-- production's text is probably not the repository's, and overwriting it could make sign-up stricter
-- (or just different) than it is today. A trigger condition cannot: it can only stop the existing
-- function from running on an anonymous insert.
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

DROP TRIGGER IF EXISTS check_password_length_trigger ON auth.users;

CREATE TRIGGER check_password_length_insert_trigger
    BEFORE INSERT ON auth.users
    FOR EACH ROW
    WHEN (NEW.is_anonymous IS NOT TRUE)
    EXECUTE FUNCTION public.check_password_length_on_auth_users();

CREATE TRIGGER check_password_length_trigger
    BEFORE UPDATE ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.check_password_length_on_auth_users();

-- ---------------------------------------------------------------------------
-- End state.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_insert pg_trigger%ROWTYPE;
    v_update pg_trigger%ROWTYPE;
    v_count integer;
BEGIN
    SELECT count(*) INTO v_count
      FROM pg_trigger t
     WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
       AND t.tgfoid = 'public.check_password_length_on_auth_users()'::regprocedure;
    IF v_count <> 2 THEN
        RAISE EXCEPTION 'expected two password-length triggers on auth.users, found %', v_count;
    END IF;

    SELECT * INTO v_insert FROM pg_trigger
     WHERE tgrelid = 'auth.users'::regclass AND tgname = 'check_password_length_insert_trigger';
    SELECT * INTO v_update FROM pg_trigger
     WHERE tgrelid = 'auth.users'::regclass AND tgname = 'check_password_length_trigger';

    -- INSERT only, before, per row, enabled, and skipped for an anonymous user and no one else.
    IF v_insert.oid IS NULL OR v_insert.tgenabled <> 'O'
       OR (v_insert.tgtype & 1) = 0 OR (v_insert.tgtype & 2) = 0
       OR (v_insert.tgtype & 4) = 0 OR (v_insert.tgtype & (8 | 16 | 32)) <> 0 THEN
        RAISE EXCEPTION 'check_password_length_insert_trigger is not an enabled BEFORE INSERT row trigger';
    END IF;
    IF v_insert.tgqual IS NULL
       OR pg_get_triggerdef(v_insert.oid) NOT LIKE '%WHEN (%is_anonymous IS NOT TRUE%' THEN
        RAISE EXCEPTION 'check_password_length_insert_trigger does not skip exactly an anonymous insert';
    END IF;

    -- UPDATE only, before, per row, enabled, and unconditional: an anonymous user is checked too.
    IF v_update.oid IS NULL OR v_update.tgenabled <> 'O'
       OR (v_update.tgtype & 1) = 0 OR (v_update.tgtype & 2) = 0
       OR (v_update.tgtype & 16) = 0 OR (v_update.tgtype & (4 | 8 | 32)) <> 0 THEN
        RAISE EXCEPTION 'check_password_length_trigger is not an enabled BEFORE UPDATE row trigger';
    END IF;
    IF v_update.tgqual IS NOT NULL THEN
        RAISE EXCEPTION 'check_password_length_trigger must check every update of the password, anonymous user or not';
    END IF;
END;
$$;

COMMIT;
