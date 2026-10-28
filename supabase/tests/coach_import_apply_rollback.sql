-- pgTAP: coach CSV imports stage, apply, and roll back through RPCs.
--
-- Since 20261104010000 a coach is one row per organization and email (the same address in
-- another organization is another coach, never a conflict), and the import names each coach's
-- children by player registration id: finalize_coach_import_job writes one coach_team_requests
-- row per id that matches a player of the SAME organization, reports an id that matches none
-- (never fatal), replaces the coach's links on a re-import and leaves them alone when the file
-- has no such column; rollback_coach_import_job puts back the links an update replaced.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(39);

INSERT INTO public.import_jobs (
    id, organization_id, job_type, storage_path, status, created_by, total_rows
)
VALUES
    (
        '11111111-3333-3333-3333-555555555551',
        'a1111111-1111-1111-1111-111111111111',
        'registration',
        'orga/coaches.csv',
        'importing',
        '11111111-1111-1111-1111-111111111111',
        2
    ),
    (
        '11111111-3333-3333-3333-555555555552',
        'a1111111-1111-1111-1111-111111111111',
        'registration',
        'orga/coaches-update.csv',
        'importing',
        '11111111-1111-1111-1111-111111111111',
        1
    );

INSERT INTO public.coaches (
    id,
    organization_id,
    full_name,
    email,
    phone,
    status,
    can_coach_multiple_teams,
    import_source
)
VALUES
    (
        'a1111111-1111-1111-1111-00000000c301',
        'a1111111-1111-1111-1111-111111111111',
        'Existing Interested',
        'interested@example.com',
        '555-0000',
        'interested',
        false,
        'player_import_lead'
    ),
    (
        'b2222222-2222-2222-2222-00000000c302',
        'b2222222-2222-2222-2222-222222222222',
        'Org B Coach',
        'shared@example.com',
        NULL,
        'active',
        false,
        'manual'
    );

INSERT INTO public.staging_import_rows (
    organization_id,
    import_job_id,
    import_type,
    source_row_number,
    raw_payload,
    normalized_payload,
    validation_errors
)
VALUES
    (
        'a1111111-1111-1111-1111-111111111111',
        '11111111-3333-3333-3333-555555555551',
        'coaches',
        1,
        '{"Coach Name":"New Coach","Email":"newcoach@example.com"}'::jsonb,
        jsonb_build_object(
            'full_name', 'New Coach',
            'email', 'newcoach@example.com',
            'phone', '555-1111',
            'certifications', 'SafeSport, CPR',
            'can_coach_multiple_teams', 'yes'
        ),
        '[]'::jsonb
    ),
    (
        'a1111111-1111-1111-1111-111111111111',
        '11111111-3333-3333-3333-555555555551',
        'coaches',
        2,
        '{"Coach Name":"Existing Active","Email":"interested@example.com"}'::jsonb,
        jsonb_build_object(
            'full_name', 'Existing Active',
            'email', 'interested@example.com',
            'phone', '555-2222'
        ),
        '[]'::jsonb
    ),
    (
        'a1111111-1111-1111-1111-111111111111',
        '11111111-3333-3333-3333-555555555552',
        'coaches',
        1,
        '{"Coach Name":"Conflict","Email":"shared@example.com"}'::jsonb,
        jsonb_build_object(
            'full_name', 'Conflict',
            'email', 'shared@example.com'
        ),
        '[]'::jsonb
    );

-- S7 seeds (as the owner): players of two organizations and four more jobs.
INSERT INTO public.players (id, organization_id, first_name, last_name, external_registration_id) VALUES
    ('a1111111-1111-1111-1111-0000000000c1', 'a1111111-1111-1111-1111-111111111111', 'Child', 'One', 'R-100'),
    ('a1111111-1111-1111-1111-0000000000c2', 'a1111111-1111-1111-1111-111111111111', 'Child', 'Two', 'R-200'),
    ('b2222222-2222-2222-2222-0000000000c3', 'b2222222-2222-2222-2222-222222222222', 'Elsewhere', 'Child', 'R-300');

INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, total_rows) VALUES
    ('11111111-3333-3333-3333-555555555553', 'a1111111-1111-1111-1111-111111111111', 'registration', 'orga/c1.csv', 'importing', '11111111-1111-1111-1111-111111111111', 1),
    ('11111111-3333-3333-3333-555555555554', 'a1111111-1111-1111-1111-111111111111', 'registration', 'orga/c2.csv', 'importing', '11111111-1111-1111-1111-111111111111', 1),
    ('11111111-3333-3333-3333-555555555555', 'a1111111-1111-1111-1111-111111111111', 'registration', 'orga/c3.csv', 'importing', '11111111-1111-1111-1111-111111111111', 1),
    ('11111111-3333-3333-3333-555555555556', 'a1111111-1111-1111-1111-111111111111', 'registration', 'orga/empty.csv', 'importing', '11111111-1111-1111-1111-111111111111', 0),
    ('11111111-3333-3333-3333-555555555557', 'a1111111-1111-1111-1111-111111111111', 'registration', 'orga/d1.csv', 'importing', '11111111-1111-1111-1111-111111111111', 2),
    ('11111111-3333-3333-3333-555555555558', 'a1111111-1111-1111-1111-111111111111', 'registration', 'orga/d2.csv', 'importing', '11111111-1111-1111-1111-111111111111', 2);

INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors) VALUES
    ('a1111111-1111-1111-1111-111111111111', '11111111-3333-3333-3333-555555555553', 'coaches', 1, '{}'::jsonb,
     jsonb_build_object('full_name', 'Linker Coach', 'email', 'linker@example.com',
                        'child_registration_id', ' R-200 ; R-100,R-999 , R-300, R-100 '), '[]'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', '11111111-3333-3333-3333-555555555554', 'coaches', 1, '{}'::jsonb,
     jsonb_build_object('full_name', 'Linker Coach', 'email', 'linker@example.com',
                        'child_registration_id', 'R-200'), '[]'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', '11111111-3333-3333-3333-555555555555', 'coaches', 1, '{}'::jsonb,
     jsonb_build_object('full_name', 'Linker Coach Renamed', 'email', 'linker@example.com'), '[]'::jsonb),
    -- Two coaches imported, then re-imported with other children; one is deleted before the
    -- re-import is rolled back.
    ('a1111111-1111-1111-1111-111111111111', '11111111-3333-3333-3333-555555555557', 'coaches', 1, '{}'::jsonb,
     jsonb_build_object('full_name', 'Gone Coach', 'email', 'gone@example.com', 'child_registration_id', 'R-100'), '[]'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', '11111111-3333-3333-3333-555555555557', 'coaches', 2, '{}'::jsonb,
     jsonb_build_object('full_name', 'Stays Coach', 'email', 'stays@example.com', 'child_registration_id', 'R-100'), '[]'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', '11111111-3333-3333-3333-555555555558', 'coaches', 1, '{}'::jsonb,
     jsonb_build_object('full_name', 'Gone Coach', 'email', 'gone@example.com', 'child_registration_id', 'R-200'), '[]'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', '11111111-3333-3333-3333-555555555558', 'coaches', 2, '{}'::jsonb,
     jsonb_build_object('full_name', 'Stays Coach', 'email', 'stays@example.com', 'child_registration_id', 'R-200'), '[]'::jsonb);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (public.finalize_coach_import_job(
        '11111111-3333-3333-3333-555555555551',
        '[]'::jsonb
    )->>'inserted_coaches')::int,
    1,
    'finalize_coach_import_job inserts a new coach'
);

SELECT is(
    (
        SELECT status
        FROM public.coaches
        WHERE email = 'interested@example.com'
    ),
    'active',
    'coach import promotes an interested lead to active'
);

SELECT is(
    (
        SELECT full_name
        FROM public.coaches
        WHERE email = 'interested@example.com'
    ),
    'Existing Active',
    'coach import updates an existing in-org coach'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.import_application_records
        WHERE import_job_id = '11111111-3333-3333-3333-555555555551'
          AND import_type = 'coaches'
    )::int,
    2,
    'coach import writes one application ledger row per applied coach'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.staging_import_rows
        WHERE import_job_id = '11111111-3333-3333-3333-555555555551'
          AND applied_at IS NOT NULL
    )::int,
    2,
    'staged coach rows are marked applied'
);

SELECT is(
    (
        SELECT status
        FROM public.import_jobs
        WHERE id = '11111111-3333-3333-3333-555555555551'
    ),
    'completed',
    'coach import job is completed after finalization'
);

SELECT is(
    (public.finalize_coach_import_job(
        '11111111-3333-3333-3333-555555555551',
        '[]'::jsonb
    )->>'inserted_coaches')::int,
    0,
    'coach import finalization is idempotent for the same job'
);

