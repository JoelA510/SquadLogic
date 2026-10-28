-- RLS invariant: the `facility-permits` storage bucket (20261102010000) is private, takes only
-- an admin's upload under a real permit's folder, and shows it to an admin only (since
-- 20261104010000 a coach, who no longer signs in, reads no permit file).
--
-- Callers (Org A unless noted): Alice admin (fixture); Bob admin of Org B (fixture); Charlie a
-- signed-in non-member (fixture); Cora, on a coach record as current coach of A-Team (a game at
-- Pitch 1), Otto of A2 (a practice at Pitch 3), Quin of A4 (Pitch 4, no permit) and Finn, whose
-- A-Team assignment ended yesterday, signed in and members of nothing; anon.
--
--   * an admin uploads <org>/<permit>/<uuid>.<ext> for a permit that exists in that organization;
--     a non-member, another organization's admin, anon, and a demo organization's admin are refused;
--   * a name that is not exactly that shape (no folder, a non-UUID folder, a permit that does not
--     exist, a wrong extension, a missing level) is refused with 42501, never 22P02 (a cast);
--   * an admin reads every object, replaced ones included; Cora and Otto, whose teams are scheduled
--     on permitted fields, Quin, Finn, Charlie, another organization's admin and anon read none;
--   * an update, even by an admin, changes nothing, and there is no UPDATE policy;
--   * the policies are exactly an admin INSERT and DELETE and a SELECT, for authenticated. The
--     DELETE is held from pg_policies only: Supabase's storage.protect_delete() refuses every
--     SQL delete on storage.objects (see storage_exports_bucket.sql).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(28);

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
    ('e1000000-0000-4000-8000-000000000002', 'cora@test.local', '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000003', 'finn@test.local', '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000004', 'otto@test.local', '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000005', 'quin@test.local', '{"password_length": 12}', now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name) VALUES
    ('e1000000-0000-4000-8000-000000000002', 'cora@test.local', 'Cora'),
    ('e1000000-0000-4000-8000-000000000003', 'finn@test.local', 'Finn'),
    ('e1000000-0000-4000-8000-000000000004', 'otto@test.local', 'Otto'),
    ('e1000000-0000-4000-8000-000000000005', 'quin@test.local', 'Quin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000a2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'A2'),
    ('aaaaaaaa-0000-0000-0000-0000000000a3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'A3'),
    ('aaaaaaaa-0000-0000-0000-0000000000a4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'A4');
INSERT INTO public.coaches (id, organization_id, full_name, email, status) VALUES
    ('e2000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111', 'Cora', 'cora@test.local', 'active'),
    ('e2000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'Finn', 'finn@test.local', 'active'),
    ('e2000000-0000-4000-8000-000000000004', 'a1111111-1111-1111-1111-111111111111', 'Otto', 'otto@test.local', 'active'),
    ('e2000000-0000-4000-8000-000000000005', 'a1111111-1111-1111-1111-111111111111', 'Quin', 'quin@test.local', 'active');
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
VALUES
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'e2000000-0000-4000-8000-000000000002', 'lead',
     public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001') - 30, NULL, 'pgtap', NULL),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'e2000000-0000-4000-8000-000000000003', 'assistant',
     public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001') - 30,
     public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001') - 1, 'pgtap', 'pgtap'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'e2000000-0000-4000-8000-000000000004', 'lead',
     public.team_local_today('aaaaaaaa-0000-0000-0000-0000000000a2') - 30, NULL, 'pgtap', NULL),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a4', 'e2000000-0000-4000-8000-000000000005', 'lead',
     public.team_local_today('aaaaaaaa-0000-0000-0000-0000000000a4') - 30, NULL, 'pgtap', NULL);

INSERT INTO public.locations (id, organization_id, name, lighting_available) VALUES
    ('f1000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'Permit Park', false);
INSERT INTO public.fields (id, organization_id, location_id, name, active) VALUES
    ('f1000000-0000-4000-8000-000000000011', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000001', 'Pitch 1', true),
    ('f1000000-0000-4000-8000-000000000013', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000001', 'Pitch 3', true),
    ('f1000000-0000-4000-8000-000000000014', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000001', 'Pitch 4', true);
INSERT INTO public.game_slots (id, organization_id, field_id, slot_date, week_index) VALUES
    ('f2000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000011', current_date + 7, 1),
    ('f2000000-0000-4000-8000-000000000004', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000014', current_date + 7, 1);
INSERT INTO public.games (id, organization_id, game_slot_id, home_team_id, away_team_id) VALUES
    ('f3000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'f2000000-0000-4000-8000-000000000001',
     'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a3'),
    ('f3000000-0000-4000-8000-000000000004', 'a1111111-1111-1111-1111-111111111111', 'f2000000-0000-4000-8000-000000000004',
     'aaaaaaaa-0000-0000-0000-0000000000a4', 'aaaaaaaa-0000-0000-0000-0000000000a3');
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time) VALUES
    ('f4000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000013', 'mon', '18:00', '19:00');
INSERT INTO public.practice_assignments (id, organization_id, team_id, practice_slot_id, slot_id, effective_date_range) VALUES
    ('f5000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a2',
     'f4000000-0000-4000-8000-000000000003', 'f4000000-0000-4000-8000-000000000003', daterange(current_date, current_date + 60, '[]'));

-- Two permits: PA covers Pitch 1 and has a live file (its first file was replaced); PB covers Pitch 3
-- and has a live file. Pitch 4 (Quin's) has none. A third, PD, belongs to a demo organization.
INSERT INTO public.facility_permits (id, organization_id, issuer, valid_from, valid_to, file_path, file_name, file_mime, file_size) VALUES
    ('f6000000-0000-4000-8000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'Permit A', current_date - 10, current_date + 100,
     'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-000000000002.pdf', 'a.pdf', 'application/pdf', 1000),
    ('f6000000-0000-4000-8000-00000000000b', 'a1111111-1111-1111-1111-111111111111', 'Permit B', current_date - 10, current_date + 100,
     'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000b/c0000000-0000-4000-8000-000000000003.pdf', 'b.pdf', 'application/pdf', 1000);
INSERT INTO public.facility_permit_scopes (permit_id, organization_id, field_id) VALUES
    ('f6000000-0000-4000-8000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000011'),
    ('f6000000-0000-4000-8000-00000000000b', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000013');

-- The objects, as the Storage API would have stored them: A's replaced first file, A's live file, B's
-- live file, and an orphan under a permit folder that holds no permit.
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
    ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-000000000001.pdf', '{"size": 1000, "mimetype": "application/pdf"}'),
    ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-000000000002.pdf', '{"size": 1000, "mimetype": "application/pdf"}'),
    ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000b/c0000000-0000-4000-8000-000000000003.pdf', '{"size": 1000, "mimetype": "application/pdf"}'),
    ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-0000000000ee/c0000000-0000-4000-8000-000000000009.pdf', '{"size": 1000, "mimetype": "application/pdf"}');

-- ── 1. The bucket ─────────────────────────────────────────────────────────
SELECT is((SELECT public FROM storage.buckets WHERE id = 'facility-permits'), false, 'the facility-permits bucket exists and is private');
SELECT is((SELECT file_size_limit FROM storage.buckets WHERE id = 'facility-permits'), 10485760::bigint, 'it takes at most 10 MiB');
SELECT is((SELECT array_agg(t ORDER BY t) FROM storage.buckets b, unnest(b.allowed_mime_types) t WHERE b.id = 'facility-permits'),
          ARRAY['application/pdf', 'image/jpeg', 'image/png'], 'and only PDF, JPEG and PNG');

-- ── 2. Uploads ────────────────────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT lives_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-000000000010.pdf')$$,
    'an Org A admin uploads under a real permit''s folder');
SELECT lives_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000a/C0000000-0000-4000-8000-000000000011.JPG')$$,
    'the extension is read without regard to case');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-0000000000ee/c0000000-0000-4000-8000-000000000012.pdf')$$,
    '42501', NULL, 'an upload under a folder that holds no permit is refused');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-000000000013.html')$$,
    '42501', NULL, 'an extension outside pdf, jpg, jpeg and png is refused');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000a/scan.pdf')$$,
    '42501', NULL, 'a file name that is not a UUID is refused');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'a1111111-1111-1111-1111-111111111111/c0000000-0000-4000-8000-000000000014.pdf')$$,
    '42501', NULL, 'a name with no permit folder is refused');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'not-an-org/f6000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-000000000015.pdf')$$,
    '42501', NULL, 'a folder that is not a UUID is refused by the policy, not by a cast error');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'a1111111-1111-1111-1111-111111111111/not-a-permit/c0000000-0000-4000-8000-000000000016.pdf')$$,
    '42501', NULL, 'a permit folder that is not a UUID is refused by the policy, not by a cast error');

SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000002"}';
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-000000000017.pdf')$$,
    '42501', NULL, 'a signed-in non-member on a coach record cannot upload');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-000000000018.pdf')$$,
    '42501', NULL, 'another organization''s admin cannot upload under Org A''s permit');
SET LOCAL role = 'anon';
SET LOCAL "request.jwt.claims" TO '{"role":"anon"}';
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'a1111111-1111-1111-1111-111111111111/f6000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-000000000019.pdf')$$,
    '42501', NULL, 'anon cannot upload');

-- A demo organization takes no object: the purge could not clean it (20261030010000's reasoning).
RESET role;
INSERT INTO public.organizations (id, name, slug, demo_expires_at, demo_owner)
VALUES ('d4000000-0000-4000-8000-0000000000d1', 'Demo Org', 'demo-org-permit-pgtap', now() + interval '1 hour', '11111111-1111-1111-1111-111111111111');
INSERT INTO public.organization_members (organization_id, profile_id, role)
VALUES ('d4000000-0000-4000-8000-0000000000d1', '11111111-1111-1111-1111-111111111111', 'admin');
INSERT INTO public.facility_permits (id, organization_id, issuer, valid_from, valid_to)
VALUES ('d4000000-0000-4000-8000-0000000000d2', 'd4000000-0000-4000-8000-0000000000d1', 'Demo permit', current_date, current_date + 10);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT ok(public.is_org_admin('d4000000-0000-4000-8000-0000000000d1'), 'control: Alice is an admin of the live demo organization');
SELECT throws_ok($$INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', 'd4000000-0000-4000-8000-0000000000d1/d4000000-0000-4000-8000-0000000000d2/c0000000-0000-4000-8000-000000000020.pdf')$$,
    '42501', NULL, 'a demo organization''s admin cannot upload');

-- ── 3. Reads ──────────────────────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'facility-permits' AND name LIKE 'a1111111-%'), 6,
          'an admin reads every Org A object: the four seeded and the two they uploaded, replaced and orphaned files included');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000002"}';
