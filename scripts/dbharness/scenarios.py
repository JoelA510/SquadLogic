#!/usr/bin/env python3
"""Emit SQL that runs the shared scenario table against Postgres.

`tests/fixtures/fieldLifecycleScenarios.json` is the single statement of what
the lifecycle and blackout RPCs must do. `tests/fieldLifecycleScenarios.test.js`
runs it against the mock client; this runs the SAME file against a real
database. Neither implementation is compared with the other -- both are compared
with the table -- so a fix that lands on one side and not the other fails on the
side that missed it.

That is the gap round 3 found: round 2's fixes to `admin_retire_field` and
`admin_unretire_field` went into the SQL and never reached the mock, and one of
them was CERTIFIED by a passing test asserting the wrong outcome.

Dates are offsets in days from `current_date`, so both sides compute the same
absolute date and no scenario expires.

Every assertion RAISES. A scenario that cannot be judged is a failure, never a
skip, and the emitted script counts what it ran and refuses a run that judged
fewer cases than the table holds -- a generator that silently emitted nothing
would otherwise produce a passing script that tests nothing.
"""

import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TABLE_PATH = os.path.join(REPO, 'tests', 'fixtures', 'fieldLifecycleScenarios.json')


def lit(value):
    """A SQL literal for a scenario value."""
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def date_expr(offset):
    """An offset in days from today, as a `date`."""
    if offset is None:
        return 'NULL::date'
    return f'(current_date + {int(offset)})'


# The PL/pgSQL condition name for each SQLSTATE a scenario may name. Explicit
# rather than `SQLSTATE '22023'` so an unknown code fails here, in the
# generator, instead of emitting SQL that catches nothing.
CONDITION_FOR_SQLSTATE = {
    '22023': 'invalid_parameter_value',
    '23514': 'check_violation',
    'P0002': 'no_data_found',
    '42501': 'insufficient_privilege',
    # 8.4 gap A: an id owned by the FROZEN `field_blackout_windows` is refused
    # as unsupported rather than as missing, so "not yours to edit" and "no such
    # window" stay two answers. A scenario naming this code and a runner
    # catching `no_data_found` would score the conflation as a pass.
    '0A000': 'feature_not_supported',
}


def condition_for(scenario):
    """The single condition a refusal scenario is allowed to raise.

    The two runners used to disagree: the JS side accepted ANY error while this
    one accepted a fixed pair, and the mock returned codeless errors, so five of
    the nine blackout cases could have stopped exercising their constraint --
    refused as "Field not found in organization" -- and stayed green. Each
    refusal scenario now names its own SQLSTATE in the table and both runners
    read that one field.
    """
    code = scenario['expect'].get('sqlstate')
    if code is None:
        raise SystemExit(f"scenario {scenario['id']!r} expects a refusal but names no sqlstate")
    if code not in CONDITION_FOR_SQLSTATE:
        raise SystemExit(
            f"scenario {scenario['id']!r} names sqlstate {code!r}, which this "
            'generator has no condition name for'
        )
    return CONDITION_FOR_SQLSTATE[code]


# **How to make a booking of each kind exist, in SQL.**
#
# The map lives here rather than in the scenario table because it is SEEDING
# knowledge and each runner needs its own -- `tests/fieldLifecycleScenarios.test.js`
# has the JavaScript twin. What is SHARED is the outcome the table states.
#
# Each entry is an INSERT with `%(field)s` for the field the scenario is about.
# `practice_assignments.team_id` is NOT NULL and references `teams`, which is
# why the preamble builds a season, a division and a team.
# How many days out each kind is seeded when the scenario does not say.
#
# **A scenario overrides this with `bookingOffset`**, which is how the retirement
# BOUNDARY became data instead of something the two runners agreed about
# privately: `bookingOffset == args.effectiveTo` is a booking on the last usable
# day, `effectiveTo + 1` is the first one stranded, and the fixture states which
# of those refuses. Two implementations compared only to each other cannot catch
# an off-by-one they share.
DEFAULT_BOOKING_OFFSET = {
    'game_slot': 30,
    'game_assignment': 30,
    'practice_slot': 60,
    'practice_assignment': 60,
    'scheduled_game': 30,
    'scheduled_practice': 60,
    'availability_profile': 45,
}

BOOKING_SEEDS = {
    'game_slot':
        "INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index) "
        "VALUES (v_org, %(field)s, current_date + %(at)s, 1);",
    # **Anchored to `current_date`, not to `now()`.** `timezone('utc', now()) +
    # interval 'N days'` cast back to a date can land a day either side of
    # `current_date + N` depending on the session TimeZone, which is harmless at
    # 30 days out and a coin toss for a case whose whole point is the boundary.
    'game_assignment':
        'INSERT INTO public.game_assignments (organization_id, field_id, "start", week_index) '
        "VALUES (v_org, %(field)s, (current_date + %(at)s) + time '18:00', 1);",
    'practice_slot':
        "INSERT INTO public.practice_slots "
        "(organization_id, field_id, day_of_week, start_time, end_time, valid_until) "
        "VALUES (v_org, %(field)s, 'mon', '18:00', '19:30', current_date + %(at)s);",
    # `'[]'` on the upper bound: the range covers `at` itself, so its LAST DAY is
    # `at` -- the value the boundary cases compare against effectiveTo.
    'practice_assignment':
        "INSERT INTO public.practice_assignments "
        "(organization_id, team_id, field_id, effective_date_range) "
        "VALUES (v_org, v_team, %(field)s, "
        "daterange(current_date, current_date + %(at)s, '[]'));",
    # **The sixth kind (LIVE-3).** `available_from` and `available_until` are
    # both NOT NULL with no default, and `available_until >= available_from`
    # is a CHECK, so every column the constraint touches is written here
    # rather than left to the schema.
    'availability_profile':
        "INSERT INTO public.field_availability_profiles "
        "(organization_id, field_id, season_label, location, field_name, "
        " available_from, available_until) "
        "VALUES (v_org, %(field)s, 'Scenario Season', 'Scenario Park', "
        "'Scenario Pitch', current_date, current_date + %(at)s);",
}

# The table each kind lives in, for counting survivors after a refusal.
BOOKING_TABLES = {
    'game_slot': 'game_slots',
    'game_assignment': 'game_assignments',
    'practice_slot': 'practice_slots',
    'practice_assignment': 'practice_assignments',
    'availability_profile': 'field_availability_profiles',
}