SELECT is(
    (public.finalize_coach_import_job(
        '11111111-3333-3333-3333-555555555552',
        '[]'::jsonb
    )->>'inserted_coaches')::int,
    1,
    'coach import of an email another organization already holds inserts a coach of this one'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.coaches
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND lower(email) = 'shared@example.com'
    )::int,
    1,
    'the same email is a coach row of this organization too'
);

SELECT is(
    (public.rollback_coach_import_job(
        '11111111-3333-3333-3333-555555555551'
    )->>'deleted_coaches')::int,
    1,
    'rollback deletes coaches inserted by the import'
);

SELECT is(
    (
        SELECT status
        FROM public.coaches
        WHERE id = 'a1111111-1111-1111-1111-00000000c301'
    ),
    'interested',
    'rollback restores the previous coach status'
);

SELECT is(
    (
        SELECT full_name
        FROM public.coaches
        WHERE id = 'a1111111-1111-1111-1111-00000000c301'
    ),
    'Existing Interested',
    'rollback restores the previous coach profile fields'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.import_application_records
        WHERE import_job_id = '11111111-3333-3333-3333-555555555551'
          AND rolled_back_at IS NOT NULL
    )::int,
    2,
    'rollback marks application ledger rows as rolled back'
);

SELECT throws_ok(
    $$
        SELECT public.rollback_coach_import_job(
            '11111111-3333-3333-3333-555555555556'
        )
    $$,
    '22023',
    NULL,
    'rollback rejects a coach import job with no applied coach records'
);


-- ── S7: the coach's children, by player registration id ───────────────────
SELECT is(
    (SELECT jsonb_build_object('linked', r->'linked_children', 'unmatched', r->'unmatched_child_id_count', 'status', r->>'status')
       FROM (SELECT public.finalize_coach_import_job('11111111-3333-3333-3333-555555555553', '[]'::jsonb) AS r) x),
    '{"linked": 2, "unmatched": 2, "status": "completed_with_warnings"}'::jsonb,
    'two ids that match make two links; two that match nothing are counted, and the job completes with warnings'
);

SELECT is(
    (SELECT string_agg(r.slot || ':' || p.external_registration_id, ',' ORDER BY r.slot)
       FROM public.coach_team_requests r JOIN public.players p ON p.id = r.player_id
      WHERE r.coach_id = (SELECT id FROM public.coaches WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND email = 'linker@example.com')),
    '1:R-200,2:R-100',
    'the links are written in the order the file lists the ids, a repeated id once'
);

SELECT is(
    (SELECT jsonb_agg(jsonb_build_object('rid', e->>'registration_id', 'coach', e->>'coach_id' = c.id::text) ORDER BY e->>'registration_id')
       FROM public.import_jobs j,
            jsonb_array_elements(j.warning_summary->'coach_finalize'->'unmatched_child_ids') e,
            public.coaches c
      WHERE j.id = '11111111-3333-3333-3333-555555555553'
        AND c.organization_id = 'a1111111-1111-1111-1111-111111111111' AND c.email = 'linker@example.com'),
    '[{"rid": "R-300", "coach": true}, {"rid": "R-999", "coach": true}]'::jsonb,
    'the result lists each unmatched id with its coach, among them another organization''s player, who is never linked'
);

SELECT is(
    (SELECT count(*) FROM public.coach_team_requests WHERE player_id = 'b2222222-2222-2222-2222-0000000000c3')::int,
    0,
    'another organization''s player is never linked'
);

SELECT is(
    (public.finalize_coach_import_job('11111111-3333-3333-3333-555555555554', '[]'::jsonb)->>'status'),
    'completed',
    'a re-import whose ids all match completes without warnings'
);

SELECT is(
    (SELECT string_agg(r.slot || ':' || p.external_registration_id, ',' ORDER BY r.slot)
       FROM public.coach_team_requests r JOIN public.players p ON p.id = r.player_id
      WHERE r.coach_id = (SELECT id FROM public.coaches WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND email = 'linker@example.com')),
    '1:R-200',
    'a re-import replaces the coach''s links'
);

SELECT is(
    (public.finalize_coach_import_job('11111111-3333-3333-3333-555555555555', '[]'::jsonb)->>'linked_children')::int,
    0,
    'a file without the column links nothing'
);

SELECT is(
    (SELECT count(*) FROM public.coach_team_requests
      WHERE coach_id = (SELECT id FROM public.coaches WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND email = 'linker@example.com'))::int,
    1,
    'and leaves the coach''s existing links alone'
);

SELECT is(
    (SELECT full_name FROM public.coaches WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND email = 'linker@example.com'),
    'Linker Coach Renamed',
    'the third import updated the coach it found by organization and email'
);