SELECT is((SELECT array_agg(right(name, 40) ORDER BY name) FROM storage.objects WHERE bucket_id = 'facility-permits'),
          NULL, 'Cora, the current coach of the team playing at Pitch 1, reads no file');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000004"}';
SELECT is((SELECT array_agg(right(name, 40) ORDER BY name) FROM storage.objects WHERE bucket_id = 'facility-permits'),
          NULL, 'Otto, whose team practises at Pitch 3, reads no file');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000005"}';
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'facility-permits'), 0, 'Quin reads none');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000003"}';
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'facility-permits'), 0, 'a former coach reads none');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'facility-permits'), 0, 'Charlie, a member of nothing, reads none');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'facility-permits'), 0, 'another organization''s admin reads none');
SET LOCAL role = 'anon';
SET LOCAL "request.jwt.claims" TO '{"role":"anon"}';
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'facility-permits'), 0, 'anon reads none');

-- ── 4. No update; the policy set ──────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
UPDATE storage.objects SET name = name || '.renamed' WHERE bucket_id = 'facility-permits';
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'facility-permits' AND name LIKE '%.renamed'), 0,
          'an update by an admin changes nothing');
SELECT is((SELECT array_agg(cmd || ' ' || array_to_string(roles, ',') ORDER BY cmd)
             FROM pg_policies
            WHERE schemaname = 'storage' AND tablename = 'objects'
              AND (policyname LIKE 'facility-permits%' OR qual LIKE '%''facility-permits''%' OR with_check LIKE '%''facility-permits''%')),
          ARRAY['DELETE authenticated', 'INSERT authenticated', 'SELECT authenticated'],
          'the policies are a DELETE, an INSERT and a SELECT for authenticated, with no UPDATE or ALL');
SELECT is((SELECT array_agg(
                cmd || ' ' ||
                CASE
                    WHEN coalesce(qual, with_check) LIKE '%is_org_admin(((storage.foldername(name))[1])::uuid)%'
                         AND coalesce(qual, with_check) LIKE '%coach_reads_facility_permit_file(%' THEN 'admin or scheduled coach'
                    WHEN coalesce(qual, with_check) LIKE '%is_org_admin(((storage.foldername(name))[1])::uuid)%'
                         AND coalesce(qual, with_check) LIKE '%is_demo_org(%' THEN 'admin, not a demo'
                    WHEN coalesce(qual, with_check) LIKE '%is_org_admin(((storage.foldername(name))[1])::uuid)%' THEN 'admin'
                    ELSE 'neither: ' || coalesce(qual, with_check)
                END ORDER BY cmd)
             FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'facility-permits%'),
          ARRAY['DELETE admin', 'INSERT admin, not a demo', 'SELECT admin'],
          'an admin removes, uploads (not for a demo) and reads, and no coach arm remains');

RESET role;
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'facility-permits' AND name LIKE 'd4000000-%'), 0, 'the demo upload that was refused is not there');

SELECT * FROM finish();
ROLLBACK;