# **Composite kinds: the shapes the persistence RPCs actually write.**
#
# `persist_game_schedule` populates `game_slot_id` and `slot_id` on every
# assignment it produces, and both are ON DELETE CASCADE to `game_slots` -- so a
# real scheduled game is DESTROYED by a field delete, not unassigned. Seeding
# only the free-standing shape, as the first version of these scenarios did,
# exercises a row the production path never produces.
#
# Each entry is (statement, survivor-count-check) pairs; `%(field)s` is the
# field the scenario is about. The slot is created first so the assignment and
# the game can reference it by a variable rather than by a guessed id.
COMPOSITE_SEEDS = {
    'scheduled_game': [
        ("INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index) "
         "VALUES (v_org, %(field)s, current_date + %(at)s, 1) RETURNING id INTO v_seed_slot;",
         'game_slots'),
        ('INSERT INTO public.game_assignments '
         '(organization_id, field_id, game_slot_id, slot_id, "start", week_index) '
         "VALUES (v_org, %(field)s, v_seed_slot, v_seed_slot, "
         "(current_date + %(at)s) + time '18:00', 1);",
         'game_assignments'),
        ("INSERT INTO public.games (organization_id, game_slot_id, home_team_id, away_team_id) "
         "VALUES (v_org, v_seed_slot, v_team, v_team_b);",
         'games'),
    ],
    'scheduled_practice': [
        ("INSERT INTO public.practice_slots "
         "(organization_id, field_id, day_of_week, start_time, end_time, valid_until) "
         "VALUES (v_org, %(field)s, 'mon', '18:00', '19:30', current_date + %(at)s) "
         "RETURNING id INTO v_seed_slot;",
         'practice_slots'),
        ("INSERT INTO public.practice_assignments "
         "(organization_id, team_id, field_id, practice_slot_id, slot_id, effective_date_range) "
         "VALUES (v_org, v_team, %(field)s, v_seed_slot, v_seed_slot, "
         "daterange(current_date, current_date + %(at)s, '[]'));",
         'practice_assignments'),
    ],
}


def booking_count_sql(table):
    """Count the rows of `table` that this field's delete would reach.

    `games` carries no field_id, so it is counted through the slot it hangs
    off -- the same reading admin_delete_field takes.
    """
    if table == 'games':
        return ("SELECT count(*) INTO v_n FROM public.games g "
                "JOIN public.game_slots gs ON gs.id = g.game_slot_id "
                "WHERE gs.field_id = v_field;")
    return f"SELECT count(*) INTO v_n FROM public.{table} WHERE field_id = v_field;"


def confirm_expr(scenario):
    """The confirmation argument, passed THROUGH rather than coerced.

    `bool(None)` is `False`, which is the answer the guard is supposed to reach
    on its own -- coercing here would make the generator supply the behaviour
    the `*-null-confirm-refused` cases exist to demand of the RPC. `NOT NULL` is
    NULL in SQL, so a bare `NOT p_confirm` leaves the refusal unfired.
    """
    if 'confirm' not in scenario['args']:
        return 'false'
    return lit(scenario['args']['confirm'])


def emit_bookings(scenario, target):
    """Seed the scenario's bookings, and prove each landed.

    Returns (lines, counts) where `counts` is how many rows each table should
    hold afterwards. **Exact counts, not "at least one".** A scenario that
    seeds a composite AND a free-standing row of the same kind puts two rows in
    one table, so a check hard-coded to 1 fails on the very case that exists to
    put both shapes on one field -- which is how this check was first written.

    A seed that silently did nothing would turn a refusal case into an unbooked
    one: the field would delete, the assertion would be about nothing, and the
    guard could be entirely absent.
    """
    lines = []
    counts = {}

    def seeded(table):
        counts[table] = counts.get(table, 0) + 1
        return counts[table]

    for kind in scenario.get('bookings') or []:
        at = scenario.get('bookingOffset', DEFAULT_BOOKING_OFFSET.get(kind))
        if at is None:
            raise SystemExit(f'no default offset for booking kind {kind!r}')
        if kind in COMPOSITE_SEEDS:
            for statement, table in COMPOSITE_SEEDS[kind]:
                lines.append('  ' + statement % {'field': target, 'at': at})
                expected = seeded(table)
                lines += [
                    '  ' + booking_count_sql(table),
                    f"  IF v_n <> {expected} THEN",
                    f"    RAISE EXCEPTION '{scenario['id']}: the {kind} seed did not land in "
                    f"{table} (expected {expected}, found %)', v_n;",
                    "  END IF;",
                ]
            continue
        if kind not in BOOKING_SEEDS:
            # Every switch over a union throws on the value it does not know.
            raise SystemExit(f"unknown booking kind {kind!r} in scenario {scenario['id']!r}")
        table = BOOKING_TABLES[kind]
        lines.append('  ' + BOOKING_SEEDS[kind] % {'field': target, 'at': at})
        expected = seeded(table)
        lines += [
            '  ' + booking_count_sql(table),
            f"  IF v_n <> {expected} THEN",
            f"    RAISE EXCEPTION '{scenario['id']}: the {kind} seed did not land "
            f"(expected {expected}, found %)', v_n;",
            "  END IF;",
        ]
    return lines, counts


def emit_audit_phases(scenario, subject='v_field'):
    """The audit phases the table names for this case, compared as a set.

    Read from the table rather than written into each runner: that was fine
    while every accepted call recorded `before` and `after`, and is wrong now
    that a REFUSED delete records `refused` instead.
    """
    expected = scenario['expect'].get('auditPhases')
    if not expected:
        raise SystemExit(f"scenario {scenario['id']!r} succeeds but names no auditPhases")
    literal = 'ARRAY[' + ', '.join(lit(p) for p in sorted(expected)) + ']'
    return [
        "  SELECT array_agg(DISTINCT metadata->>'phase' ORDER BY metadata->>'phase')",
        "    INTO v_phases FROM public.audit_log",
        f"   WHERE resource_id = {subject} AND metadata->>'operation' = {lit(scenario['rpc'])};",
        f"  IF v_phases IS DISTINCT FROM {literal} THEN",
        # **No Python repr in a SQL string literal.** `sorted(expected)` renders
        # as ['after', 'before'] -- single quotes inside a single-quoted
        # message, which closes the literal and makes the generated script fail
        # to parse. Joined plainly instead.
        f"    RAISE EXCEPTION '{scenario['id']}: audit phases were %, expected "
        f"{', '.join(sorted(expected))}', v_phases;",
        "  END IF;",
    ]


