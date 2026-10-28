-- pgTAP: the play-up request is stored and editable (migration 20261106010000; plan
-- docs/changes/2026-10-27-play-up-by-request.md).
--
--   * the import stores `players.play_up_requested` from each accepted spelling of the column
--     (yes, true, y, t, 1, x in any case; anything else, and a blank, is no request) under each
--     accepted key, and writes no text copy in `custom_attributes`;
--   * a re-import without the column leaves the request alone, and with it rewrites it;
--   * the player patch sets and clears the request (alone and in bulk), refuses a non-boolean
--     22023, and the audit row it writes names the patch;
--   * another organization's admin cannot set it.
-- Run as `authenticated` with a JWT sub where a caller matters.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(14);

INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by) VALUES
    ('a1111111-0000-4000-8000-0000000006a1', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/pu-1.csv', 'importing', '11111111-1111-1111-1111-111111111111'),
    ('a1111111-0000-4000-8000-0000000006a2', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/pu-2.csv', 'importing', '11111111-1111-1111-1111-111111111111');
INSERT INTO public.staging_players
    (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000006a1', 1, '{}'::jsonb,
     '{"first_name": "Yes", "last_name": "Pu", "external_registration_id": "PU-1", "play_up": "Yes"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000006a1', 2, '{}'::jsonb,
     '{"first_name": "True", "last_name": "Pu", "external_registration_id": "PU-2", "play up": "TRUE"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000006a1', 3, '{}'::jsonb,
     '{"first_name": "One", "last_name": "Pu", "external_registration_id": "PU-3", "play_up": "1"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000006a1', 4, '{}'::jsonb,
     '{"first_name": "Ex", "last_name": "Pu", "external_registration_id": "PU-4", "play_up": " x "}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000006a1', 5, '{}'::jsonb,
     '{"first_name": "Question", "last_name": "Pu", "external_registration_id": "PU-5",
       "are you coaching so this player can play up a division?": "y"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000006a1', 6, '{}'::jsonb,
     '{"first_name": "No", "last_name": "Pu", "external_registration_id": "PU-6", "play_up": "no"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000006a1', 7, '{}'::jsonb,
     '{"first_name": "Maybe", "last_name": "Pu", "external_registration_id": "PU-7", "play_up": "maybe"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000006a1', 8, '{}'::jsonb,
     '{"first_name": "Absent", "last_name": "Pu", "external_registration_id": "PU-8"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000006a2', 1, '{}'::jsonb,
     '{"first_name": "Yes", "last_name": "Pu", "external_registration_id": "PU-1"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000006a2', 2, '{}'::jsonb,
     '{"first_name": "True", "last_name": "Pu", "external_registration_id": "PU-2", "play_up": "no"}'::jsonb);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (public.finalize_import_job('a1111111-0000-4000-8000-0000000006a1') ->> 'inserted_players')::int,
    8, 'the finalizer inserts all eight players'
);
SELECT is(
    (SELECT array_agg(first_name ORDER BY first_name) FROM public.players
      WHERE external_registration_id LIKE 'PU-%' AND play_up_requested),
    ARRAY['Ex', 'One', 'Question', 'True', 'Yes'],
    'yes, true, 1, x and y, under play_up, play up and the GotSport question, are a request'
);
SELECT is(
    (SELECT array_agg(first_name ORDER BY first_name) FROM public.players
      WHERE external_registration_id LIKE 'PU-%' AND NOT play_up_requested),
    ARRAY['Absent', 'Maybe', 'No'],
    'no, maybe and an absent column are no request'
);
SELECT is(
    (SELECT count(*)::int FROM public.players
      WHERE external_registration_id LIKE 'PU-%' AND custom_attributes ? 'play_up'),
    0, 'the play-up column is not kept as text in custom_attributes'
);
SELECT is(
    (public.finalize_import_job('a1111111-0000-4000-8000-0000000006a2') ->> 'updated_players')::int,
    2, 'a re-import updates the two players it matches'
);
SELECT is(
    (SELECT play_up_requested FROM public.players WHERE external_registration_id = 'PU-1'),
    true, 'a re-import without the column leaves the request alone'
);
SELECT is(
    (SELECT play_up_requested FROM public.players WHERE external_registration_id = 'PU-2'),
    false, 'a re-import with the column rewrites the request'
);

SELECT lives_ok(
    $$SELECT public.admin_update_player(
        (SELECT id FROM public.players WHERE external_registration_id = 'PU-8'),
        '{"play_up_requested": true}')$$,
    'an admin sets the request on a player'
);
SELECT is(
    (SELECT play_up_requested FROM public.players WHERE external_registration_id = 'PU-8'),
    true, 'the request is set'
);
SELECT lives_ok(
    $$SELECT public.admin_bulk_update_players(
        ARRAY(SELECT id FROM public.players WHERE external_registration_id = 'PU-8'),
        '{"play_up_requested": false}')$$,
    'and clears it, in bulk'
);
SELECT is(
    (SELECT play_up_requested FROM public.players WHERE external_registration_id = 'PU-8'),
    false, 'the request is cleared'
);
SELECT throws_ok(
    $$SELECT public.admin_update_player(
        (SELECT id FROM public.players WHERE external_registration_id = 'PU-8'),
        '{"play_up_requested": "yes"}')$$,
    '22023', NULL, 'a request that is not a boolean is refused'
);
SELECT ok(
    EXISTS (SELECT 1 FROM public.audit_log
             WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
               AND metadata::text LIKE '%play_up_requested%'),
    'the patch is audited with the field it set'
);

-- Another organization's admin cannot set it. The player is named before the caller changes: Bob
-- cannot read Org A's players, so a lookup under his claims would find nothing.
SELECT set_config('pu.player', (SELECT id::text FROM public.players WHERE external_registration_id = 'PU-8'), true);
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok(
    $$SELECT public.admin_update_player(current_setting('pu.player')::uuid, '{"play_up_requested": true}')$$,
    '42501', NULL, 'an admin of another organization cannot set it'
);
RESET role;

SELECT * FROM finish();
ROLLBACK;
