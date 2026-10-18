-- Revert for 20261017000000_exports_bucket.sql
--
-- Drops the three `exports` policies (members' SELECT, administrators'
-- INSERT and DELETE), so `storage.objects` refuses every
-- end-user read and upload in the bucket again (RLS denies by default) and
-- "Upload to Storage" fails as it did before, with its error shown.
--
-- **The bucket and its objects stay.** Production had the bucket before this
-- migration (made by hand, 2025-12-06), so deleting it would not restore the
-- earlier state there, and it would destroy the exports already published.
-- A bucket this migration created on a fresh database stays too: private and
-- with no policy, no end user can reach it. Delete it by hand only when it is
-- empty and nothing will upload to it.
--
-- Verified: the transcript names the policies it dropped and fails if any
-- `exports` policy survives.

BEGIN;

DROP POLICY IF EXISTS "exports org-member select" ON storage.objects;
DROP POLICY IF EXISTS "exports org-admin insert" ON storage.objects;
DROP POLICY IF EXISTS "exports org-admin delete" ON storage.objects;

DO $revert$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(policyname, ', ') INTO v_left
      FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'exports%';
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'exports policies survived their own revert: %', v_left;
    END IF;
    RAISE NOTICE 'revert verified: no exports policy is left on storage.objects; the bucket (private) and its objects are kept';
END;
$revert$;

COMMIT;