def emit_field(scenario, index):
    s = scenario
    fid = f"scenario_field_{index}"
    lines = [
        f"  -- {s['id']}: {s['why']}",
        "  INSERT INTO public.fields (organization_id, location_id, name, active, effective_to)",
        f"  VALUES (v_org, v_loc, {lit('Scenario Pitch ' + str(index))}, "
        f"{lit(s['before']['active'])}, {date_expr(s['before']['effectiveTo'])})",
        "  RETURNING id INTO v_field;",
        # The `before` state really landed. The retirement trigger fires on
        # INSERT, so a scenario asking for `active = true` with a PAST date
        # would be silently corrected into a different scenario.
        "  SELECT active, effective_to INTO v_active, v_eff FROM public.fields WHERE id = v_field;",
        f"  IF v_active IS DISTINCT FROM {lit(s['before']['active'])}",
        f"     OR v_eff IS DISTINCT FROM {date_expr(s['before']['effectiveTo'])} THEN",
        f"    RAISE EXCEPTION '{s['id']}: the BEFORE state did not land (active=%, effective_to=%)',",
        "      v_active, v_eff;",
        "  END IF;",
    ]
    # **`foreignOrg` points the call at ground this org does not own.** It is
    # the field half's one refusal case, and it exists so `expect.ok` is READ on
    # this half at all: it was shape-validated on every scenario and branched on
    # by neither runner for a field case.
    target = (
        "'00000000-0000-0000-0000-0000000000ff'::uuid"
        if s['args'].get('foreignOrg')
        else 'v_field'
    )
    # Bookings are always seeded onto the REAL field, never onto the foreign-org
    # target: a scenario testing the org gate must be refused by the gate, not
    # by an insert that could not find a field to hang a booking on.
    booking_lines, booking_counts = emit_bookings(s, 'v_field')
    lines += booking_lines
    if s['rpc'] == 'admin_retire_field':
        call = (
            "public.admin_retire_field(p_organization_id => v_org, "
            f"p_field_id => {target}, p_effective_to => {date_expr(s['args']['effectiveTo'])}, "
            f"p_confirm => {confirm_expr(s)})"
        )
    elif s['rpc'] == 'admin_unretire_field':
        call = (
            "public.admin_unretire_field(p_organization_id => v_org, "
            f"p_field_id => {target})"
        )
    elif s['rpc'] == 'admin_delete_field':
        call = (
            "public.admin_delete_field(p_organization_id => v_org, "
            f"p_field_id => {target}, "
            f"p_confirm => {confirm_expr(s)})"
        )
    else:
        # Every switch over a union throws on the value it does not know.
        raise SystemExit(f"unknown rpc {s['rpc']!r} in scenario {s['id']!r}")

    if not s['expect']['ok']:
        lines += [
            "  BEGIN",
            f"    v_res := {call};",
            f"    RAISE EXCEPTION '{s['id']}: expected a refusal and the call SUCCEEDED';",
            f"  EXCEPTION WHEN {condition_for(s)} THEN NULL;",
            "  END;",
            "  v_ran := v_ran + 1;",
            "",
        ]
        return lines

    lines.append(f"  v_res := {call};")

    if s['rpc'] == 'admin_delete_field':
        e = s['expect']
        lines += [
            # **A refusal is not an error.** admin_delete_field mirrors
            # admin_retire_field and RETURNS `{deleted:false, ...}`, so a runner
            # that only watched for an exception would score every refusal as a
            # successful delete.
            f"  IF (v_res->>'deleted')::boolean IS DISTINCT FROM {lit(e['deleted'])} THEN",
            f"    RAISE EXCEPTION '{s['id']}: expected deleted={lit(e['deleted'])}, got %', v_res;",
            "  END IF;",
            f"  IF (v_res->>'affected_count')::int IS DISTINCT FROM {int(e['affectedCount'])} THEN",
            f"    RAISE EXCEPTION '{s['id']}: expected {int(e['affectedCount'])} affected bookings, got %',",
            "      v_res->>'affected_count';",
            "  END IF;",
            # The count and the list must agree: a count computed separately
            # from the rows it counts is the shape that reports 4 and shows 2.
            f"  IF jsonb_array_length(v_res->'affected') <> {int(e['affectedCount'])} THEN",
            f"    RAISE EXCEPTION '{s['id']}: affected_count and the affected list disagree: %', v_res;",
            "  END IF;",
        ]
        if e.get('reason') is not None:
            lines += [
                f"  IF v_res->>'reason' IS DISTINCT FROM {lit(e['reason'])} THEN",
                # The bare value, not `lit()`: a quoted SQL literal inside a
                # single-quoted RAISE message closes the message early.
                f"    RAISE EXCEPTION '{s['id']}: expected reason={e['reason']}, got %', v_res->>'reason';",
                "  END IF;",
            ]
        if e.get('dispositions') is not None:
            literal = 'ARRAY[' + ', '.join(lit(d) for d in sorted(e['dispositions'])) + ']'
            lines += [
                "  SELECT array_agg(DISTINCT x->>'disposition' ORDER BY x->>'disposition')",
                "    INTO v_words FROM jsonb_array_elements(v_res->'affected') x;",
                f"  IF v_words IS DISTINCT FROM {literal} THEN",
                f"    RAISE EXCEPTION '{s['id']}: dispositions were %, expected "
                f"{', '.join(sorted(e['dispositions']))}', v_words;",
                "  END IF;",
            ]
        lines += [
            # **Whether the field survived, read from `fields` by id.** Never
            # from the returned payload: the payload is what a broken RPC would
            # get wrong, so believing it would check a claim against itself.
            "  SELECT count(*) INTO v_n FROM public.fields WHERE id = v_field;",
            f"  IF v_n <> {1 if e['exists'] else 0} THEN",
            f"    RAISE EXCEPTION '{s['id']}: expected the field row to "
            f"{'survive' if e['exists'] else 'be gone'}, found % row(s)', v_n;",
            "  END IF;",
        ]
        if not e['deleted']:
            # A refusal writes NOTHING. Each seeded booking is counted in its
            # own table: a delete that wrongly proceeded either cascades the row
            # away or nulls its field_id, and both make this count zero.
            # A refusal writes NOTHING. Every table the seeding touched must
            # still hold exactly what it held: a delete that wrongly proceeded
            # either cascades rows away or nulls their field_id, and both drop
            # these counts.
            for table, expected in sorted(booking_counts.items()):
                lines += [
                    '  ' + booking_count_sql(table),
                    f"  IF v_n <> {expected} THEN",
                    f"    RAISE EXCEPTION '{s['id']}: a REFUSED delete changed {table} "
                    f"(expected {expected}, found %)', v_n;",
                    "  END IF;",
                ]
    else:
        # **The retirement half's assertions.** These were silently deleted by a
        # refactor of the block above -- a slice that ran from the delete arm's
        # booking loop all the way to `emit_audit_phases`, taking this `else`
        # with it. Nothing in the emitted script complained: it still ran 30
        # scenarios and still checked their audit phases, so the table went on
        # reporting "30 of 30 executed" while saying nothing about `active`.
        #
        # It was caught by `prove.sh`, which planted the two round-3 HIGHs and
        # reported MISATTRIBUTED -- red at the smoke, green at the scenario
        # table -- rather than scoring a catch. That is exactly what the
        # named-check attribution was added for, and it is the second time this
        # PR has been saved by a check that could fail.
        #
        # `assert_every_scenario_is_checked` below now makes the loss loud in
        # the generator itself, so it cannot recur silently.
        lines += [
            "  SELECT active, effective_to INTO v_active, v_eff FROM public.fields WHERE id = v_field;",
            f"  IF v_active IS DISTINCT FROM {lit(s['expect']['active'])} THEN",
            f"    RAISE EXCEPTION '{s['id']}: expected active={lit(s['expect']['active'])}, got %', v_active;",
            "  END IF;",
            f"  IF v_eff IS DISTINCT FROM {date_expr(s['expect']['effectiveTo'])} THEN",
            f"    RAISE EXCEPTION '{s['id']}: expected effective_to={s['expect']['effectiveTo']!r} "
            "days from today, got %', v_eff;",
            "  END IF;",
        ]

    lines += emit_audit_phases(s)
    lines += [
        "  v_ran := v_ran + 1;",
        "",
    ]
    return lines


# **The one field on a blackout scenario that says which RPC it drives.** The
# blackout half had no `rpc` key at all while the field half did, so adding a
# second blackout RPC would have been read as another `create` case by both
# runners -- silently, because neither had a switch to fall off. Every case now
# names it and both runners refuse a name they do not know.
KNOWN_BLACKOUT_RPCS = ('admin_create_field_blackout', 'admin_update_field_blackout')


