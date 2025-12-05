-- Sample data seed for the youth sports scheduler schema.
--
-- Usage:
--   psql $DATABASE_URL -f docs/sql/sample_seed_data.sql
--
-- The script inserts a representative Fall 2024 recreation season with two
-- divisions, facilities, practice/game slots, teams, players, and basic
-- assignments.  It is idempotent: running it multiple times refreshes the
-- sample rows without creating duplicates.  Existing production data should
-- be backed up before executing this file.

set search_path = public;

\echo 'Seeding Fall 2024 recreation data set...'

do $$
declare
    season_id bigint;
    u8_division_id uuid;
    u10_division_id uuid;
    location_id uuid;
    field1_id uuid;
    field1a_id uuid;
    field1b_id uuid;
    practice_slot_mon_5 uuid;
    practice_slot_mon_615 uuid;
    practice_slot_tue_5 uuid;
    practice_slot_tue_615 uuid;
    game_slot_u8 uuid;
    game_slot_u10 uuid;
    coach_maria_id uuid;
    coach_jordan_id uuid;
    coach_devon_id uuid;
    coach_elena_id uuid;
    team_firebolts_id uuid;
    team_riverrunners_id uuid;
    team_lightning_id uuid;
    team_thunder_id uuid;
    team_run_id uuid;
    practice_run_id uuid;
    evaluation_run_id uuid;
    export_job_id uuid;
