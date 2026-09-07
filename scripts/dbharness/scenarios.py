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
BOOKING_SEEDS = {
    'game_slot':
        "INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index) "
        "VALUES (v_org, %(field)s, current_date + 30, 1);",
    'game_assignment':
        'INSERT INTO public.game_assignments (organization_id, field_id, "start", week_index) '
        "VALUES (v_org, %(field)s, timezone('utc', now()) + interval '30 days', 1);",
    'practice_slot':
        "INSERT INTO public.practice_slots "
        "(organization_id, field_id, day_of_week, start_time, end_time, valid_until) "
        "VALUES (v_org, %(field)s, 'mon', '18:00', '19:30', current_date + 60);",
    'practice_assignment':
        "INSERT INTO public.practice_assignments "
        "(organization_id, team_id, field_id, effective_date_range) "
        "VALUES (v_org, v_team, %(field)s, daterange(current_date, current_date + 60, '[]'));",
}

# The table each kind lives in, for counting survivors after a refusal.
BOOKING_TABLES = {
    'game_slot': 'game_slots',
    'game_assignment': 'game_assignments',
    'practice_slot': 'practice_slots',
    'practice_assignment': 'practice_assignments',
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
         "VALUES (v_org, %(field)s, current_date + 30, 1) RETURNING id INTO v_seed_slot;",
         'game_slots'),
        ('INSERT INTO public.game_assignments '
         '(organization_id, field_id, game_slot_id, slot_id, "start", week_index) '
         "VALUES (v_org, %(field)s, v_seed_slot, v_seed_slot, "
         "timezone('utc', now()) + interval '30 days', 1);",
         'game_assignments'),
        ("INSERT INTO public.games (organization_id, game_slot_id, home_team_id, away_team_id) "
         "VALUES (v_org, v_seed_slot, v_team, v_team_b);",
         'games'),
    ],
    'scheduled_practice': [
        ("INSERT INTO public.practice_slots "
         "(organization_id, field_id, day_of_week, start_time, end_time, valid_until) "
         "VALUES (v_org, %(field)s, 'mon', '18:00', '19:30', current_date + 60) "
         "RETURNING id INTO v_seed_slot;",
         'practice_slots'),
        ("INSERT INTO public.practice_assignments "
         "(organization_id, team_id, field_id, practice_slot_id, slot_id, effective_date_range) "
         "VALUES (v_org, v_team, %(field)s, v_seed_slot, v_seed_slot, "
         "daterange(current_date, current_date + 60, '[]'));",
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
        if kind in COMPOSITE_SEEDS:
            for statement, table in COMPOSITE_SEEDS[kind]:
                lines.append('  ' + statement % {'field': target})
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
        lines.append('  ' + BOOKING_SEEDS[kind] % {'field': target})
        expected = seeded(table)
        lines += [
            '  ' + booking_count_sql(table),
            f"  IF v_n <> {expected} THEN",
            f"    RAISE EXCEPTION '{scenario['id']}: the {kind} seed did not land "
            f"(expected {expected}, found %)', v_n;",
            "  END IF;",
        ]
    return lines, counts


def emit_audit_phases(scenario):
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
        f"   WHERE resource_id = v_field AND metadata->>'operation' = {lit(scenario['rpc'])};",
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
    total = len(fields) + len(blackouts)
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
        '',
    ]
    for i, scenario in enumerate(blackouts, start=1):
        out += emit_blackout(scenario, i)

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

    for half, cases in (('field', fields), ('blackout', blackouts)):
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