def emit_estate(scenario, index):
    """One gap B case: the venue and sub-surface depths, against Postgres.

    **The estate is rebuilt for every case.** Half of them WRITE a date, so a
    shared estate would make each case depend on the order the generator
    happened to emit. One venue, two pitches, a sub-surface on the first, and
    three bookings -- a game slot on pitch A at +40, a practice slot on pitch B
    at +50, and a practice slot NAMING the sub-surface at +60. That last one
    also carries pitch A's field_id, because `practice_slots.field_id` is NOT
    NULL, which is precisely why the venue scope and the sub-surface scope
    disagree about it.

    The JS runner in `tests/fieldLifecycleScenarios.test.js` builds the same
    estate from the same table. Neither is measured against the other: both are
    measured against the literals in the JSON.
    """
    sid = scenario['id']
    expect = scenario['expect']
    before = scenario.get('before') or {}
    rpc = scenario['rpc']
    is_venue = rpc.endswith('_location')
    n = index
    out = [f'  -- estate scenario {index}: {sid}']
    out += [
        f"  INSERT INTO public.locations (organization_id, name, effective_to)",
        f"  VALUES (v_org, 'Estate Scenario {n}', {date_expr(before.get('effectiveTo'))})",
        '  RETURNING id INTO v_est_venue;',
        "  INSERT INTO public.fields (organization_id, location_id, name, active)",
        f"  VALUES (v_org, v_est_venue, 'Estate Scenario {n} Pitch A', true)",
        '  RETURNING id INTO v_est_pitch_a;',
        "  INSERT INTO public.fields (organization_id, location_id, name, active)",
        f"  VALUES (v_org, v_est_venue, 'Estate Scenario {n} Pitch B', true)",
        '  RETURNING id INTO v_est_pitch_b;',
        '  INSERT INTO public.field_subunits (organization_id, field_id, label, effective_to)',
        f"  VALUES (v_org, v_est_pitch_a, 'Estate Scenario {n} Pitch A North',"
        f" {date_expr(before.get('subunitEffectiveTo'))})",
        '  RETURNING id INTO v_est_sub;',
        '  INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index)',
        '  VALUES (v_org, v_est_pitch_a, current_date + 40, 1);',
        '  INSERT INTO public.practice_slots'
        ' (organization_id, field_id, day_of_week, start_time, end_time, valid_until)',
        "  VALUES (v_org, v_est_pitch_b, 'tue', '18:00', '19:30', current_date + 50);",
        '  INSERT INTO public.practice_slots'
        ' (organization_id, field_id, field_subunit_id, day_of_week, start_time, end_time, valid_until)',
        "  VALUES (v_org, v_est_pitch_a, v_est_sub, 'wed', '17:00', '18:30', current_date + 60)",
        '  RETURNING id INTO v_est_slot;',
        # A venue that holds NOTHING: no fields, so no sub-surfaces and no
        # bookings. 20260912000000's empty case runs against this one, and it
        # cannot be the main venue -- that one always holds three nodes by
        # design, because every containment assertion is about a NON-empty
        # estate.
        "  INSERT INTO public.locations (organization_id, name, effective_to)",
        f"  VALUES (v_org, 'Estate Scenario {n} Empty', NULL)",
        '  RETURNING id INTO v_est_empty;',
        # A venue holding three nodes whose windows ALL end at +70, so a
        # retirement dated +80 newly closes none of them: three contained
        # entries, contained_count 0. The pair that separates the COUNT from
        # the LIST.
        "  INSERT INTO public.locations (organization_id, name, effective_to)",
        f"  VALUES (v_org, 'Estate Scenario {n} Closed', NULL)",
        '  RETURNING id INTO v_est_closed;',
        "  INSERT INTO public.fields (organization_id, location_id, name, active, effective_to)",
        f"  VALUES (v_org, v_est_closed, 'Estate Scenario {n} Closed Pitch A', true,"
        '   current_date + 70)',
        '  RETURNING id INTO v_est_closed_a;',
        "  INSERT INTO public.fields (organization_id, location_id, name, active, effective_to)",
        f"  VALUES (v_org, v_est_closed, 'Estate Scenario {n} Closed Pitch B', true,"
        '   current_date + 70);',
        '  INSERT INTO public.field_subunits (organization_id, field_id, label, effective_to)',
        f"  VALUES (v_org, v_est_closed_a, 'Estate Scenario {n} Closed Pitch A North',"
        '   current_date + 70);',
        # The seed really landed. A refusal case whose bookings were never
        # inserted would proceed, and the assertion would be about nothing.
        '  IF v_est_venue IS NULL OR v_est_sub IS NULL OR v_est_slot IS NULL',
        '     OR v_est_empty IS NULL OR v_est_closed IS NULL OR v_est_closed_a IS NULL THEN',
        f"    RAISE EXCEPTION '{sid}: the estate this case runs against was never seeded';",
        '  END IF;',
        # **The two empty-case venues are what they claim to be.** An empty
        # venue that silently acquired a field, or a closed venue whose
        # children landed undated, would turn those two cases into tests of the
        # ordinary path scoring a pass.
        '  IF (SELECT count(*) FROM public.fields f WHERE f.location_id = v_est_empty) <> 0 THEN',
        f"    RAISE EXCEPTION '{sid}: the empty venue is not empty';",
        '  END IF;',
        '  IF (SELECT count(*) FROM public.fields f WHERE f.location_id = v_est_closed'
        '      AND f.effective_to = current_date + 70) <> 2 THEN',
        f"    RAISE EXCEPTION '{sid}: the closed venue does not hold two dated pitches';",
        '  END IF;',
    ]

    subject = 'v_est_venue' if is_venue else 'v_est_sub'
    # **An unknown target raises at GENERATION time** rather than silently
    # running the case against the default estate, which is how the blackout
    # generator already handles its own target union.
    target = scenario.get('target')
    if target == 'missing':
        out.append(f"  {subject} := '00000000-0000-0000-0000-0000000000ff'::uuid;")
    elif target == 'emptyVenue':
        out.append(f"  {subject} := v_est_empty;")
    elif target == 'allChildrenDatedVenue':
        out.append(f"  {subject} := v_est_closed;")
    elif target is not None:
        raise SystemExit(f"unknown target {target!r} in estate scenario {sid!r}")

    if is_venue:
        call = (f"public.admin_retire_location(v_org, {subject},"
                f" {date_expr(scenario['args'].get('effectiveTo'))}, {confirm_expr(scenario)})"
                if rpc == 'admin_retire_location'
                else f"public.admin_unretire_location(v_org, {subject})")
    else:
        call = (f"public.admin_retire_field_subunit(v_org, {subject},"
                f" {date_expr(scenario['args'].get('effectiveTo'))}, {confirm_expr(scenario)})"
                if rpc == 'admin_retire_field_subunit'
                else f"public.admin_unretire_field_subunit(v_org, {subject})")

    if not expect['ok']:
        out += [
            '  BEGIN',
            f'    v_res := {call};',
            f"    RAISE EXCEPTION '{sid}: expected a refusal and the call SUCCEEDED';",
            f'  EXCEPTION WHEN {condition_for(scenario)} THEN NULL;',
            '  END;',
        ]
    else:
        out += [f'  v_res := {call};']
        out += [
            f"  IF (v_res->>'retired')::boolean <> {lit(expect['retired'])} THEN",
            f"    RAISE EXCEPTION '{sid}: expected retired={expect['retired']}, got %',"
            " v_res->>'retired';",
            '  END IF;',
        ]
        if 'reason' in expect:
            out += [
                f"  IF v_res->>'reason' IS DISTINCT FROM {lit(expect['reason'])} THEN",
                f"    RAISE EXCEPTION '{sid}: expected reason={expect['reason']}, got %',"
                " v_res->>'reason';",
                '  END IF;',
            ]
        if 'affectedCount' in expect:
            out += [
                f"  IF (v_res->>'affected_count')::int <> {int(expect['affectedCount'])} THEN",
                f"    RAISE EXCEPTION '{sid}: expected {int(expect['affectedCount'])}"
                " affected bookings, got %', v_res->>'affected_count';",
                '  END IF;',
                "  IF jsonb_array_length(v_res->'affected') <>"
                " (v_res->>'affected_count')::int THEN",
                f"    RAISE EXCEPTION '{sid}: affected_count and the affected list disagree';",
                '  END IF;',
            ]
        if 'distinctFields' in expect:
            # **The venue discriminator.** A field-scoped implementation
            # returns rows from one pitch and fails here whatever its count.
            out += [
                "  SELECT count(DISTINCT x->>'field_id') INTO v_n"
                "    FROM jsonb_array_elements(v_res->'affected') x;",
                f"  IF v_n <> {int(expect['distinctFields'])} THEN",
                f"    RAISE EXCEPTION '{sid}: the refusal named % pitch(es), expected"
                f" {int(expect['distinctFields'])}', v_n;",
                '  END IF;',
            ]
        if 'affectedIds' in expect:
            # **The sub-surface discriminator**, by id rather than by count.
            out += [
                "  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'affected') x"
                "                  WHERE x->>'id' = v_est_slot::text) THEN",
                f"    RAISE EXCEPTION '{sid}: the refusal did not name the slot that names"
                " the sub-surface';",
                '  END IF;',
            ]
        if 'containedCount' in expect:
            contained_total = int(expect.get('containedTotal', 3))
            out += [
                f"  IF (v_res->>'contained_count')::int <> {int(expect['containedCount'])} THEN",
                f"    RAISE EXCEPTION '{sid}: expected contained_count"
                f" {int(expect['containedCount'])}, got %', v_res->>'contained_count';",
                '  END IF;',
                # **The LIST and the COUNT are different numbers.** The
                # default estate holds three nodes whatever the count says;
                # the count is how many this call NEWLY closes. Pinning both
                # to 3 would hide an `already_retired` arm that never fires,
                # and the two 20260912000000 cases whose count is 0 while
                # their list is 0 and 3 are the pair that proves the gate
                # reads the count.
                f"  IF jsonb_array_length(v_res->'contained') <> {contained_total} THEN",
                f"    RAISE EXCEPTION '{sid}: expected {contained_total} contained nodes, got %',"
                " jsonb_array_length(v_res->'contained');",
                '  END IF;',
            ]
        out += emit_estate_audit(scenario, subject)

    # The node's own date AFTER the call, asserted on every case including the
    # refusals -- a refusal that wrote the date anyway is the worst outcome.
    if target == 'missing':
        # `subject` was overwritten with the id that resolves to nothing, so
        # the real node cannot be read through it. It is re-resolved by the
        # name this case seeded -- enumerated from the estate rather than from
        # the variable the case deliberately corrupted.
        read_back = ('SELECT l.effective_to INTO v_eff FROM public.locations l'
                     f" WHERE l.name = 'Estate Scenario {n}';"
                     if is_venue
                     else 'SELECT su.effective_to INTO v_eff FROM public.field_subunits su'
                          f" WHERE su.label = 'Estate Scenario {n} Pitch A North';")
    else:
        read_back = (f'SELECT effective_to INTO v_eff FROM public.locations WHERE id = {subject};'
                     if is_venue
                     else 'SELECT effective_to INTO v_eff FROM public.field_subunits'
                          f' WHERE id = {subject};')
    out += [
        f'  {read_back}',
        f"  IF v_eff IS DISTINCT FROM {date_expr(expect['effectiveTo'])} THEN",
        f"    RAISE EXCEPTION '{sid}: expected effective_to={expect['effectiveTo']}, got %',"
        ' v_eff;',
        '  END IF;',
    ]

    if 'childDates' in expect:
        # **Containment, not copy-down.** An implementation that pushed the
        # venue's date onto its fields passes every count above and fails here.
        #
        # **The venue is re-resolved by name, like `read_back` above.** A
        # `target: "missing"` case CLOBBERS `v_est_venue`, so counting children
        # `WHERE f.location_id = v_est_venue` counted the children of a venue
        # that does not exist and could only ever return 0 -- `childDates: 0`
        # passing vacuously on exactly the cases that corrupt the variable,
        # while the JS runner (which keeps `ids.venue`) really checked it. Two
        # runners silently proving different things. Caught by /code-review.
        # **The venue whose children are counted is the one the case
        # ADDRESSED.** Hard-coding `v_est_venue` counted the default estate's
        # children for the two 20260912000000 empty cases, which address other
        # venues -- a check reading a venue the case never touched. `subject`
        # already holds the addressed venue for those.
        if target == 'missing':
            venue_ref = (f"(SELECT l2.id FROM public.locations l2"
                         f" WHERE l2.name = 'Estate Scenario {n}')")
        elif is_venue:
            venue_ref = subject
        else:
            venue_ref = 'v_est_venue'
        out += [
            '  SELECT (SELECT count(*) FROM public.fields f'
            f" WHERE f.location_id = {venue_ref} AND f.effective_to IS NOT NULL)",
            '       + (SELECT count(*) FROM public.field_subunits su'
            '          JOIN public.fields f2 ON f2.id = su.field_id'
            f"          WHERE f2.location_id = {venue_ref} AND su.effective_to IS NOT NULL)",
            '    INTO v_n;',
            f"  IF v_n <> {int(expect['childDates'])} THEN",
            f"    RAISE EXCEPTION '{sid}: expected {int(expect['childDates'])} child node(s)"
            " carrying a date, got %', v_n;",
            '  END IF;',
        ]
    if 'parentDated' in expect:
        out += [
            '  SELECT effective_to INTO v_eff FROM public.fields WHERE id = v_est_pitch_a;',
            f"  IF (v_eff IS NOT NULL) <> {lit(expect['parentDated'])} THEN",
            f"    RAISE EXCEPTION '{sid}: retiring downward wrote upward; the parent pitch"
            " reads %', v_eff;",
            '  END IF;',
        ]

    out += ['  v_ran := v_ran + 1;', '']
    return out


