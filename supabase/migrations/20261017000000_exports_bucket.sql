-- The `exports` storage bucket and its `storage.objects` policies, which the
-- Exports page's "Upload to Storage" writes to (OutputGenerationPanel ->
-- uploadScheduleExport, packages/core/src/storageSupabase.js).
--
-- **Why.** No migration created the bucket, so a database built from this
-- repository (pgTAP, the real-backend E2E, a fresh project) has none, and
-- production, which has one made by hand (private, empty, created 2025-12-06),
-- has no `storage.objects` policy for it: only `raw-imports` has policies
-- (read-only SELECTs on storage.buckets and pg_policies, 2026-10-14 and
-- 2026-10-17). RLS on storage.objects denies by default, so every upload an
-- administrator made was refused. Recorded in the remediation plan's
-- "Discovered during execution" (w3d).
--
-- **The path convention.** Every object is stored under its organization:
-- `<organization_id>/<file>` (the master schedule) and
-- `<organization_id>/teams/<file>` (one per team), the convention
-- 20260421001043 set for `raw-imports`. The policies read the first folder of
-- the object's name: reading needs the caller to be a member of that
-- organization (`public.is_org_member()`, the helper every table policy uses,
-- docs/security/rls-policies.md), and uploading needs them to be one of its
-- administrators (`public.is_org_admin()`).
--
-- **A first folder that is not a UUID is refused, not an error.** The CASE
-- casts only a segment that has a UUID's shape, so a name with no folder or a
-- non-UUID folder evaluates to false (a 42501 RLS refusal) rather than raising
-- 22P02 from the cast, as the `raw-imports` policies would. CASE evaluates its
-- branches in order; AND does not promise to.
--
-- **No direct auth call in the policies.** They call `is_org_member()` and
-- `is_org_admin()`, SECURITY DEFINER helpers that read `auth.uid()` inside
-- their own query, so
-- there is no bare `auth.uid()` or `auth.role()` here for the
-- `auth_rls_initplan` advisor to flag (the Wave 2 RLS rewrite exists to remove
-- those). Both policies are `TO authenticated`, so the anonymous role has no
-- policy and is refused without evaluating anything.
--
-- **Members read, administrators upload, nothing else.** A member of the
-- organization may read (SELECT) its exports; only an administrator of it may
-- upload (INSERT), as only an administrator reaches the Exports page
-- (`MANAGE_ORGANIZATION`) and records the publication baseline beside the
-- upload (`admin_publish_schedule_baseline`, `is_org_admin`); a coach or a
-- parent cannot put a file where published schedules live. There is no
-- UPDATE or DELETE policy:
-- a published export is not rewritten or removed by an end user (retention,
-- if it is ever wanted, runs as the service role, which bypasses RLS, as for
-- `raw-imports` since 20260602010000). The client uploads with `upsert:
-- false` to match: an upsert would also need UPDATE.
--
-- **Private.** The insert creates the bucket private where it is missing and
-- the conflict branch sets `public = false` where it exists (production's
-- already is), so no copy of it is ever readable without a session.
--
-- Reversible: see docs/sql/20261017000000_revert.sql.
-- Smoke checks: see docs/sql/20261017000000_smoke.sql.
-- pgTAP: supabase/tests/storage_exports_bucket.sql.

BEGIN;

INSERT INTO storage.buckets (id, name, public)
    VALUES ('exports', 'exports', false)
    ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "exports org-member select" ON storage.objects;
CREATE POLICY "exports org-member select"
    ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'exports'
        AND CASE
            WHEN (storage.foldername(name))[1]
                 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN public.is_org_member(((storage.foldername(name))[1])::uuid)
            ELSE false
        END
    );

DROP POLICY IF EXISTS "exports org-admin insert" ON storage.objects;
CREATE POLICY "exports org-admin insert"
    ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'exports'
        AND CASE
            WHEN (storage.foldername(name))[1]
                 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN public.is_org_admin(((storage.foldername(name))[1])::uuid)
            ELSE false
        END
    );

COMMIT;
