-- Drop the coach's sign-in link: `coaches.user_id` and `coaches.profile_id` (plan
-- docs/changes/2026-10-27-admin-only.md, PR 2; owner decisions 2026-10-27, including 6: drop
-- `profile_id` with `user_id`).
--
-- **Why.** No coach signs in. Everything that read `coaches.user_id` (the self read policies, the
-- coached-team helpers, `link_my_coach_record`) was removed by 20261104010000, which also replaced
-- `reconcile_prod_rls_drift()` so its probe `CREATE POLICY` no longer names the column. Production
-- held (read-only, 2026-10-27) `user_id` on exactly one of 130 coaches, the admin's own account, and
-- `profile_id` on none. The one link is lost; the account itself, its profile and its membership
-- are untouched (the foreign key was ON DELETE SET NULL, one way).
--
-- **Why apart.** `user_id` has a foreign key to `auth.users`, a table `postgres` does not own in
-- production (it belongs to `supabase_auth_admin`). A plain `DROP TRIGGER` on `auth.users` has
-- failed there before. Dropping a column is DDL on `public.coaches`, which `postgres` owns, and the
-- constraint triggers a foreign key keeps on the referenced table go with the constraint without a
-- statement on `auth.users`; but a refusal here must not undo the role and policy work, so this is
-- its own migration. If production refuses it: the first migration stands, and this one is replaced
-- by "NULL the column, drop its unique" with the column recorded as dead.
--
-- **The change.** `ALTER TABLE public.coaches DROP COLUMN user_id` (its foreign key
-- `coaches_user_id_fkey` and its unique `coaches_user_id_key` go with it) and `DROP COLUMN IF EXISTS
-- profile_id` (its foreign key to `profiles` goes with it; the repository's own build has the column
-- from 20260331000000, so the statement is not a no-op there). No CASCADE: a policy, view or index
-- that still needed either column fails the migration. An end-state check follows.
--
-- Reversible in structure only: docs/sql/20261104020000_revert.sql adds both columns back, empty,
-- with their keys. Smoke: docs/sql/20261104020000_smoke.sql. pgTAP: supabase/tests/admin_only.sql.

BEGIN;

DO $$
DECLARE
    v_user bigint;
    v_profile bigint := 0;
BEGIN
    SELECT count(*) INTO v_user FROM public.coaches WHERE user_id IS NOT NULL;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'coaches' AND column_name = 'profile_id') THEN
        EXECUTE 'SELECT count(*) FROM public.coaches WHERE profile_id IS NOT NULL' INTO v_profile;
    END IF;
    RAISE NOTICE 'dropping coaches.user_id (set on % coach(es)) and coaches.profile_id (set on %); the links cannot be restored',
        v_user, v_profile;
END;
$$;

ALTER TABLE public.coaches DROP COLUMN user_id;
ALTER TABLE public.coaches DROP COLUMN IF EXISTS profile_id;

DO $$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(attname, ', ') INTO v_bad
      FROM pg_attribute
     WHERE attrelid = 'public.coaches'::regclass AND attnum > 0 AND NOT attisdropped
       AND attname IN ('user_id', 'profile_id');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'public.coaches still has %', v_bad;
    END IF;
    SELECT string_agg(conname, ', ') INTO v_bad
      FROM pg_constraint
     WHERE conrelid = 'public.coaches'::regclass
       AND conname IN ('coaches_user_id_fkey', 'coaches_user_id_key', 'coaches_profile_id_fkey');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'public.coaches still has the constraint(s) %', v_bad;
    END IF;
    -- The coach key of 20261104010000 stands.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.coaches'::regclass AND conname = 'coaches_organization_id_email_key') THEN
        RAISE EXCEPTION 'coaches_organization_id_email_key is missing';
    END IF;
END;
$$;

COMMIT;