def emit_estate_audit(scenario, subject):
    """The audit phases this estate case must have left behind.

    Read from the table rather than hard-coded in the runner, for the reason
    the field half records: a refused retirement writes `refused` where an
    accepted one writes `before` and `after`, and each runner hard-coding that
    is how the two came to disagree.
    """
    sid = scenario['id']
    wanted = sorted(scenario['expect']['auditPhases'])
    array = ', '.join(lit(phase) for phase in wanted)
    # **Not `{wanted}`.** A Python list repr carries single quotes, which end
    # the SQL string literal they are embedded in -- the generated script did
    # not parse. The message spells the phases without them.
    wanted_text = '+'.join(wanted)
    return [
        "  SELECT array_agg(DISTINCT a.metadata->>'phase' ORDER BY a.metadata->>'phase')",
        '    INTO v_phases FROM public.audit_log a',
        f"   WHERE a.resource_id = {subject} AND a.organization_id = v_org",
        f"     AND a.metadata->>'operation' = {lit(scenario['rpc'])};",
        f'  IF v_phases IS DISTINCT FROM ARRAY[{array}]::text[] THEN',
        f"    RAISE EXCEPTION '{sid}: audit phases were %, expected {wanted_text}', v_phases;",
        '  END IF;',
    ]


def blackout_column_check(scenario, column, expr, wanted):
    """One `IS DISTINCT FROM` assertion on the edited row, with its message."""
    return [
        f"  IF v_bl.{column} IS DISTINCT FROM {expr} THEN",
        f"    RAISE EXCEPTION '{scenario['id']}: expected {column}={wanted}, got %', v_bl.{column};",
        "  END IF;",
    ]


