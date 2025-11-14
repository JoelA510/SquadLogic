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
        phone = excluded.phone,
        preferred_practice_days = excluded.preferred_practice_days,
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
        phone = excluded.phone,
        preferred_practice_days = excluded.preferred_practice_days,
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
        phone = excluded.phone,
        preferred_practice_days = excluded.preferred_practice_days,
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
        phone = excluded.phone,
        preferred_practice_days = excluded.preferred_practice_days,
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
        (game_slot_u10, team_lightning_id, team_thunder_id, 1);

    raise notice 'Seed data applied for Fall 2024 recreation season (season_settings.id=%)', season_id;
end
$$;

\echo 'Seed complete.'