begin
    insert into season_settings (
        season_label,
        season_year,
        season_start,
        season_end,
        roster_formula,
        daylight_adjustments,
        exports_config
    ) values (
        'Fall Recreation',
        2024,
        date '2024-08-05',
        date '2024-10-26',
        jsonb_build_object(
            'u8', jsonb_build_object('min', 10, 'max', 12),
            'u10', jsonb_build_object('min', 12, 'max', 14)
        ),
        jsonb_build_array(
            jsonb_build_object('effective_on', '2024-09-23', 'practice_duration_minutes', 75)
        ),
        jsonb_build_object('export_format', 'teamsnap-csv')
    )
    on conflict (season_label, season_year) do update set
        season_start = excluded.season_start,
        season_end = excluded.season_end,
        roster_formula = excluded.roster_formula,
        daylight_adjustments = excluded.daylight_adjustments,
        exports_config = excluded.exports_config
    returning id
    into season_id;

    insert into divisions (
        season_settings_id,
        name,
        gender_policy,
        max_roster_size,
        play_format,
        season_start,
        season_end
    ) values (
        season_id,
        'U8 Coed',
        'coed',
        12,
        '5v5',
        date '2024-08-05',
        date '2024-10-26'
    )
    on conflict (season_settings_id, name) do update set
        gender_policy = excluded.gender_policy,
        max_roster_size = excluded.max_roster_size,
        play_format = excluded.play_format,
        season_start = excluded.season_start,
        season_end = excluded.season_end
    returning id into u8_division_id;

    insert into divisions (
        season_settings_id,
        name,
        gender_policy,
        max_roster_size,
        play_format,
        season_start,
        season_end
    ) values (
        season_id,
        'U10 Girls',
        'girls',
        14,
        '7v7',
        date '2024-08-05',
        date '2024-10-26'
    )
    on conflict (season_settings_id, name) do update set
        gender_policy = excluded.gender_policy,
        max_roster_size = excluded.max_roster_size,
        play_format = excluded.play_format,
        season_start = excluded.season_start,
        season_end = excluded.season_end
    returning id into u10_division_id;

    insert into locations (name, address, lighting_available)
    values ('Riverfront Park', '101 Riverside Dr, Hometown', true)
    on conflict (name) do update set
        address = excluded.address,
        lighting_available = excluded.lighting_available
    returning id into location_id;

    insert into fields (location_id, name, surface_type, supports_halves)
    values (location_id, 'Field 1', 'grass', true)
    on conflict (location_id, name) do update set
        surface_type = excluded.surface_type,
        supports_halves = excluded.supports_halves
    returning id into field1_id;

    insert into field_subunits (field_id, label)
    values (field1_id, 'A')
    on conflict (field_id, label) do update set label = excluded.label
    returning id into field1a_id;

    insert into field_subunits (field_id, label)
    values (field1_id, 'B')
    on conflict (field_id, label) do update set label = excluded.label
    returning id into field1b_id;

    insert into practice_slots (
        field_id,
        field_subunit_id,
        day_of_week,
        start_time,
        end_time,
        capacity,
        valid_from,
        valid_until
    ) values (
        field1_id,
        field1a_id,
        'mon',
        time '17:00',
        time '18:15',
        1,
        date '2024-08-05',
        date '2024-10-25'
    )
    on conflict (field_subunit_id, day_of_week, start_time, valid_from) do update set
        end_time = excluded.end_time,
        capacity = excluded.capacity,
        valid_until = excluded.valid_until
    returning id into practice_slot_mon_5;

    insert into practice_slots (
        field_id,
        field_subunit_id,
        day_of_week,
        start_time,
        end_time,
        capacity,
        valid_from,
        valid_until
    ) values (
        field1_id,
        field1a_id,
        'mon',
        time '18:30',
        time '19:45',
        1,
        date '2024-08-05',
        date '2024-10-25'
    )
    on conflict (field_subunit_id, day_of_week, start_time, valid_from) do update set
        end_time = excluded.end_time,
        capacity = excluded.capacity,
        valid_until = excluded.valid_until
    returning id into practice_slot_mon_615;

    insert into practice_slots (
        field_id,
        field_subunit_id,
        day_of_week,
        start_time,
        end_time,
        capacity,
        valid_from,
        valid_until
    ) values (
        field1_id,
        field1b_id,
        'tue',
        time '17:00',
        time '18:30',
        1,
        date '2024-08-05',
        date '2024-10-25'
    )
    on conflict (field_subunit_id, day_of_week, start_time, valid_from) do update set
        end_time = excluded.end_time,
        capacity = excluded.capacity,
        valid_until = excluded.valid_until
    returning id into practice_slot_tue_5;

    insert into practice_slots (
        field_id,
        field_subunit_id,
        day_of_week,
        start_time,
        end_time,
        capacity,
        valid_from,
        valid_until
    ) values (
        field1_id,
        field1b_id,
        'tue',
        time '18:45',
        time '20:00',
        1,
        date '2024-08-05',
        date '2024-10-25'
    )
    on conflict (field_subunit_id, day_of_week, start_time, valid_from) do update set
        end_time = excluded.end_time,
        capacity = excluded.capacity,
        valid_until = excluded.valid_until
    returning id into practice_slot_tue_615;

    insert into game_slots (
        field_id,
        division_id,
        slot_date,
        start_time,
        end_time,
        week_index
    ) values (
        field1_id,
        u8_division_id,
        date '2024-09-07',
        time '09:00',
        time '10:00',
        1
    )
    on conflict (field_id, slot_date, start_time) do update set
        division_id = excluded.division_id,
        end_time = excluded.end_time,
        week_index = excluded.week_index
    returning id into game_slot_u8;

    insert into game_slots (
        field_id,
        division_id,
        slot_date,
        start_time,
        end_time,
        week_index
    ) values (
        field1_id,
        u10_division_id,
        date '2024-09-14',
        time '09:00',
        time '10:15',
        1
    )
    on conflict (field_id, slot_date, start_time) do update set
        division_id = excluded.division_id,
        end_time = excluded.end_time,
        week_index = excluded.week_index
    returning id into game_slot_u10;

    insert into players (
        division_id,
        external_registration_id,
        first_name,
        last_name,
        preferred_name,
        grade,
        guardian_contacts,
        mutual_buddy_code,
        coach_volunteer,
        skill_tier
    ) values
        (u8_division_id, 'REG-U8-001', 'Emma', 'Johnson', null, '2nd',
            '[{"name":"Maria Johnson","email":"maria.johnson@example.com","phone":"+1-555-0101","primary":true}]'::jsonb,
            null,
            true,
            'developing'),
        (u8_division_id, 'REG-U8-002', 'Liam', 'Patel', null, '2nd',
            '[{"name":"Jordan Patel","email":"jordan.patel@example.com","phone":"+1-555-0112","primary":true}]'::jsonb,
            null,
            true,
            'novice'),
        (u8_division_id, 'REG-U8-003', 'Ava', 'Chen', null, '2nd',
            '[{"name":"Yvonne Chen","email":"yvonne.chen@example.com","phone":"+1-555-0142","primary":true}]'::jsonb,
            'BUD-U8-01',
            false,
            'developing'),
        (u8_division_id, 'REG-U8-004', 'Mia', 'Davis', null, '3rd',
            '[{"name":"Chris Davis","email":"chris.davis@example.com","phone":"+1-555-0167","primary":true}]'::jsonb,
            'BUD-U8-01',
            false,
            'novice'),
        (u8_division_id, 'REG-U8-005', 'Noah', 'Williams', null, '3rd',
            '[{"name":"Jordan Williams","email":"jordan.williams@example.com","phone":"+1-555-0181","primary":true}]'::jsonb,
            null,
            false,
            'developing'),
        (u8_division_id, 'REG-U8-006', 'Lucas', 'Brown', null, '3rd',
            '[{"name":"Morgan Brown","email":"morgan.brown@example.com","phone":"+1-555-0194","primary":true}]'::jsonb,
            null,
            false,
            'advanced'),
        (u10_division_id, 'REG-U10-001', 'Sofia', 'Ramirez', null, '4th',
            '[{"name":"Devon Ramirez","email":"devon.ramirez@example.com","phone":"+1-555-0203","primary":true}]'::jsonb,
            'BUD-U10-02',
            true,
            'developing'),
        (u10_division_id, 'REG-U10-002', 'Harper', 'Lee', null, '4th',
            '[{"name":"Quinn Lee","email":"quinn.lee@example.com","phone":"+1-555-0219","primary":true}]'::jsonb,
            'BUD-U10-02',
            false,
            'advanced'),
        (u10_division_id, 'REG-U10-003', 'Chloe', 'Martin', null, '4th',
            '[{"name":"Dana Martin","email":"dana.martin@example.com","phone":"+1-555-0228","primary":true}]'::jsonb,
            'BUD-U10-03',
            false,
            'developing'),
        (u10_division_id, 'REG-U10-004', 'Grace', 'Thompson', null, '5th',
            '[{"name":"Elena Thompson","email":"elena.thompson@example.com","phone":"+1-555-0241","primary":true}]'::jsonb,
            'BUD-U10-03',
            true,
            'novice'),
        (u10_division_id, 'REG-U10-005', 'Isabella', 'Nguyen', null, '5th',
            '[{"name":"Linh Nguyen","email":"linh.nguyen@example.com","phone":"+1-555-0256","primary":true}]'::jsonb,
            null,
            false,
            'advanced'),
        (u10_division_id, 'REG-U10-006', 'Zoe', 'Clark', null, '5th',
            '[{"name":"Taylor Clark","email":"taylor.clark@example.com","phone":"+1-555-0270","primary":true}]'::jsonb,
            null,
            false,
            'developing')
    on conflict (division_id, external_registration_id) do update set
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        preferred_name = excluded.preferred_name,
        grade = excluded.grade,
        guardian_contacts = excluded.guardian_contacts,
        mutual_buddy_code = excluded.mutual_buddy_code,
        coach_volunteer = excluded.coach_volunteer,
        skill_tier = excluded.skill_tier;

    insert into coaches (
        player_id,
        full_name,
        email,
        phone,
        certifications,
        preferred_practice_days,
        preferred_practice_window,
        can_coach_multiple_teams,
        status
    ) values (
        (select id from players where division_id = u8_division_id and external_registration_id = 'REG-U8-001'),
        'Maria Johnson',
        'maria.johnson@example.com',
        '+1-555-0101',
        'SafeSport',
        array['mon']::day_of_week[],
        null,
        false,
        'active'
    )
    on conflict (email) do update set
        player_id = excluded.player_id,
        full_name = excluded.full_name,
        phone = excluded.phone,
        certifications = excluded.certifications,
        preferred_practice_days = excluded.preferred_practice_days,
        preferred_practice_window = excluded.preferred_practice_window,
        can_coach_multiple_teams = excluded.can_coach_multiple_teams,
        status = excluded.status
    returning id into coach_maria_id;

    insert into coaches (
        player_id,
        full_name,
        email,
        phone,
        certifications,
        preferred_practice_days,
        preferred_practice_window,
        can_coach_multiple_teams,
        status
    ) values (
        (select id from players where division_id = u8_division_id and external_registration_id = 'REG-U8-002'),
        'Jordan Patel',
        'jordan.patel@example.com',
        '+1-555-0112',
        null,
        array['mon']::day_of_week[],
        null,
        false,
        'active'
    )
    on conflict (email) do update set
        player_id = excluded.player_id,
        full_name = excluded.full_name,
        phone = excluded.phone,
        certifications = excluded.certifications,
        preferred_practice_days = excluded.preferred_practice_days,
        preferred_practice_window = excluded.preferred_practice_window,
        can_coach_multiple_teams = excluded.can_coach_multiple_teams,
        status = excluded.status
    returning id into coach_jordan_id;

    insert into coaches (
        player_id,
        full_name,
        email,
        phone,
        certifications,
        preferred_practice_days,
        preferred_practice_window,
        can_coach_multiple_teams,
        status
    ) values (
        (select id from players where division_id = u10_division_id and external_registration_id = 'REG-U10-001'),
        'Devon Ramirez',
        'devon.ramirez@example.com',
        '+1-555-0203',
        'SafeSport',
        array['tue']::day_of_week[],
        null,
        false,
        'active'
    )
    on conflict (email) do update set
        player_id = excluded.player_id,
        full_name = excluded.full_name,
        phone = excluded.phone,
        certifications = excluded.certifications,
        preferred_practice_days = excluded.preferred_practice_days,
        preferred_practice_window = excluded.preferred_practice_window,
        can_coach_multiple_teams = excluded.can_coach_multiple_teams,
        status = excluded.status
    returning id into coach_devon_id;

    insert into coaches (
        player_id,
        full_name,
        email,
        phone,
        certifications,
        preferred_practice_days,
        preferred_practice_window,
        can_coach_multiple_teams,
        status
    ) values (
        (select id from players where division_id = u10_division_id and external_registration_id = 'REG-U10-004'),
        'Elena Thompson',
        'elena.thompson@example.com',
        '+1-555-0241',
        null,
        array['tue']::day_of_week[],
        null,
        false,
        'active'
    )
    on conflict (email) do update set
        player_id = excluded.player_id,
        full_name = excluded.full_name,
        phone = excluded.phone,
        certifications = excluded.certifications,
        preferred_practice_days = excluded.preferred_practice_days,
        preferred_practice_window = excluded.preferred_practice_window,
        can_coach_multiple_teams = excluded.can_coach_multiple_teams,
        status = excluded.status
    returning id into coach_elena_id;

    insert into teams (
        division_id,
        name,
        coach_id,
        assistant_coach_ids,
        practice_slot_id,
        notes
    ) values (
        u8_division_id,
        'Firebolts',
        coach_maria_id,
        '{}'::uuid[],
        practice_slot_mon_5,
        'Sample U8 roster emphasizing buddy retention'
    )
    on conflict (division_id, name) do update set
        coach_id = excluded.coach_id,
        assistant_coach_ids = excluded.assistant_coach_ids,
        practice_slot_id = excluded.practice_slot_id,
        notes = excluded.notes
    returning id into team_firebolts_id;

    insert into teams (
        division_id,
        name,
        coach_id,
        assistant_coach_ids,
        practice_slot_id,
        notes
    ) values (
        u8_division_id,
        'River Runners',
        coach_jordan_id,
        '{}'::uuid[],
        practice_slot_mon_615,
        'Sample U8 roster with late practice preference'
    )
    on conflict (division_id, name) do update set
        coach_id = excluded.coach_id,
        assistant_coach_ids = excluded.assistant_coach_ids,
        practice_slot_id = excluded.practice_slot_id,
        notes = excluded.notes
    returning id into team_riverrunners_id;

    insert into teams (
        division_id,
        name,
        coach_id,
        assistant_coach_ids,
        practice_slot_id,
        notes
    ) values (
        u10_division_id,
        'Lightning',
        coach_devon_id,
        '{}'::uuid[],
        practice_slot_tue_5,
        'Sample U10 roster with early slot'
    )
    on conflict (division_id, name) do update set
        coach_id = excluded.coach_id,
        assistant_coach_ids = excluded.assistant_coach_ids,
        practice_slot_id = excluded.practice_slot_id,
        notes = excluded.notes
    returning id into team_lightning_id;

    insert into teams (
        division_id,
        name,
        coach_id,
        assistant_coach_ids,
        practice_slot_id,
        notes
    ) values (
        u10_division_id,
        'Thunder',
        coach_elena_id,
        '{}'::uuid[],
        practice_slot_tue_615,
        'Sample U10 roster with later slot'
    )
    on conflict (division_id, name) do update set
        coach_id = excluded.coach_id,
        assistant_coach_ids = excluded.assistant_coach_ids,
        practice_slot_id = excluded.practice_slot_id,
        notes = excluded.notes
    returning id into team_thunder_id;

    delete from team_players
    where team_id in (team_firebolts_id, team_riverrunners_id, team_lightning_id, team_thunder_id);

    insert into team_players (team_id, player_id, role, source)
    select team_firebolts_id, p.id, 'player', 'auto'
    from players p
    where p.division_id = u8_division_id
      and p.external_registration_id in ('REG-U8-001', 'REG-U8-003', 'REG-U8-004')
    on conflict (team_id, player_id) do update set
        role = excluded.role,
        source = excluded.source;

    insert into team_players (team_id, player_id, role, source)
    select team_riverrunners_id, p.id, 'player', 'auto'
    from players p
    where p.division_id = u8_division_id
      and p.external_registration_id in ('REG-U8-002', 'REG-U8-005', 'REG-U8-006')
    on conflict (team_id, player_id) do update set
        role = excluded.role,
        source = excluded.source;

    insert into team_players (team_id, player_id, role, source)
    select team_lightning_id, p.id, 'player', 'auto'
    from players p
    where p.division_id = u10_division_id
      and p.external_registration_id in ('REG-U10-001', 'REG-U10-002', 'REG-U10-003')
    on conflict (team_id, player_id) do update set
        role = excluded.role,
        source = excluded.source;

    insert into team_players (team_id, player_id, role, source)
    select team_thunder_id, p.id, 'player', 'auto'
    from players p
    where p.division_id = u10_division_id
      and p.external_registration_id in ('REG-U10-004', 'REG-U10-005', 'REG-U10-006')
    on conflict (team_id, player_id) do update set
        role = excluded.role,
        source = excluded.source;

    delete from practice_assignments
    where team_id in (team_firebolts_id, team_riverrunners_id, team_lightning_id, team_thunder_id);

    insert into practice_assignments (
        team_id,
        practice_slot_id,
        effective_date_range,
        source
    ) values
        (team_firebolts_id, practice_slot_mon_5, '[2024-08-05,2024-10-25]'::daterange, 'auto'),
        (team_riverrunners_id, practice_slot_mon_615, '[2024-08-05,2024-10-25]'::daterange, 'auto'),
        (team_lightning_id, practice_slot_tue_5, '[2024-08-05,2024-10-25]'::daterange, 'auto'),
        (team_thunder_id, practice_slot_tue_615, '[2024-08-05,2024-10-25]'::daterange, 'auto')
    on conflict (team_id, practice_slot_id, effective_date_range) do update set
        source = excluded.source;

    delete from games where game_slot_id in (game_slot_u8, game_slot_u10);

    insert into games (
        game_slot_id,
        home_team_id,
        away_team_id,
        week_index
    ) values
        (game_slot_u8, team_firebolts_id, team_riverrunners_id, 1),
        (game_slot_u10, team_lightning_id, team_thunder_id, 1)
    on conflict (game_slot_id) do update set
        home_team_id = excluded.home_team_id,
        away_team_id = excluded.away_team_id,
        week_index = excluded.week_index;

    -- Clear out old demo data in reverse order of dependency to avoid
    -- relying on specific foreign key delete behaviors.
    delete from email_log
    where metadata ->> 'seed_tag' = 'fall2024-demo';

    delete from export_jobs
    where payload ->> 'seed_tag' = 'fall2024-demo';

    delete from evaluation_runs
    where input_snapshot ->> 'seed_tag' = 'fall2024-demo';

    delete from scheduler_runs
    where parameters ->> 'seed_tag' = 'fall2024-demo';

    insert into scheduler_runs (
        season_settings_id,
        run_type,
        status,
        parameters,
        metrics,
        results,
        started_at,
        completed_at
    ) values (
        season_id,
        'team',
        'completed',
        jsonb_build_object(
            'seed_tag', 'fall2024-demo',
            'triggered_by', 'seed-script',
            'divisions', jsonb_build_array('U8 Coed', 'U10 Girls')
        ),
        jsonb_build_object(
            'total_players', 12,
            'total_teams', 4,
            'buddy_pairs_honored', 3
        ),
        jsonb_build_object(
            'teamsByDivision', jsonb_build_object(
                'U8 Coed', jsonb_build_array(
                    jsonb_build_object('id', 'U8-T01', 'name', 'Firebolts', 'coachId', 'coach-u8-001', 'players', jsonb_build_array(
                        jsonb_build_object('id', 'p1'), jsonb_build_object('id', 'p2'), jsonb_build_object('id', 'p3'), jsonb_build_object('id', 'p4'),
                        jsonb_build_object('id', 'p5'), jsonb_build_object('id', 'p6'), jsonb_build_object('id', 'p7'), jsonb_build_object('id', 'p8'),
                        jsonb_build_object('id', 'p9'), jsonb_build_object('id', 'p10')
                    )),
                    jsonb_build_object('id', 'U8-T02', 'name', 'River Runners', 'coachId', 'coach-u8-002', 'players', jsonb_build_array(
                        jsonb_build_object('id', 'p11'), jsonb_build_object('id', 'p12'), jsonb_build_object('id', 'p13'), jsonb_build_object('id', 'p14'),
                        jsonb_build_object('id', 'p15'), jsonb_build_object('id', 'p16'), jsonb_build_object('id', 'p17'), jsonb_build_object('id', 'p18'),
                        jsonb_build_object('id', 'p19'), jsonb_build_object('id', 'p20')
                    )),
                    jsonb_build_object('id', 'U8-T03', 'name', 'U8 Coed Team 03', 'coachId', 'coach-u8-003', 'players', jsonb_build_array(
                        jsonb_build_object('id', 'p21'), jsonb_build_object('id', 'p22'), jsonb_build_object('id', 'p23'), jsonb_build_object('id', 'p24'),
                        jsonb_build_object('id', 'p25'), jsonb_build_object('id', 'p26'), jsonb_build_object('id', 'p27'), jsonb_build_object('id', 'p28'),
                        jsonb_build_object('id', 'p29'), jsonb_build_object('id', 'p30')
                    ))
                ),
                'U10 Girls', jsonb_build_array(
                    jsonb_build_object('id', 'U10-T01', 'name', 'Lightning', 'coachId', 'coach-u10-001', 'players', jsonb_build_array(
                        jsonb_build_object('id', 'p31'), jsonb_build_object('id', 'p32'), jsonb_build_object('id', 'p33'), jsonb_build_object('id', 'p34'),
                        jsonb_build_object('id', 'p35'), jsonb_build_object('id', 'p36'), jsonb_build_object('id', 'p37'), jsonb_build_object('id', 'p38'),
                        jsonb_build_object('id', 'p39'), jsonb_build_object('id', 'p40'), jsonb_build_object('id', 'p41')
                    )),
                    jsonb_build_object('id', 'U10-T02', 'name', 'Thunder', 'coachId', 'coach-u10-002', 'players', jsonb_build_array(
                        jsonb_build_object('id', 'p42'), jsonb_build_object('id', 'p43'), jsonb_build_object('id', 'p44'), jsonb_build_object('id', 'p45'),
                        jsonb_build_object('id', 'p46'), jsonb_build_object('id', 'p47'), jsonb_build_object('id', 'p48'), jsonb_build_object('id', 'p49'),
                        jsonb_build_object('id', 'p50'), jsonb_build_object('id', 'p51'), jsonb_build_object('id', 'p52')
                    )),
                    jsonb_build_object('id', 'U10-T03', 'name', 'U10 Girls Team 03', 'coachId', null, 'players', jsonb_build_array(
                        jsonb_build_object('id', 'p53'), jsonb_build_object('id', 'p54'), jsonb_build_object('id', 'p55'), jsonb_build_object('id', 'p56'),
                        jsonb_build_object('id', 'p57'), jsonb_build_object('id', 'p58'), jsonb_build_object('id', 'p59'), jsonb_build_object('id', 'p60'),
                        jsonb_build_object('id', 'p61'), jsonb_build_object('id', 'p62'), jsonb_build_object('id', 'p63')
                    )),
                    jsonb_build_object('id', 'U10-T04', 'name', 'U10 Girls Team 04', 'coachId', 'coach-u10-004', 'players', jsonb_build_array(
                        jsonb_build_object('id', 'p64'), jsonb_build_object('id', 'p65'), jsonb_build_object('id', 'p66'), jsonb_build_object('id', 'p67'),
                        jsonb_build_object('id', 'p68'), jsonb_build_object('id', 'p69'), jsonb_build_object('id', 'p70'), jsonb_build_object('id', 'p71'),
                        jsonb_build_object('id', 'p72'), jsonb_build_object('id', 'p73'), jsonb_build_object('id', 'p74')
                    ))
                ),
                'U12 Boys', jsonb_build_array(
                    jsonb_build_object('id', 'U12-T01', 'name', 'Raptors', 'coachId', 'coach-u12-001', 'players', jsonb_build_array(
                        jsonb_build_object('id', 'p75'), jsonb_build_object('id', 'p76'), jsonb_build_object('id', 'p77'), jsonb_build_object('id', 'p78'),
                        jsonb_build_object('id', 'p79'), jsonb_build_object('id', 'p80'), jsonb_build_object('id', 'p81'), jsonb_build_object('id', 'p82'),
                        jsonb_build_object('id', 'p83'), jsonb_build_object('id', 'p84'), jsonb_build_object('id', 'p85'), jsonb_build_object('id', 'p86')
                    )),
                    jsonb_build_object('id', 'U12-T02', 'name', 'Sharks', 'coachId', 'coach-u12-002', 'players', jsonb_build_array(
                        jsonb_build_object('id', 'p87'), jsonb_build_object('id', 'p88'), jsonb_build_object('id', 'p89'), jsonb_build_object('id', 'p90'),
                        jsonb_build_object('id', 'p91'), jsonb_build_object('id', 'p92'), jsonb_build_object('id', 'p93'), jsonb_build_object('id', 'p94'),
                        jsonb_build_object('id', 'p95'), jsonb_build_object('id', 'p96'), jsonb_build_object('id', 'p97'), jsonb_build_object('id', 'p98')
                    ))
                 )
            ),
            'overflowByDivision', jsonb_build_object(
                'U8 Coed', jsonb_build_array(
                     jsonb_build_object('players', jsonb_build_array(jsonb_build_object('id', 'o1'), jsonb_build_object('id', 'o2')), 'reason', 'insufficient-capacity')
                ),
                'U10 Girls', jsonb_build_array(
                     jsonb_build_object('players', jsonb_build_array(jsonb_build_object('id', 'o3'), jsonb_build_object('id', 'o4')), 'reason', 'coach-capacity')
                )
            ),
            'buddyDiagnosticsByDivision', jsonb_build_object(
                 'U8 Coed', jsonb_build_object('mutualPairs', jsonb_build_array(), 'unmatchedRequests', jsonb_build_array(jsonb_build_object('playerId', 'p28', 'requestedBuddyId', 'p29', 'reason', 'not-reciprocated'))),
                 'U10 Girls', jsonb_build_object('mutualPairs', jsonb_build_array(), 'unmatchedRequests', jsonb_build_array(jsonb_build_object('playerId', 'p53', 'requestedBuddyId', 'p99', 'reason', 'missing-player')))
            ),
            'rosterBalanceByDivision', jsonb_build_object(
                'U8 Coed', jsonb_build_object('summary', jsonb_build_object('totalCapacity', 36, 'averageFillRate', 0.8333)),
                'U10 Girls', jsonb_build_object('summary', jsonb_build_object('totalCapacity', 48, 'averageFillRate', 0.9167)),
                'U12 Boys', jsonb_build_object('summary', jsonb_build_object('totalCapacity', 24, 'averageFillRate', 1.0))
            ),
            'coachCoverageByDivision', jsonb_build_object(
                'U8 Coed', jsonb_build_object('coverageRate', 1.0, 'needsAdditionalCoaches', false),
                'U10 Girls', jsonb_build_object('coverageRate', 0.75, 'needsAdditionalCoaches', true),
                'U12 Boys', jsonb_build_object('coverageRate', 1.0, 'needsAdditionalCoaches', false)
            )
        ),
        timestamptz '2024-07-01 17:05:00+00',
        timestamptz '2024-07-01 17:05:30+00'
    )
    returning id into team_run_id;

    insert into scheduler_runs (
        season_settings_id,
        run_type,
        status,
        parameters,
        metrics,
        results,
        started_at,
        completed_at
    ) values (
        season_id,
        'practice',
        'completed_with_warnings',
        jsonb_build_object(
            'seed_tag', 'fall2024-demo',
            'triggered_by', 'seed-script',
            'slot_window', '2024-08-05..2024-10-25'
        ),
        jsonb_build_object(
            'auto_assigned', 4,
            'manual_adjustments_required', 1
        ),
        jsonb_build_object(
            'conflicts', jsonb_build_array('Thunder requested earlier slot - logged for follow-up'),
            'assigned_slots', jsonb_build_array(
                jsonb_build_object('team', 'Firebolts', 'day', 'Mon', 'start_time', '17:00'),
                jsonb_build_object('team', 'Riverrunners', 'day', 'Mon', 'start_time', '18:30'),
                jsonb_build_object('team', 'Lightning', 'day', 'Tue', 'start_time', '17:00'),
                jsonb_build_object('team', 'Thunder', 'day', 'Tue', 'start_time', '18:45')
            )
        ),
        timestamptz '2024-07-01 17:10:00+00',
        timestamptz '2024-07-01 17:10:45+00'
    )
    returning id into practice_run_id;

    -- Add a rich practice run to mimic the full metrics structure
    INSERT INTO scheduler_runs (
        season_settings_id,
        run_type,
        status,
        parameters,
        metrics,
        results,
        created_at,
        completed_at
    ) VALUES (
        season_id,
        'practice',
        'completed',
        jsonb_build_object('triggered_by', 'seed-script-v2'),
        '{}'::jsonb,
        '{
            "summary": {
                "totalTeams": 9,
                "assignedTeams": 8,
                "unassignedTeams": 1,
                "assignmentRate": 0.8889,
                "manualFollowUpRate": 0.1111
            },
            "slotUtilization": [
                { "slotId": "F1-TUE-1800", "capacity": 2, "assignedCount": 2, "utilization": 1.0, "overbooked": false },
                { "slotId": "F1-THU-1800", "capacity": 2, "assignedCount": 2, "utilization": 1.0, "overbooked": false },
                { "slotId": "F2-MON-1700", "capacity": 2, "assignedCount": 2, "utilization": 1.0, "overbooked": false },
                { "slotId": "F2-WED-1700", "capacity": 2, "assignedCount": 2, "utilization": 1.0, "overbooked": false }
            ],
            "baseSlotDistribution": [
                {
                    "baseSlotId": "F1-TUE-1800",
                    "day": "Tuesday",
                    "representativeStart": "2024-08-20T18:00:00Z",
                    "totalAssigned": 2,
                    "totalCapacity": 2,
                    "utilization": 1.0,
                    "divisionBreakdown": [
                        { "division": "U8", "count": 2, "percentage": 1.0 }
                    ]
                },
                {
                    "baseSlotId": "F1-THU-1800",
                    "day": "Thursday",
                    "representativeStart": "2024-08-22T18:00:00Z",
                    "totalAssigned": 2,
                    "totalCapacity": 2,
                    "utilization": 1.0,
                    "divisionBreakdown": [
                         { "division": "U10", "count": 2, "percentage": 1.0 }
                    ]
                }
            ],
            "underutilizedBaseSlots": [],
            "fairnessConcerns": [],
            "dayConcentrationAlerts": [],
            "divisionDayDistribution": {
                "U8": {
                    "totalAssigned": 2,
                    "dayBreakdown": [{ "day": "Tuesday", "count": 2, "percentage": 1.0 }]
                },
                "U10": {
                    "totalAssigned": 2,
                    "dayBreakdown": [{ "day": "Thursday", "count": 2, "percentage": 1.0 }]
                },
                "U12": {
                    "totalAssigned": 4,
                    "dayBreakdown": [
                        { "day": "Monday", "count": 2, "percentage": 0.5 },
                        { "day": "Wednesday", "count": 2, "percentage": 0.5 }
                    ]
                }
            },
            "unassignedByReason": [
                {
                    "reason": "no-capacity",
                    "count": 1,
                    "teamIds": ["U10-T04"],
                    "divisionBreakdown": [{ "division": "U10", "count": 1, "percentage": 1.0 }]
                }
            ],
            "manualFollowUpBreakdown": [
                 {
                    "category": "capacity",
                    "count": 1,
                    "percentage": 1.0,
                    "teamIds": ["U10-T04"],
                    "reasons": ["no-capacity"]
                 }
            ],
            "coachLoad": {},
            "coachConflicts": [],
            "dataQualityWarnings": []
        }'::jsonb,
        '2024-08-02 10:00:00+00',
        '2024-08-02 10:00:15+00'
    );

    insert into evaluation_runs (
        scheduler_run_type,
        scheduler_run_id,
        season_settings_id,
        status,
        findings_severity,
        metrics_summary,
        input_snapshot,
        auto_fix_summary,
        started_at,
        completed_at
    ) values (
        'practice',
        practice_run_id,
        season_id,
        'completed_with_warnings',
        'warnings',
        jsonb_build_object(
            'conflicts_detected', 1,
            'conflicts_resolved', 0,
            'fairness_score', 0.78
        ),
        jsonb_build_object(
            'seed_tag', 'fall2024-demo',
            'run_reference', practice_run_id
        ),
        jsonb_build_object('manual_follow_up_needed', true),
        timestamptz '2024-07-01 17:11:00+00',
        timestamptz '2024-07-01 17:11:10+00'
    )
    returning id into evaluation_run_id;

    insert into export_jobs (
        season_settings_id,
        job_type,
        status,
        payload,
        storage_path,
        schema_version,
        started_at,
        completed_at
    ) values (
        season_id,
        'master',
        'completed',
        jsonb_build_object(
            'seed_tag', 'fall2024-demo',
            'source_run_id', team_run_id,
            'format', 'teamsnap-csv'
        ),
        'storage://exports/fall2024/master-schedule.csv',
        'v1',
        timestamptz '2024-07-01 17:15:00+00',
        timestamptz '2024-07-01 17:15:05+00'
    )
    returning id into export_job_id;

    insert into email_log (
        export_job_id,
        recipient_email,
        action,
        metadata
    ) values (
        export_job_id,
        'scheduler@example.com',
        'draft_generated',
        jsonb_build_object(
            'seed_tag', 'fall2024-demo',
            'evaluation_run_id', evaluation_run_id,
            'notes', 'Demo email draft created for admin review'
        )
    );


    -- Add a rich game run to mimic the full metrics structure
    INSERT INTO scheduler_runs (
        season_settings_id,
        run_type,
        status,
        parameters,
        metrics,
        results,
        created_at,
        completed_at
    ) VALUES (
        season_id,
        'game',
        'completed',
        jsonb_build_object('triggered_by', 'seed-script-v2'),
        '{}'::jsonb,
        '{
            "summary": {
                "totalGames": 18,
                "divisionsCovered": 3,
                "scheduledRate": 0.9444,
                "unscheduledMatchups": 1,
                "teamsWithByes": 2,
                "sharedSlotAlerts": 1
            },
            "assignments": [], 
            "unscheduled": [
                {
                    "reason": "lightning postponement",
                    "weekIndex": 3,
                    "matchup": "U10-T01 vs U10-T02",
                    "note": "Field 1 unavailable; awaiting reschedule window"
                }
            ],
            "byes": [
                {
                    "division": "U12",
                    "weekIndex": 4,
                    "teamIds": ["U12-T02", "U12-T03"]
                }
            ],
            "warnings": [
                {
                    "type": "coach-conflict",
                    "severity": "error",
                    "message": "Coach Marie is double-booked in week 2.",
                    "details": {
                        "coachId": "coach-marie",
                        "weekIndex": 2,
                        "games": [
                            { "teamId": "U8-T01", "slotId": "FIELD-1-SAT-0900" },
                            { "teamId": "U10-T02", "slotId": "FIELD-2-SAT-0915" }
                        ]
                    }
                },
                {
                    "type": "shared-slot-imbalance",
                    "severity": "warning",
                    "message": "Shared slot FIELD-1-SAT-1100 is 75% allocated to U10.",
                    "details": {
                        "slotId": "FIELD-1-SAT-1100",
                        "dominantDivision": "U10",
                        "dominantShare": 0.75,
                        "totalAssignments": 4,
                        "breakdown": [
                            { "division": "U10", "count": 3 },
                            { "division": "U12", "count": 1 }
                        ]
                    }
                }
            ],
            "fieldHighlights": [
                {
                    "fieldId": "Field 1",
                    "games": 7,
                    "divisions": ["U8", "U10"],
                    "note": "Maintains even cadence across morning windows."
                },
                {
                    "fieldId": "Field 2",
                    "games": 5,
                    "divisions": ["U10", "U12"],
                    "note": "Hosts the outstanding shared-slot imbalance flagged above."
                }
            ]
        }'::jsonb,
        '2024-08-05 14:00:00+00',
        '2024-08-05 14:00:25+00'
    );

    raise notice 'Seed data applied for Fall 2024 recreation season (season_settings.id=%)', season_id;
end
$$;

\echo 'Seed complete.'