def emit_blackout_update(scenario, loc, fld):
    """An edit case: seed a window through the create RPC, then edit it.

    **The subject is created through `admin_create_field_blackout`, not
    INSERTed.** A row this file hand-built could carry a shape the production
    path never produces, which is the defect LIVE-1 found certified by a passing
    test. It also means the seed is judged by the create RPC's own gates, so a
    scenario whose seed is invalid fails at the seed rather than being read as
    an edit that refused.
    """
    s = scenario
    seed = s['seed']
    a = s['args']
    lines = [
        f"  -- {s['id']}: {s['why']}",
        "  v_res := public.admin_create_field_blackout("
        f"p_organization_id => v_org, p_location_id => {loc}, p_field_id => {fld}, "
        f"p_blackout_from => {date_expr(seed['from'])}, p_blackout_until => {date_expr(seed['until'])}, "
        f"p_start_minutes => {lit(seed.get('startMinutes'))}, "
        f"p_end_minutes => {lit(seed.get('endMinutes'))}, "
        f"p_reason => {lit(seed.get('reason'))}, p_note => {lit(seed.get('note'))});",
        "  v_edit_id := (v_res->>'id')::uuid;",
        "  IF v_edit_id IS NULL THEN",
        f"    RAISE EXCEPTION '{s['id']}: the window this edit acts on was never seeded';",
        "  END IF;",
        "  SELECT count(*) INTO v_before_n FROM public.field_blackouts WHERE organization_id = v_org;",
    ]
    # Which id the edit is aimed at. `import` and `missing` are the two ways an
    # id can fail to be an editable window, and they must NOT get one answer.
    target = s.get('target', 'self')
    if target == 'self':
        lines.append("  v_target := v_edit_id;")
    elif target == 'import':
        lines.append("  v_target := v_import_window;")
    elif target == 'missing':
        lines.append("  v_target := '00000000-0000-0000-0000-0000000000aa'::uuid;")
    else:
        raise SystemExit(f"unknown target {target!r} in scenario {s['id']!r}")

    call = (
        "public.admin_update_field_blackout("
        "p_organization_id => v_org, p_blackout_id => v_target, "
        f"p_blackout_from => {date_expr(a['from'])}, p_blackout_until => {date_expr(a['until'])}, "
        f"p_start_minutes => {lit(a.get('startMinutes'))}, "
        f"p_end_minutes => {lit(a.get('endMinutes'))}, "
        f"p_reason => {lit(a.get('reason'))}, p_note => {lit(a.get('note'))})"
    )

    if not s['expect']['ok']:
        lines += [
            "  BEGIN",
            f"    v_res := {call};",
            f"    RAISE EXCEPTION '{s['id']}: expected a refusal and the edit SUCCEEDED';",
            f"  EXCEPTION WHEN {condition_for(s)} THEN NULL;",
            "  END;",
            # A refusal writes NOTHING -- checked on the SEEDED window, which is
            # the row a half-applied edit would have damaged, and read back from
            # the table rather than from the payload.
            "  SELECT * INTO v_bl FROM public.field_blackouts WHERE id = v_edit_id;",
        ]
        lines += blackout_column_check(s, 'blackout_from', date_expr(seed['from']),
                                       f"seed day {seed['from']}")
        lines += blackout_column_check(s, 'blackout_until', date_expr(seed['until']),
                                       f"seed day {seed['until']}")
        lines += blackout_column_check(s, 'start_minutes', lit(seed.get('startMinutes')),
                                       f"seed {seed.get('startMinutes')}")
        lines += [
            "  SELECT count(*) INTO v_n FROM public.field_blackouts WHERE organization_id = v_org;",
            "  IF v_n <> v_before_n THEN",
            f"    RAISE EXCEPTION '{s['id']}: a refused edit changed the window count (% -> %)',",
            "      v_before_n, v_n;",
            "  END IF;",
            "  v_ran := v_ran + 1;",
            "",
        ]
        return lines

    e = s['expect']['after']
    lines += [
        f"  v_res := {call};",
        # **The id is the whole migration.** A delete-and-re-add returns a new
        # one; this must return the one that went in.
        "  IF (v_res->>'id')::uuid IS DISTINCT FROM v_edit_id THEN",
        f"    RAISE EXCEPTION '{s['id']}: the edit returned a different id (% vs %)',",
        "      v_res->>'id', v_edit_id;",
        "  END IF;",
        # ... and the payload is never believed about the row count.
        "  SELECT count(*) INTO v_n FROM public.field_blackouts WHERE organization_id = v_org;",
        "  IF v_n <> v_before_n THEN",
        f"    RAISE EXCEPTION '{s['id']}: the edit changed the window count (% -> %)',",
        "      v_before_n, v_n;",
        "  END IF;",
        "  SELECT * INTO v_bl FROM public.field_blackouts WHERE id = v_edit_id;",
    ]
    lines += blackout_column_check(s, 'blackout_from', date_expr(e['from']), f"day {e['from']}")
    lines += blackout_column_check(s, 'blackout_until', date_expr(e['until']), f"day {e['until']}")
    lines += blackout_column_check(s, 'start_minutes', lit(e.get('startMinutes')),
                                   str(e.get('startMinutes')))
    lines += blackout_column_check(s, 'end_minutes', lit(e.get('endMinutes')),
                                   str(e.get('endMinutes')))
    lines += blackout_column_check(s, 'reason', lit(e.get('reason')), str(e.get('reason')))
    lines += blackout_column_check(s, 'note', lit(e.get('note')), str(e.get('note')))
    lines += emit_audit_phases(s, subject='v_edit_id')
    lines += ["  v_ran := v_ran + 1;", ""]
    return lines


