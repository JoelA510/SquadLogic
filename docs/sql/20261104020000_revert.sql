-- Revert for 20261104020000_drop_coach_user_link.sql
--
-- Adds `coaches.user_id` (a foreign key to `auth.users` ON DELETE SET NULL, and unique) and
-- `coaches.profile_id` (a foreign key to `profiles` ON DELETE SET NULL) back, empty, with the
-- constraint names they had (`coaches_user_id_fkey`, `coaches_user_id_key`,
-- `coaches_profile_id_fkey`). The columns come back at the end of the table, which nothing
-- depends on.
--
-- **It cannot restore the links.** Production held one (`user_id` on the admin's own coach record,
-- and a `coach.linked` audit row for it) and none on `profile_id`; the NOTICE below counts what
-- the table holds, which is always zero, since the columns did not exist. Nothing reads either
-- column until 20261104010000 is reverted too: revert this migration first, then that one (its
-- restored coach arms read `coaches.user_id`).
--
-- Verified: the harness compares a fingerprint of the columns and the three constraints with
-- the one read off a build at 20261104010000.

BEGIN;

DO $$
BEGIN
    RAISE NOTICE 'this revert adds coaches.user_id and coaches.profile_id back EMPTY; the sign-in link that was dropped cannot be restored';
END;
$$;

ALTER TABLE public.coaches ADD COLUMN user_id uuid;
ALTER TABLE public.coaches ADD COLUMN profile_id uuid;

ALTER TABLE public.coaches ADD CONSTRAINT coaches_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL;
ALTER TABLE public.coaches ADD CONSTRAINT coaches_user_id_key UNIQUE (user_id);
ALTER TABLE public.coaches ADD CONSTRAINT coaches_profile_id_fkey
    FOREIGN KEY (profile_id) REFERENCES public.profiles (id) ON DELETE SET NULL;

COMMIT;