SELECT is(
    (public.rollback_coach_import_job('11111111-3333-3333-3333-555555555554')->>'restored_coaches')::int,
    1,
    'rolling back the re-import restores the coach'
);

SELECT is(
    (SELECT string_agg(r.slot || ':' || p.external_registration_id, ',' ORDER BY r.slot)
       FROM public.coach_team_requests r JOIN public.players p ON p.id = r.player_id
      WHERE r.coach_id = (SELECT id FROM public.coaches WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND email = 'linker@example.com')),
    '1:R-200,2:R-100',
    'and puts back the links the re-import replaced'
);

SELECT is(
    (public.rollback_coach_import_job('11111111-3333-3333-3333-555555555553')->>'deleted_coaches')::int,
    1,
    'rolling back the import that inserted the coach deletes it'
);

SELECT is(
    (SELECT count(*) FROM public.coach_team_requests r JOIN public.players p ON p.id = r.player_id
      WHERE p.organization_id = 'a1111111-1111-1111-1111-111111111111')::int,
    0,
    'and its links go with it'
);

SELECT is(
    (SELECT count(*) FROM public.players WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND external_registration_id IN ('R-100', 'R-200'))::int,
    2,
    'no player was touched'
);

-- A coach deleted after the re-import has nothing left to link: rolling the re-import back must not
-- abort on the foreign key, and the other coach it covered is restored.
SELECT is(
    (public.finalize_coach_import_job('11111111-3333-3333-3333-555555555557', '[]'::jsonb)->>'inserted_coaches')::int,
    2,
    'two coaches are imported with a child each'
);

SELECT is(
    (public.finalize_coach_import_job('11111111-3333-3333-3333-555555555558', '[]'::jsonb)->>'updated_coaches')::int,
    2,
    'a re-import gives each another child, replacing the first'
);

SELECT is(
    public.admin_delete_coaches(ARRAY(SELECT id FROM public.coaches
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND email = 'gone@example.com')),
    1,
    'a coach the re-import covered is deleted afterwards, through admin_delete_coaches'
);

SELECT is(
    (public.rollback_coach_import_job('11111111-3333-3333-3333-555555555558')->>'status'),
    'rolled_back',
    'the rollback completes although one of the coaches it covers is gone'
);

SELECT is(
    (SELECT string_agg(r.slot || ':' || p.external_registration_id, ',' ORDER BY r.slot)
       FROM public.coach_team_requests r JOIN public.players p ON p.id = r.player_id
      WHERE r.coach_id = (SELECT id FROM public.coaches WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND email = 'stays@example.com')),
    '1:R-100',
    'and the other coach gets back the child the re-import replaced'
);

SELECT is(
    (SELECT count(*) FROM public.coach_team_requests r
      WHERE r.coach_id NOT IN (SELECT id FROM public.coaches))::int,
    0,
    'and no link is left for the coach that is gone'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$
        SELECT public.finalize_coach_import_job(
            '11111111-3333-3333-3333-555555555551',
            '[]'::jsonb
        )
    $$,
    '42501',
    NULL,
    'Org A coach member cannot finalize coach imports'
);

RESET ROLE;

SELECT is(
    (
        SELECT count(*)
        FROM public.coaches
        WHERE lower(email) = 'shared@example.com'
          AND ((organization_id = 'a1111111-1111-1111-1111-111111111111' AND full_name = 'Conflict')
            OR (organization_id = 'b2222222-2222-2222-2222-222222222222' AND full_name = 'Org B Coach'))
    )::int,
    2,
    'Org B''s coach with that email is untouched'
);

SELECT ok(
    'child_registration_id' = ANY (public.import_allowed_keys('coaches'))
    AND NOT ('child_registration_id' = ANY (public.import_allowed_keys('players'))),
    'child_registration_id is a coach import key and not a player one'
);

SELECT throws_ok(
    $$ INSERT INTO public.coaches (organization_id, full_name, email) VALUES ('a1111111-1111-1111-1111-111111111111', 'Dup', 'shared@example.com') $$,
    '23505',
    NULL,
    'the same email twice in one organization is refused by the per-organization unique'
);

SELECT throws_ok(
    $$ INSERT INTO public.coaches (organization_id, full_name, email) VALUES ('a1111111-1111-1111-1111-111111111111', 'Upper', 'Upper@Example.com') $$,
    '23514',
    NULL,
    'a coach email that is not lower-case and trimmed is refused by the CHECK'
);

SELECT * FROM finish();
ROLLBACK;