def emit_blackout(scenario, index):
    s = scenario
    scopes = {
        'location': ('v_loc', 'NULL::uuid'),
        'field': ('NULL::uuid', 'v_field'),
        'both': ('v_loc', 'v_field'),
        'neither': ('NULL::uuid', 'NULL::uuid'),
    }
    if s['scope'] not in scopes:
        raise SystemExit(f"unknown scope {s['scope']!r} in scenario {s['id']!r}")
    loc, fld = scopes[s['scope']]
    # Every switch over a union throws on the value it does not know.
    if s.get('rpc') not in KNOWN_BLACKOUT_RPCS:
        raise SystemExit(f"unknown blackout rpc {s.get('rpc')!r} in scenario {s['id']!r}")
    if s['rpc'] == 'admin_update_field_blackout':
        return emit_blackout_update(s, loc, fld)
    a = s['args']
    # **Named notation, not positional.** The first version passed these
    # positionally and put `p_reason` where `p_start_minutes` belongs, so every
    # blackout scenario failed with `invalid input syntax for type integer:
    # "maintenance"`. Positional arguments across a nine-parameter signature are
    # a fact about the migration that this generator would have to keep in step
    # by hand -- the same "two producers that agreed once" shape the scenario
    # table exists to remove. Named arguments make the order the database's
    # business, and a renamed parameter fails loudly instead of silently
    # shifting every value along one.
    call = (
        "public.admin_create_field_blackout("
        f"p_organization_id => v_org, p_location_id => {loc}, p_field_id => {fld}, "
        f"p_blackout_from => {date_expr(a['from'])}, p_blackout_until => {date_expr(a['until'])}, "
        f"p_start_minutes => {lit(a.get('startMinutes'))}, "
        f"p_end_minutes => {lit(a.get('endMinutes'))}, "
        f"p_reason => {lit(a.get('reason'))}, p_note => NULL)"
    )
    lines = [f"  -- {s['id']}: {s['why']}",
             "  SELECT count(*) INTO v_before_n FROM public.field_blackouts WHERE organization_id = v_org;"]
    if s['expect']['ok']:
        lines += [
            f"  v_res := {call};",
            "  SELECT count(*) INTO v_n FROM public.field_blackouts WHERE organization_id = v_org;",
            "  IF v_n <> v_before_n + 1 THEN",
            f"    RAISE EXCEPTION '{s['id']}: expected the blackout to be accepted, count went % -> %',",
            "      v_before_n, v_n;",
            "  END IF;",
        ]
    else:
        lines += [
            "  BEGIN",
            f"    v_res := {call};",
            f"    RAISE EXCEPTION '{s['id']}: expected a refusal and the row was ACCEPTED';",
            # **The one condition this scenario names**, from the table, so both
            # runners enforce the same thing. A row refused because the caller
            # lost its admin role (42501) or the id did not resolve (P0002) was
            # refused for a reason unrelated to what the scenario tests, and a
            # broad handler would score that as a pass. The first draft caught
            # `raise_exception`, the catch-all for an un-coded RAISE, and would
            # have done exactly that.
            f"  EXCEPTION WHEN {condition_for(s)} THEN",
            "    NULL;",
            "  END;",
            "  SELECT count(*) INTO v_n FROM public.field_blackouts WHERE organization_id = v_org;",
            "  IF v_n <> v_before_n THEN",
            f"    RAISE EXCEPTION '{s['id']}: a refused blackout still wrote a row (% -> %)',",
            "      v_before_n, v_n;",
            "  END IF;",
        ]
    lines += ["  v_ran := v_ran + 1;", ""]
    return lines


def main():
    with open(TABLE_PATH, encoding='utf8') as handle:
        table = json.load(handle)

    fields = table['fieldScenarios']
    blackouts = table['blackoutScenarios']
    # 8.4 gap B: the venue and sub-surface depths. A third section rather than
    # more `fieldScenarios`, because their SUBJECT is a different node -- a
    # case naming a venue cannot be run by an emitter that seeds a field and
    # passes p_field_id.
    estates = table['estateScenarios']
    total = len(fields) + len(blackouts) + len(estates)
    if total == 0:
        raise SystemExit('the scenario table is empty; refusing to emit a script that tests nothing')

    out = [
        '-- GENERATED by scripts/dbharness/scenarios.py from',
        '-- tests/fixtures/fieldLifecycleScenarios.json. Do not edit; edit the table.',
        '\\set ON_ERROR_STOP on',
        'DO $scenarios$',
        'DECLARE',
        '  v_org uuid; v_loc uuid; v_field uuid; v_user uuid := gen_random_uuid();',
        '  v_res jsonb; v_active boolean; v_eff date; v_n int; v_before_n int; v_ran int := 0;',
        '  v_team uuid; v_team_b uuid; v_season uuid; v_div uuid;',
        '  v_phases text[]; v_words text[]; v_seed_slot uuid;',
        # 8.4 gap A: the edit cases need the window they edit, the id the call
        # is aimed at, the row read back from the table, and one import-owned
        # window to be refused on.
        '  v_edit_id uuid; v_target uuid; v_import_window uuid;',
        '  v_bl public.field_blackouts%ROWTYPE; v_profile uuid;',
        # 8.4 gap B: one venue, two pitches and a sub-surface per estate case,
        # rebuilt for each so a case that writes a date cannot change the one
        # after it.
        '  v_est_venue uuid; v_est_pitch_a uuid; v_est_pitch_b uuid;',
        '  v_est_sub uuid; v_est_slot uuid;',
        '  v_est_empty uuid; v_est_closed uuid; v_est_closed_a uuid;',
        'BEGIN',
        "  INSERT INTO auth.users (id, email, raw_user_meta_data)",
        "  VALUES (v_user, 'scenarios@example.test', jsonb_build_object('password_length', 16))",
        '  ON CONFLICT DO NOTHING;',
        "  INSERT INTO public.organizations (name, slug) VALUES ('Scenario Org','scenario-org')",
        '  RETURNING id INTO v_org;',
        "  INSERT INTO public.profiles (id, email) VALUES (v_user, 'scenarios@example.test')",
        '  ON CONFLICT DO NOTHING;',
        '  INSERT INTO public.organization_members (organization_id, profile_id, role)',
        "  VALUES (v_org, v_user, 'admin');",
        "  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);",
        "  INSERT INTO public.locations (organization_id, name) VALUES (v_org,'Scenario Park')",
        '  RETURNING id INTO v_loc;',
        # `practice_assignments.team_id` is NOT NULL and references `teams`,
        # which needs a division, which needs a season. Built once, here, so a
        # delete scenario can seed the fourth booking kind at all -- the kind
        # whose column had no foreign key, which is the whole subject of
        # 20260907000000.
        "  INSERT INTO public.season_settings (organization_id, name)",
        "  VALUES (v_org, 'Scenario Season') RETURNING id INTO v_season;",
        "  INSERT INTO public.divisions (organization_id, season_settings_id, name)",
        "  VALUES (v_org, v_season, 'Scenario Division') RETURNING id INTO v_div;",
        "  INSERT INTO public.teams (organization_id, division_id, name)",
        "  VALUES (v_org, v_div, 'Scenario Team') RETURNING id INTO v_team;",
        # `games` has a CHECK that the two teams differ, so the composite seed
        # needs a second one.
        "  INSERT INTO public.teams (organization_id, division_id, name)",
        "  VALUES (v_org, v_div, 'Scenario Team B') RETURNING id INTO v_team_b;",
        '',
    ]
    for i, scenario in enumerate(fields, start=1):
        out += emit_field(scenario, i)

    # The blackout scenarios need one field to scope to.
    out += [
        '  -- One pitch for the blackout scenarios to scope to.',
        "  INSERT INTO public.fields (organization_id, location_id, name)",
        "  VALUES (v_org, v_loc, 'Blackout Pitch') RETURNING id INTO v_field;",
        # **One import-owned window, so the frozen refusal has a real subject.**
        # `field_blackout_windows` is the FROZEN table, written only by the
        # import path, so this is INSERTed directly -- there is no RPC that
        # would, which is the whole reason the edit path has to refuse it.
        '  INSERT INTO public.field_availability_profiles',
        '    (organization_id, season_label, field_id, location, field_name, available_from, available_until)',
        "  VALUES (v_org, 'Scenario Season', v_field, 'Scenario Park', 'Blackout Pitch',",
        '          current_date, current_date + 120) RETURNING id INTO v_profile;',
        '  INSERT INTO public.field_blackout_windows',
        '    (organization_id, profile_id, blackout_from, blackout_until, reason)',
        "  VALUES (v_org, v_profile, current_date + 40, current_date + 50, 'blackout_months')",
        '  RETURNING id INTO v_import_window;',
        '  IF v_import_window IS NULL THEN',
        "    RAISE EXCEPTION 'the import-owned window the frozen-refusal case needs was not seeded';",
        '  END IF;',
        '',
    ]
    for i, scenario in enumerate(blackouts, start=1):
        out += emit_blackout(scenario, i)

    for i, scenario in enumerate(estates, start=1):
        out += emit_estate(scenario, i)

    # **Every accepted scenario must EMIT the assertion its shape requires.**
    #
    # `v_ran` counts cases that RAN, not cases that were checked, so a case
    # whose assertions went missing still increments it and the script still
    # reports "N of N executed". That is precisely what happened: a refactor
    # deleted the retire arm's `active` and `effective_to` checks and the only
    # thing that noticed was a mutation plant coming back MISATTRIBUTED.
    #
    # So the generator now reads its own output back. A retire or unretire case
    # must produce an `expected active=` line; a delete case must produce an
    # `expected deleted=` line. Zero matches for a scenario is a loud failure
    # here rather than a quiet one three checks downstream.
    # **Both halves, and every marker each case owes.** The first version of
    # this guard covered `fieldScenarios` only and demanded one marker per case
    # -- so `emit_blackout` kept exactly the unguarded `v_ran` shape the guard
    # had just been written to remove, one function along in the same file. The
    # markers are listed per case now, so a case that stops asserting ANY of the
    # things its shape owes fails here.
    body = '\n'.join(out)

    def markers_for(scenario, half):
        """Every assertion message this scenario must have emitted."""
        sid = scenario['id']
        # 8.4 gap A: the edit cases owe a different set from the create cases,
        # and listing them here is what stops an edit case running with fewer
        # assertions than its shape requires -- the `v_ran` hole this whole
        # guard exists for, one RPC along.
        if half == 'blackout' and scenario['rpc'] == 'admin_update_field_blackout':
            if not scenario['expect']['ok']:
                return [
                    f'{sid}: expected a refusal and the edit SUCCEEDED',
                    f'{sid}: expected blackout_from=',
                    f'{sid}: a refused edit changed the window count',
                ]
            return [
                f'{sid}: the edit returned a different id',
                f'{sid}: the edit changed the window count',
                f'{sid}: expected blackout_from=',
                f'{sid}: expected start_minutes=',
                f'{sid}: expected note=',
                f'{sid}: audit phases were',
            ]
        if half == 'estate':
            # **Every assertion an estate case owes, listed per shape.** The
            # `v_ran` hole this guard exists for is a case that runs with its
            # checks deleted and still reports "N of N executed"; listing the
            # markers per case is what stops it, and the discriminators
            # (`distinctFields`, `affectedIds`, `childDates`) are listed
            # separately from the counts because those are the three
            # assertions the wrong implementations fail.
            expect = scenario['expect']
            if not expect['ok']:
                markers = [f'{sid}: expected a refusal and the call SUCCEEDED']
            else:
                markers = [
                    f'{sid}: expected retired=',
                    f'{sid}: audit phases were',
                ]
                if 'affectedCount' in expect:
                    markers.append(f'{sid}: expected {int(expect["affectedCount"])} affected')
                    markers.append(f'{sid}: affected_count and the affected list disagree')
                if 'distinctFields' in expect:
                    markers.append(f'{sid}: the refusal named % pitch(es)')
                if 'affectedIds' in expect:
                    markers.append(f'{sid}: the refusal did not name the slot')
                if 'containedCount' in expect:
                    markers.append(f'{sid}: expected contained_count')
            markers.append(f'{sid}: expected effective_to=')
            if 'childDates' in expect:
                markers.append(f'{sid}: expected {int(expect["childDates"])} child node(s)')
            if 'parentDated' in expect:
                markers.append(f'{sid}: retiring downward wrote upward')
            return markers
        if not scenario['expect']['ok']:
            # A refusal case owes its "expected a refusal" assertion, and on the
            # blackout half also the "nothing was written" one.
            return (
                [f'{sid}: expected a refusal and the call SUCCEEDED']
                if half == 'field'
                else [
                    f'{sid}: expected a refusal and the row was ACCEPTED',
                    f'{sid}: a refused blackout still wrote a row',
                ]
            )
        if half == 'blackout':
            return [f'{sid}: expected the blackout to be accepted']
        if scenario['rpc'] == 'admin_delete_field':
            # **The delete arm owes as much as the retire arm does.** This
            # branch used to demand two markers where the retire branch demanded
            # three, which left the delete arm's affected-count, count/list
            # agreement, survival and refusal-wrote-nothing checks entirely
            # unguarded -- so the very refactor this guard was written after,
            # applied to the delete arm instead, would still have produced a
            # script reporting "N of N executed" and saying nothing about them.
            expect = scenario['expect']
            markers = [
                f'{sid}: expected deleted=',
                f'{sid}: expected {int(expect["affectedCount"])} affected bookings',
                f'{sid}: affected_count and the affected list disagree',
                f'{sid}: expected the field row to '
                f'{"survive" if expect["exists"] else "be gone"}',
                f'{sid}: audit phases were',
            ]
            if expect.get('reason') is not None:
                markers.append(f'{sid}: expected reason={expect["reason"]}')
            if expect.get('dispositions') is not None:
                markers.append(f'{sid}: dispositions were')
            if not expect['deleted']:
                # One per table the seeding touched, recomputed from the table
                # rather than read back out of the emitter -- deriving the
                # expected set from the code a break would corrupt is what makes
                # a guard agree with the thing it is guarding.
                for kind in scenario.get('bookings') or []:
                    tables = (
                        [table for _statement, table in COMPOSITE_SEEDS[kind]]
                        if kind in COMPOSITE_SEEDS
                        else [BOOKING_TABLES[kind]]
                    )
                    for table in tables:
                        markers.append(f'{sid}: a REFUSED delete changed {table}')
            return markers
        return [
            f'{sid}: expected active=',
            f'{sid}: expected effective_to=',
            f'{sid}: audit phases were',
        ]

    for half, cases in (('field', fields), ('blackout', blackouts), ('estate', estates)):
        for scenario in cases:
            for marker in markers_for(scenario, half):
                if marker not in body:
                    raise SystemExit(
                        f"scenario {scenario['id']!r} emitted no {marker.split(': ', 1)[1]!r} "
                        'assertion; the generator would produce a script that runs '
                        'the case and checks less about it than its shape owes'
                    )

    out += [
        # **A run that judged fewer cases than the table holds is a failure.**
        # Without this, a generator bug that emitted no cases would produce a
        # script that exits 0 having asserted nothing -- the vacuous shape this
        # whole phase exists to stop.
        f'  IF v_ran <> {total} THEN',
        f"    RAISE EXCEPTION 'ran % scenarios, the table holds {total}', v_ran;",
        '  END IF;',
        f"  RAISE NOTICE 'scenario table: % of {total} scenarios executed against Postgres', v_ran;",
        '  DELETE FROM public.organizations WHERE id = v_org;',
        '  DELETE FROM auth.users WHERE id = v_user;',
        'END $scenarios$;',
    ]
    sys.stdout.write('\n'.join(out) + '\n')


if __name__ == '__main__':
    main()
