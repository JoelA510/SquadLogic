/**
 * Placeholders, reservations and capacity — Prompt 5.1.
 *
 * > *"Add first-class support for scheduled things that aren't fully known yet.
 * > Three distinct kinds appeared in the source project and all were handled
 * > with ad-hoc string hacks."*
 *
 * Three acceptance tests, and every figure in them is computed at test time from
 * `fixtures/season-2026/`:
 *
 * 1. **Assigning teams to an unnamed slot leaves its time and field unchanged.**
 *    Asserted on the *rendered footprint string*, byte for byte, before and
 *    after — not on "still legal" — with a positive control proving the check
 *    can fail.
 * 2. **An unplaced fixture appears in totals and exports with its reason.** Run
 *    twice, once from a `placement/` harness run and once from a real
 *    `resolve/applyChangeRequest()` that strands a game on the corpus's own
 *    permit blackout, with a positive control proving the accounting catches a
 *    dropped fixture.
 * 3. **The capacity report reproduces the ReserveCapacity figures**: 14-18 slots
 *    per week against a 10-game cap, conditional slots counted separately from
 *    unconditional ones, and sunset identified as what trims the two November
 *    dates to the bare minimum.
 *
 * Where a scenario had to be built rather than found, the test says so in the
 * word "constructed" and says what the corpus supplied.
 */

import { describe, it, expect } from 'vitest';

import { buildAvailabilityCalendarFromSeason2026 } from '@squadlogic/core/availability/index.js';
import {
  SEASON_2026_CONSTRAINT_ID,
  buildSeason2026ConstraintRegistry,
} from '@squadlogic/core/constraints/index.js';
import {
  FACILITY_REASON,
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
  findFacilityConflicts,
  season2026SurfaceId,
  surfacesConflict,
} from '@squadlogic/core/facility/index.js';
import {
  loadExternalFixtures,
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import {
  replaceGamesUnderRegistry,
  toSeason2026PlacementInput,
} from '@squadlogic/core/placement/index.js';
import {
  applyChangeRequest,
  reoptimiseWholeSeason,
  season2026ExternalFixtureChanges,
} from '@squadlogic/core/resolve/index.js';
import { toSeason2026Schedule } from '@squadlogic/core/ruleEngine/index.js';
import { buildFormatTimingTableFromSeason2026 } from '@squadlogic/core/timing/index.js';

import { SCHEDULE_EXPORT_HEADERS } from '@squadlogic/core/outputGeneration.js';

import {
  CONDITION_VERDICT,
  FIXTURE_SIDE,
  PUBLICATION_TBD,
  RESERVE_KIND,
  RESERVE_REASON,
  RESERVE_REASON_SEVERITY,
  RESERVE_SEVERITY,
  RESERVE_STATUS,
  SEASON_2026_EARLIEST_KICKOFF_MINUTES,
  SEASON_2026_KIND,
  SEASON_2026_LEAGUE_CAP_PER_DATE,
  SEASON_2026_RESERVE_FORMAT,
  SLOT_CONDITION_KIND,
  SLOT_FOOTPRINT_FIELDS,
  accountForFixtures,
  applySlotBindings,
  buildReserveCapacityReport,
  checkSlotsUnmoved,
  conditionForSurface,
  createReserveMeta,
  describeSlotCondition,
  deriveReserveStatus,
  evaluateSlotCondition,
  makeReserveFinding,
  makeReservedSlot,
  makeUnplacedFixture,
  mergeReserveMeta,
  naiveDateTime,
  publicationCoverageFindings,
  publicationRowsFor,
  reserveSeverityOf,
  reservedSlotFootprint,
  season2026CapacityRequirement,
  season2026FixtureSides,
  season2026ReserveBookings,
  season2026ReserveCapacityInput,
  season2026ReservedSlots,
  season2026SelectTeamIds,
  slotIsSettled,
  slotNamesATeam,
  slotsToBookings,
  summariseSlots,
  unplacedFromPlacementRun,
  unplacedFromResolveRun,
} from '@squadlogic/core/reserve/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus and engines, loaded once                                             */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const graph = buildFacilityGraphFromSeason2026(loadFacilityGeometry());
const table = buildFormatTimingTableFromSeason2026(loadGameFormats());
const sunsets = loadSunsets();
/** Derived from the corpus rather than typed in, so a re-dated fixture moves it. */
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const calendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: SEASON_YEAR }),
  sunsets
);
const registry = buildSeason2026ConstraintRegistry();
const resources = {
  graph,
  timingTable: table,
  calendar,
  venueComplexes: buildSeason2026VenueComplexMap(),
};
const engines = { graph, table, calendar, registry, resources };

const schedule = toSeason2026Schedule(season);
const teamUniverse = season.teams.map((team) => String(team.id));

const slots = season2026ReservedSlots(season.combinedGames, { graph, teamUniverse });
const capacityInput = season2026ReserveCapacityInput(season, { graph, table });
const report = buildReserveCapacityReport({ graph, table, calendar, registry }, capacityInput);

const selectTeamIds = season2026SelectTeamIds(season.teams);
const unnamed = slots.filter((slot) => slot.kind === RESERVE_KIND.UNNAMED_FIXTURE);
const reservations = slots.filter((slot) => slot.kind === RESERVE_KIND.RESERVATION);

/** Every date the corpus reserved league slots on, from the rows themselves. */
const reservedDates = [...new Set(unnamed.map((slot) => slot.date))].sort();

/**
 * Every reason code this suite actually saw emitted.
 *
 * The last test in the file asserts it covers `RESERVE_REASON` completely. A
 * code the module can declare but never produce is a code nothing proves the
 * meaning of, and the registry's `declared-only` distinction exists because that
 * gap is where hollow guarantees live.
 *
 * @type {Set<string>}
 */
const OBSERVED = new Set();

/**
 * @template {{ code: string }} T
 * @param {ReadonlyArray<T>} findings
 * @returns {ReadonlyArray<T>}
 */
function observe(findings) {
  for (const finding of findings) OBSERVED.add(finding.code);
  return findings;
}

/* -------------------------------------------------------------------------- */
/* The corpus supplies all three kinds                                         */
/* -------------------------------------------------------------------------- */

describe('reserve :: what the corpus actually contains', () => {
  it('finds the 100 unnamed league fixtures and the single field reservation', () => {
    const summary = summariseSlots(slots);
    expect(summary.total).toBe(101);
    expect(summary.byKind[RESERVE_KIND.UNNAMED_FIXTURE]).toBe(100);
    expect(summary.byKind[RESERVE_KIND.RESERVATION]).toBe(1);

    // Ten dates, ten slots each: the shape the external cap produces.
    expect(reservedDates).toHaveLength(10);
    for (const date of reservedDates) {
      expect(summary.byDate[date]).toBeGreaterThanOrEqual(SEASON_2026_LEAGUE_CAP_PER_DATE);
    }

    // Not one of them names a team yet. `assigned` in the capacity report is
    // therefore zero everywhere, which is what makes acceptance test 1 mean
    // something.
    expect(summary.settled).toBe(0);
    expect(summary.awaitingTeams).toBe(101);

    // The one reservation is not a game: it is held ground with a purpose.
    expect(reservations).toHaveLength(1);
    expect(reservations[0].purpose).toBe('Scrimmage');
    expect(reservations[0].label).toMatch(/TBD/);
    // And GAP-14 survives it: `Scrimmage` has no `game_formats.csv` row, so its
    // footprint is genuinely unknown rather than invented.
    expect(reservations[0].endMinutes).toBeNull();
  });

  it('tells apart the four things the corpus spells with one dash', () => {
    // The `Away` column carries `-` for a Minis session, a reserved league slot
    // and the field reservation alike, and a real visiting club everywhere else.
    // The loader's row kind is what disambiguates it; nothing here parses `-`.
    const byKind = new Map();
    for (const row of season.combinedGames) {
      const sides = season2026FixtureSides(row, { teamUniverse });
      const key = `${row.kind}|${sides.homeSide}|${sides.awaySide}`;
      byKind.set(key, (byKind.get(key) ?? 0) + 1);
    }

    const total = [...byKind.values()].reduce((sum, n) => sum + n, 0);
    // Meta-assertion: the classification is total. Every one of the corpus's
    // rows got a pair of side kinds, so a row kind added later cannot slip
    // through unclassified.
    expect(total).toBe(season.combinedGames.length);
    expect(total).toBe(679);

    const countOf = (predicate) =>
      [...byKind.entries()]
        .filter(([key]) => predicate(key.split('|')))
        .reduce((sum, [, n]) => sum + n, 0);

    // GAP-15: a Minis session's opponent does not exist, and the session itself
    // is not a rostered team.
    expect(countOf(([kind]) => kind === 'minis_session')).toBe(36);
    expect(
      countOf(
        ([kind, home, away]) =>
          kind === 'minis_session' && home === FIXTURE_SIDE.SESSION && away === FIXTURE_SIDE.NONE
      )
    ).toBe(36);

    // GAP-16 / GAP-17: a reserved slot's opponent is not yet known.
    expect(
      countOf(
        ([kind, home, away]) =>
          kind === 'league_placeholder' && home === FIXTURE_SIDE.TBD && away === FIXTURE_SIDE.TBD
      )
    ).toBe(100);
    expect(
      countOf(
        ([kind, home, away]) =>
          kind === 'reservation' && home === FIXTURE_SIDE.TBD && away === FIXTURE_SIDE.TBD
      )
    ).toBe(1);

    // GAP-18: a visiting club is a named opponent with no identity in this
    // system — five of the eight seeding fixtures.
    expect(
      countOf(([kind, , away]) => kind === 'external_fixture' && away === FIXTURE_SIDE.EXTERNAL)
    ).toBe(5);
    expect(
      countOf(([kind, , away]) => kind === 'external_fixture' && away === FIXTURE_SIDE.TEAM)
    ).toBe(3);

    // The distinction is real and not cosmetic: `none` and `tbd` are both
    // spelled `-` in the source file and land in different buckets here.
    const dashRows = season.combinedGames.filter((row) => row.awayLabel === '-');
    expect(dashRows.length).toBe(36 + 100 + 1);
    const dashSides = new Set(
      dashRows.map((row) => season2026FixtureSides(row, { teamUniverse }).awaySide)
    );
    expect([...dashSides].sort()).toEqual([FIXTURE_SIDE.NONE, FIXTURE_SIDE.TBD]);
  });

  it('carries a reserved slot as a booking, so held ground still blocks a field', () => {
    // GAP-17's point: the reservation is not a game and it still occupies Alder
    // Park Pitch 2, which overlaps Pitch 1.
    const pitch2 = season2026SurfaceId('Alder Park', 'Pitch 2');
    expect(reservations[0].surfaceId).toBe(pitch2);
    expect(
      surfacesConflict(graph, pitch2, season2026SurfaceId('Alder Park', 'Pitch 1A')).code
    ).toBe(FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP);
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance 1 — binding teams never moves a slot                             */
/* -------------------------------------------------------------------------- */

describe('acceptance 1 :: assigning teams to an unnamed slot leaves its time and field unchanged', () => {
  /**
   * Bindings for every one of the 100 unnamed fixtures, built by dealing the
   * Select teams round-robin across each date's slots. Constructed — the corpus
   * records the season *before* the league published its picks, which is the
   * whole reason these rows exist — but the slots, the dates and the team codes
   * are all the corpus's own.
   */
  const bindings = [];
  for (const date of reservedDates) {
    const onDate = unnamed
      .filter((slot) => slot.date === date)
      .sort((a, b) => a.id.localeCompare(b.id));
    onDate.forEach((slot, index) => {
      bindings.push({
        slotId: slot.id,
        homeTeamId: selectTeamIds[(index * 2) % selectTeamIds.length],
        awayTeamId: selectTeamIds[(index * 2 + 1) % selectTeamIds.length],
      });
    });
  }

  const result = applySlotBindings(unnamed, bindings, { teamUniverse });

  it('binds all 100 slots and refuses none', () => {
    expect(bindings).toHaveLength(100);
    expect(result.meta.bindingsApplied).toBe(100);
    expect(result.meta.bindingsRefused).toBe(0);
    expect(result.boundSlotIds).toHaveLength(100);
    expect(result.slots.every((slot) => slotIsSettled(slot))).toBe(true);
    expect(result.status).not.toBe(RESERVE_STATUS.REJECTED);
  });

  it('leaves every footprint byte-identical, not merely still legal', () => {
    const before = new Map(unnamed.map((slot) => [slot.id, reservedSlotFootprint(slot)]));
    const after = new Map(result.slots.map((slot) => [slot.id, reservedSlotFootprint(slot)]));

    // Byte-for-byte on the rendered footprint. "Still legal somewhere else" is
    // exactly the outcome this assertion has to exclude: the club published this
    // field and this kickoff before knowing who would play in it.
    expect(after.size).toBe(before.size);
    expect(after.size).toBe(100);
    for (const [slotId, footprint] of before) {
      expect(after.get(slotId)).toBe(footprint);
    }

    // …and the module said so itself, on the production path.
    const unmoved = observe(result.findings).filter(
      (finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_UNMOVED
    );
    expect(unmoved).toHaveLength(1);
    expect(unmoved[0].details.pairsCompared).toBe(100);
    expect(unmoved[0].details.moved).toBe(0);
    expect(result.meta.slotsMoved).toBe(0);
    expect(result.meta.slotPairsCompared).toBe(100);
    expect(
      result.findings.some((finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_MOVED)
    ).toBe(false);
  });

  it('changes exactly the occupant fields and nothing else', () => {
    const byId = new Map(result.slots.map((slot) => [slot.id, slot]));
    const changed = new Set();
    for (const slot of unnamed) {
      const bound = /** @type {Object} */ (byId.get(slot.id));
      for (const key of Object.keys(slot)) {
        if (JSON.stringify(slot[key]) !== JSON.stringify(bound[key])) changed.add(key);
      }
    }
    // `awayLabel` was already null — the corpus's away cell is the `-` token,
    // which is not display text — so naming the away team leaves it null. The
    // home label was `Select Game 7` and is cleared, because a named side
    // carries an identity rather than display text; the published name of the
    // slot lives on `label`, which this assertion shows did not change either.
    expect([...changed].sort()).toEqual([
      'awaySide',
      'awayTeamId',
      'homeLabel',
      'homeSide',
      'homeTeamId',
    ]);
    // None of the footprint fields is in that list, which is the same claim
    // stated against the exported contract rather than against a literal.
    for (const field of SLOT_FOOTPRINT_FIELDS) expect(changed.has(field)).toBe(false);
  });

  it('detects a slot that DID move — the positive control', () => {
    // The check above is only worth reading if it can fail. Construct the
    // failure: one slot nudged 30 minutes later, one moved to another field, one
    // dropped outright.
    const nudged = result.slots.map((slot, index) => {
      if (index === 0) return makeReservedSlot({ ...slot, startMinutes: slot.startMinutes + 30 });
      if (index === 1) {
        return makeReservedSlot({ ...slot, surfaceId: season2026SurfaceId('Riverbend', 'Turf') });
      }
      return slot;
    });
    const control = checkSlotsUnmoved(unnamed, nudged.slice(2));

    const moved = observe(control.findings).filter(
      (finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_MOVED
    );
    const dropped = control.findings.filter(
      (finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_DROPPED
    );
    expect(moved).toHaveLength(0); // the two moved slots were the two removed
    expect(dropped).toHaveLength(2);
    expect(control.status).toBe(RESERVE_STATUS.REJECTED);

    // …and again with the moved slots left in place, so the movement itself is
    // what fires rather than their absence.
    const inPlace = checkSlotsUnmoved(unnamed, nudged);
    const movedInPlace = observe(inPlace.findings).filter(
      (finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_MOVED
    );
    expect(movedInPlace).toHaveLength(2);
    expect(movedInPlace[0].details.changedFields).toContain('startMinutes');
    expect(movedInPlace[1].details.changedFields).toContain('surfaceId');
    expect(inPlace.meta.slotsMoved).toBe(2);
    expect(inPlace.status).toBe(RESERVE_STATUS.REJECTED);
  });

  it('refuses a comparison that examined nothing', () => {
    const vacuous = checkSlotsUnmoved([], []);
    expect(vacuous.meta.slotPairsCompared).toBe(0);
    expect(observe(vacuous.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVED_SLOT_COMPARISON_VACUOUS
    );
    expect(vacuous.status).toBe(RESERVE_STATUS.REJECTED);
  });

  it('refuses a team that is not on the roster, a side that cannot be filled, and a double booking', () => {
    const slot = unnamed[0];
    const sameDate = unnamed.filter((entry) => entry.date === slot.date);
    const phantom = applySlotBindings(unnamed, [{ slotId: slot.id, homeTeamId: slot.label }], {
      teamUniverse,
    });
    // Incident 4's second half: `Select Game 7` is a placeholder label, never a
    // team code, and the label is the slot's own.
    expect(observe(phantom.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVED_SLOT_TEAM_UNKNOWN
    );
    expect(phantom.meta.bindingsApplied).toBe(0);

    // A Minis session's absent opponent is not a side that is waiting to be
    // filled — GAP-15's distinction, enforced.
    const minisRow = /** @type {Object} */ (
      season.combinedGames.find((row) => row.kind === 'minis_session')
    );
    const minisSides = season2026FixtureSides(minisRow, { teamUniverse });
    const minisSlot = makeReservedSlot({
      id: String(minisRow.id),
      kind: RESERVE_KIND.UNNAMED_FIXTURE,
      label: String(minisRow.homeLabel),
      date: String(minisRow.date),
      venueId: 'orchard-park',
      surfaceId: season2026SurfaceId(minisRow.venue, minisRow.field),
      startMinutes: Number(minisRow.kickoffMinutes),
      endMinutes: Number(minisRow.endMinutes),
      format: String(minisRow.format),
      homeSide: minisSides.homeSide,
      awaySide: minisSides.awaySide,
      homeLabel: String(minisRow.homeLabel),
    });
    const notBindable = applySlotBindings(
      [minisSlot],
      [{ slotId: minisSlot.id, awayTeamId: selectTeamIds[0] }],
      { teamUniverse }
    );
    expect(observe(notBindable.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVED_SLOT_SIDE_NOT_BINDABLE
    );

    // One team in two overlapping slots on the same date.
    const overlapping = sameDate
      .filter((entry) => entry.startMinutes === sameDate[0].startMinutes)
      .slice(0, 2);
    expect(overlapping.length).toBe(2);
    const clash = applySlotBindings(
      unnamed,
      overlapping.map((entry) => ({ slotId: entry.id, homeTeamId: selectTeamIds[0] })),
      { teamUniverse }
    );
    expect(observe(clash.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVED_SLOT_TEAM_DOUBLE_BOOKED
    );
    // …and even the refusing run left every footprint where it was.
    expect(clash.meta.slotsMoved).toBe(0);
  });

  it('reports a team whose two sources disagree about its coaches, in this vocabulary', () => {
    // 8.2. The publication projection reconciles each team's coaches through
    // `people/coachList.js`, and a disagreement between two sources used to
    // leave on a separate `coachFindings` key that nothing read — produced
    // here and silently dropped, in the artifact path that task exists to fix.
    // It is re-expressed as a reserve code so `deriveReserveStatus()` and every
    // existing consumer of this projection see it.
    //
    // The subject set is the exported rows: the team is put **on a row**, as a
    // TIME TBD fixture naming it. The first draft emitted for every team in the
    // directory, so this test passed against an unnamed slot that named nobody
    // — a finding about a team no reader of the publication could find.
    const one = unnamed[0];
    const contested = {
      id: 'contested-team',
      name: 'a team this test constructed',
      coachId: 'from-the-legacy-columns',
      coachName: 'From The Legacy Columns',
      coaches: [{ personId: 'from-the-reconciled-list', displayName: 'Reconciled', slot: 1 }],
    };
    const naming = (teamId) =>
      makeUnplacedFixture({
        fixtureId: `tbd-${teamId}`,
        label: teamId,
        homeTeamId: teamId,
        reason: 'a fixture constructed by this test',
      });
    const projection = publicationRowsFor({
      slots: [one],
      unplaced: [naming('contested-team')],
      teams: [contested],
    });
    const reported = observe(projection.findings).filter(
      (finding) => finding.code === RESERVE_REASON.TEAM_COACH_SOURCES_DISAGREE
    );
    expect(reported).toHaveLength(1);
    expect(reported[0].details.teamId).toBe('contested-team');
    expect(reported[0].severity).toBe(RESERVE_SEVERITY.COMPROMISE);

    // POSITIVE CONTROL: the same team in the directory and on no row raises
    // nothing, and the projection still produced rows.
    const offTheRows = publicationRowsFor({ slots: [one], teams: [contested] });
    expect(offTheRows.rows.length).toBeGreaterThan(0);
    expect(
      observe(offTheRows.findings).filter(
        (finding) => finding.code === RESERVE_REASON.TEAM_COACH_SOURCES_DISAGREE
      )
    ).toEqual([]);

    // POSITIVE CONTROL: one source, no disagreement — so the code is about the
    // data and not about every team that reaches this projection.
    const settled = publicationRowsFor({
      slots: [one],
      unplaced: [naming('settled-team')],
      teams: [{ id: 'settled-team', name: 'settled', coachId: 'c1', coachName: 'One' }],
    });
    expect(
      settled.findings.filter(
        (finding) => finding.code === RESERVE_REASON.TEAM_COACH_SOURCES_DISAGREE
      )
    ).toEqual([]);
    expect(settled.rows.length).toBeGreaterThan(0);
  });

  it('publishes a bound slot and an unbound one, and both keep their field and time', () => {
    const one = unnamed[0];
    const bound = /** @type {Object} */ (result.slots.find((entry) => entry.id === one.id));
    const projection = publicationRowsFor({ slots: [one, bound] });
    expect(projection.rows).toHaveLength(3); // unbound: 1 row; bound: home + away
    const unboundRow = projection.rows[0].row;
    expect(unboundRow[SCHEDULE_EXPORT_HEADERS.OPPONENT]).toBe(PUBLICATION_TBD.OPPONENT);
    expect(unboundRow[SCHEDULE_EXPORT_HEADERS.TEAM_NAME]).toBe(one.label);
    for (const entry of projection.rows) {
      expect(entry.row[SCHEDULE_EXPORT_HEADERS.FIELD]).toBe(one.surfaceId);
      expect(entry.row[SCHEDULE_EXPORT_HEADERS.START]).toBe(
        unboundRow[SCHEDULE_EXPORT_HEADERS.START]
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance 2 — an unplaced fixture is visible, counted and exported         */
/* -------------------------------------------------------------------------- */

describe('acceptance 2 :: an unplaced fixture appears in totals and exports with its reason', () => {
  /**
   * Incident 10's scenario, through the Prompt 2.1 harness: offer the 9v9 games
   * of 08/22 only the one kickoff the Select layer already occupies. Constructed
   * — the corpus is a season in which everything *was* placed — from the
   * corpus's own date, games, surfaces and bookings.
   */
  const input = toSeason2026PlacementInput(graph, season.combinedGames, { date: '2026-08-22' });
  const run = replaceGamesUnderRegistry(engines, {
    ...input,
    candidateKickoffMinutes: [input.fixedBookings[0].startMinutes],
  });
  const unplaced = unplacedFromPlacementRun(run, { source: 'placement harness' });

  /**
   * The fixtures that must exist, enumerated from `combined_schedule.csv` rather
   * than from the run. A fixture the run dropped is precisely what is missing
   * from the run's own output, so a check that took its subjects from there
   * would report a clean season.
   */
  const expectedFixtureIds = season.combinedGames
    .filter((row) => row.date === '2026-08-22' && row.format === '9v9')
    .map((row) => String(row.id))
    .sort();

  it('keeps every fixture visible: none is placed, all are reported', () => {
    expect(expectedFixtureIds.length).toBeGreaterThan(0);
    expect(run.placements).toHaveLength(0);
    expect(unplaced).toHaveLength(expectedFixtureIds.length);
    for (const fixture of unplaced) {
      expect(fixture.timeStatus).toBe(PUBLICATION_TBD.TIME);
      expect(fixture.locationStatus).toBe(PUBLICATION_TBD.LOCATION);
      expect(fixture.reason).toMatch(/no candidate slot/);
      expect(fixture.publishedKickoffMinutes).toBeGreaterThan(0);
    }
  });

  it('counts them in the totals', () => {
    const accounting = accountForFixtures({
      expectedFixtureIds,
      placedFixtureIds: run.placements.map((placement) => placement.gameId),
      unplaced,
      expectedSource: 'combined_schedule.csv 9v9 rows on 2026-08-22',
    });
    expect(accounting.totals.expected).toBe(expectedFixtureIds.length);
    expect(accounting.totals.placed).toBe(0);
    expect(accounting.totals.unplaced).toBe(expectedFixtureIds.length);
    expect(accounting.totals.accounted).toBe(accounting.totals.expected);
    expect(accounting.totals.missing).toBe(0);
    expect(accounting.missingFixtureIds).toEqual([]);
    expect(accounting.meta.fixturesAccountedFor).toBe(expectedFixtureIds.length);
    // Visible, and visibly compromised: a season carrying TIME TBD rows is not
    // an `allowed` season.
    observe(accounting.findings);
    expect(accounting.status).toBe(RESERVE_STATUS.COMPROMISED);
  });

  it('catches a fixture that was silently dropped — the positive control', () => {
    const [victim, ...survivors] = unplaced;
    const dropped = accountForFixtures({
      expectedFixtureIds,
      placedFixtureIds: [],
      unplaced: survivors,
      expectedSource: 'combined_schedule.csv 9v9 rows on 2026-08-22',
    });
    expect(dropped.totals.missing).toBe(1);
    expect(dropped.missingFixtureIds).toEqual([victim.fixtureId]);
    expect(dropped.status).toBe(RESERVE_STATUS.REJECTED);
    expect(observe(dropped.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.FIXTURE_DROPPED
    );
  });

  it('refuses an accounting that reconciled nothing', () => {
    const vacuous = accountForFixtures({
      expectedFixtureIds: [],
      placedFixtureIds: [],
      unplaced: [],
    });
    expect(vacuous.meta.fixturesAccountedFor).toBe(0);
    expect(observe(vacuous.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.FIXTURE_ACCOUNTING_VACUOUS
    );
    expect(vacuous.status).toBe(RESERVE_STATUS.REJECTED);
  });

  it('exports every one of them with TIME TBD, LOCATION TBD and the reason', () => {
    const projection = publicationRowsFor({ slots: [], unplaced });
    expect(projection.rows).toHaveLength(unplaced.length);
    expect(projection.meta.rowsEmitted).toBe(unplaced.length);
    for (const entry of projection.rows) {
      expect(entry.row[SCHEDULE_EXPORT_HEADERS.START]).toBe(PUBLICATION_TBD.TIME);
      expect(entry.row[SCHEDULE_EXPORT_HEADERS.END]).toBe(PUBLICATION_TBD.TIME);
      expect(entry.row[SCHEDULE_EXPORT_HEADERS.FIELD]).toBe(PUBLICATION_TBD.LOCATION);
      expect(entry.row[SCHEDULE_EXPORT_HEADERS.NOTES]).toMatch(/no candidate slot/);
    }
    // Every column the master export declares is present, so these rows drop
    // into that vocabulary without a translation step.
    for (const column of projection.columns) {
      expect(Object.hasOwn(projection.rows[0].row, column)).toBe(true);
    }
    expect(projection.status).toBe(RESERVE_STATUS.ALLOWED);
  });

  it('reads the same state back from a real re-solve, not only from the harness', () => {
    // The corpus supplies the scenario here: Summit HS has **no permit at all**
    // on 09/19, and `resolve/` already carries a thawed game with nowhere to go
    // as TIME TBD with a reason. This module reads that; it does not re-derive
    // it.
    const blackoutDate = /** @type {string} */ (
      [...new Set(schedule.games.map((game) => game.date))]
        .sort()
        .find((date) =>
          calendar.permitsByVenue['summit-hs']?.some(
            (permit) => permit.date === date && permit.hasPermit === false
          )
        )
    );
    expect(blackoutDate).toBeTruthy();
    const stranded = /** @type {Object} */ (
      schedule.games.find((game) => game.format === '9v9' && game.date !== blackoutDate)
    );
    const resolveRun = applyChangeRequest({
      schedule,
      changes: [
        {
          gameId: stranded.id,
          date: blackoutDate,
          surfaceId: season2026SurfaceId('Summit HS', 'Stadium'),
          startMinutes: stranded.startMinutes,
        },
      ],
      engines,
      verify: false,
      onUnsatisfiable: 'report',
    });
    expect(resolveRun.unplaced.length).toBeGreaterThan(0);

    const fromResolve = unplacedFromResolveRun(resolveRun);
    expect(fromResolve).toHaveLength(resolveRun.unplaced.length);
    for (const fixture of fromResolve) {
      expect(fixture.reason).toMatch(/TIME TBD/);
      expect(fixture.timeStatus).toBe(PUBLICATION_TBD.TIME);
      // Kept with its identity, not just its id: the label and the published
      // position come from the baseline the run still holds.
      expect(fixture.label).not.toBe(fixture.fixtureId);
      expect(fixture.publishedSurfaceId).toBeTruthy();
      expect(fixture.publishedKickoffMinutes).not.toBeNull();
    }

    // The whole season's fixtures, reconciled: nothing left the schedule.
    const accounting = accountForFixtures({
      expectedFixtureIds: schedule.games.map((game) => game.id),
      placedFixtureIds: resolveRun.schedule.games.map((game) => game.id),
      unplaced: fromResolve,
      expectedSource: 'the baseline schedule',
    });
    expect(accounting.totals.expected).toBe(schedule.games.length);
    expect(accounting.totals.missing).toBe(0);
    expect(accounting.totals.accounted).toBe(schedule.games.length);
  });

  it('names which machinery decided, and does not invent a constraint that decided nothing', () => {
    // The corpus supplies this one too. A global re-optimisation of the season
    // around the eight externally-published fixtures places in one pass with no
    // backtracking, and four 9v9 games find no slot left on 08/22 — kept as
    // TIME TBD rather than dropped (incident 10).
    //
    // What they are *not* is constraint-caused. `resolve/stages.js` gives the
    // TIME TBD move no cause on purpose, and the dislodge that preceded it was
    // the global re-optimisation itself, so the honest answer to "what forced
    // this?" is `global-reoptimisation` and no reason code at all. That answer
    // is a **field** here rather than an empty list a reader has to interpret:
    // "no constraint forced this" and "nobody recorded what forced this" must
    // not look the same.
    const reoptimised = reoptimiseWholeSeason({
      schedule,
      changes: season2026ExternalFixtureChanges(loadExternalFixtures(), schedule),
      engines,
      reason: 'exercising the consequential TIME TBD path against the corpus',
      acknowledged: true,
      verify: false,
    });
    expect(reoptimised.unplaced.length).toBeGreaterThan(0);

    const fixtures = unplacedFromResolveRun(reoptimised);
    expect(fixtures).toHaveLength(reoptimised.unplaced.length);
    for (const fixture of fixtures) {
      expect(fixture.causeKind).toBe('global-reoptimisation');
      expect(fixture.reasonCodes).toEqual([]);
      expect(fixture.constraintIds).toEqual([]);
      expect(fixture.reason).toMatch(/incident 10/);
      // The identity survives: these came out of the baseline the run holds.
      expect(fixture.date).toBeTruthy();
      expect(fixture.label).not.toBe(fixture.fixtureId);
      expect(fixture.publishedSurfaceId).toBeTruthy();
    }

    // Nothing left the season: every baseline game is either placed or carried.
    const accounting = accountForFixtures({
      expectedFixtureIds: schedule.games.map((game) => game.id),
      placedFixtureIds: reoptimised.schedule.games.map((game) => game.id),
      unplaced: fixtures,
      expectedSource: 'the baseline schedule',
    });
    expect(accounting.totals.missing).toBe(0);
    expect(accounting.totals.unplaced).toBe(fixtures.length);
    observe(accounting.findings);
    // …and the cause travels into the finding an operator reads, rather than
    // stopping at the record.
    const tbd = accounting.findings.find(
      (finding) => finding.code === RESERVE_REASON.FIXTURE_TIME_TBD
    );
    expect(/** @type {Object} */ (tbd).details.causeKind).toBe('global-reoptimisation');
  }, 20_000); // one whole-season re-optimisation: 3.1 s alone, 3.7 / 3.7 / 4.3 / 4.3 s in four local full runs; ~4x the worst, see docs/testing/test-timeouts.md.
});

/* -------------------------------------------------------------------------- */
/* Conditional slots are evaluated, not annotated                              */
/* -------------------------------------------------------------------------- */

describe('conditional slots are evaluated against the facility graph, not annotated', () => {
  const pitch2 = season2026SurfaceId('Alder Park', 'Pitch 2');
  const pitch3 = season2026SurfaceId('Alder Park', 'Pitch 3');
  const turf = season2026SurfaceId('Riverbend', 'Turf');
  const stadium = season2026SurfaceId('Summit HS', 'Stadium');

  it('derives the condition from the overlap relation, and only for ground that has one', () => {
    const two = conditionForSurface(graph, pitch2);
    const three = conditionForSurface(graph, pitch3);
    expect(two).not.toBeNull();
    expect(three).not.toBeNull();
    // Pitch 2 depends on Pitch 1 *and its halves*: the lineage clause of the
    // overlap relation, consumed rather than re-derived.
    expect(/** @type {Object} */ (two).surfaceIds.sort()).toEqual(
      [
        season2026SurfaceId('Alder Park', 'Pitch 1'),
        season2026SurfaceId('Alder Park', 'Pitch 1A'),
        season2026SurfaceId('Alder Park', 'Pitch 1B'),
      ].sort()
    );
    expect(/** @type {Object} */ (three).surfaceIds.sort()).toEqual(
      [
        season2026SurfaceId('Alder Park', 'Pitch 4'),
        season2026SurfaceId('Alder Park', 'Pitch 4A'),
        season2026SurfaceId('Alder Park', 'Pitch 4B'),
      ].sort()
    );
    // The only 11v11 ground at its venue carries no condition at all.
    expect(conditionForSurface(graph, turf)).toBeNull();
    expect(conditionForSurface(graph, stadium)).toBeNull();
  });

  it('reports a stored-but-unchecked condition as unenforced', () => {
    const slot = /** @type {Object} */ (unnamed.find((entry) => entry.surfaceId === pitch3));
    const declared = describeSlotCondition(slot);
    expect(declared.verdict).toBe(CONDITION_VERDICT.UNEVALUATED);
    expect(observe(declared.findings).map((finding) => finding.code)).toEqual([
      RESERVE_REASON.SLOT_CONDITION_UNENFORCED,
    ]);
    expect(deriveReserveStatus(declared.findings)).toBe(RESERVE_STATUS.COMPROMISED);
  });

  it('finds the condition satisfied where the corpus leaves the neighbour idle, and blocked where it does not', () => {
    const bookings = season2026ReserveBookings(season.combinedGames, {
      excludeIds: slots.map((slot) => slot.id),
    });

    // Pitch 3's reserved slots are satisfied on every reserved date: the corpus
    // never books Pitch 4 on a Select Saturday.
    const onPitch3 = unnamed.filter((slot) => slot.surfaceId === pitch3);
    expect(onPitch3.length).toBeGreaterThan(0);
    let satisfied = 0;
    for (const slot of onPitch3) {
      const verdict = evaluateSlotCondition(graph, slot, bookings, { reserved: true });
      observe(verdict.findings);
      if (verdict.verdict === CONDITION_VERDICT.SATISFIED) satisfied += 1;
    }
    expect(satisfied).toBe(onPitch3.length);

    // The same condition on Pitch 2 at the same times is a different answer,
    // because the rec layer stands on Pitch 1A/1B — the positive control, and
    // it comes from the corpus rather than from a construction.
    const recDate = '2026-10-17';
    const blocked = onPitch3
      .filter((slot) => slot.date === recDate)
      .map((slot) =>
        evaluateSlotCondition(
          graph,
          makeReservedSlot({
            ...slot,
            id: `${slot.id}#control`,
            surfaceId: pitch2,
            condition: conditionForSurface(graph, pitch2),
          }),
          bookings,
          { reserved: false }
        )
      );
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.some((verdict) => verdict.verdict === CONDITION_VERDICT.BLOCKED)).toBe(true);
    const blocking = blocked.find((verdict) => verdict.verdict === CONDITION_VERDICT.BLOCKED);
    observe(/** @type {Object} */ (blocking).findings);
    expect(/** @type {Object} */ (blocking).blockingBookingIds.length).toBeGreaterThan(0);
    expect(/** @type {Object} */ (blocking).meta.conditionBookingsCompared).toBeGreaterThan(0);
  });

  it('refuses to decide a condition against a booking of unknown footprint (GAP-14)', () => {
    // The corpus's own reservation has no `game_formats.csv` row, so its own
    // footprint is unknown. Judged against the ground it depends on, the honest
    // answer is "cannot be decided", not "clear".
    const bookings = season2026ReserveBookings(season.combinedGames, {
      excludeIds: [reservations[0].id],
    });
    const verdict = evaluateSlotCondition(graph, reservations[0], bookings, { reserved: true });
    expect(reservations[0].endMinutes).toBeNull();
    expect(verdict.verdict).toBe(CONDITION_VERDICT.UNDECIDABLE);
    expect(observe(verdict.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.SLOT_CONDITION_UNDECIDABLE
    );
    expect(verdict.undecidableBookingIds.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance 3 — the capacity report                                          */
/* -------------------------------------------------------------------------- */

describe('acceptance 3 :: the reserve capacity report', () => {
  it('is not vacuous, and accounts for every published reservation', () => {
    observe(report.findings);
    expect(report.status).toBe(RESERVE_STATUS.COMPROMISED);
    expect(report.meta.datesExamined).toBe(10);
    expect(report.meta.surfaceDatesExamined).toBe(40);
    expect(report.meta.candidatesTested).toBeGreaterThan(report.meta.slotsGenerated);
    expect(report.meta.slotsGenerated).toBeGreaterThan(0);

    // The model's anchor is proved rather than assumed: all 100 published
    // reservations land on a slot it generates.
    expect(report.meta.reservedSlotsMatched).toBe(100);
    expect(report.meta.reservedSlotsOffGrid).toBe(0);
    expect(
      report.findings.some((finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_OFF_GRID)
    ).toBe(false);
    expect(SEASON_2026_EARLIEST_KICKOFF_MINUTES).toBe(8 * 60);
    // The cadence is the format's block length from `game_formats.csv`, not a
    // number typed into this module.
    expect(report.cadenceMinutes).toBe(table.formats[SEASON_2026_RESERVE_FORMAT].blockMinutes);
    expect(report.cadenceMinutes).toBe(120);
  });

  it('catches a wrong anchor — the positive control for the off-grid check', () => {
    const wrong = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      { ...capacityInput, earliestKickoffMinutes: 9 * 60 }
    );
    observe(wrong.findings);
    expect(wrong.meta.reservedSlotsOffGrid).toBeGreaterThan(0);
    expect(wrong.status).toBe(RESERVE_STATUS.REJECTED);
    expect(
      wrong.findings.some((finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_OFF_GRID)
    ).toBe(true);
  });

  it('reproduces 14-18 slots per week against a 10-game cap', () => {
    expect(report.minSlots).toBe(14);
    expect(report.maxSlots).toBe(18);
    expect(report.dates).toHaveLength(10);

    for (const dateRow of report.dates) {
      // The cap is what limits the *reserved* number, not the facility.
      expect(dateRow.reserved).toBe(SEASON_2026_LEAGUE_CAP_PER_DATE);
      expect(dateRow.atCap).toBe(true);
      expect(dateRow.overCap).toBe(false);
      expect(dateRow.spare).toBe(dateRow.slots - dateRow.reserved);
      expect(dateRow.spare).toBeGreaterThanOrEqual(0);
      // Nothing is assigned: the league had not published its picks.
      expect(dateRow.assigned).toBe(0);
      expect(dateRow.unassigned).toBe(SEASON_2026_LEAGUE_CAP_PER_DATE);
      // The requirement is met on every date, on the slot count.
      expect(dateRow.meetsRequirement).toBe(true);
      expect(dateRow.slots).toBe(dateRow.unconditionalSlots + dateRow.conditionalSlots);
    }

    // The requirement is derived from the roster, not typed in.
    expect(report.requirement.slots).toBe(selectTeamIds.length);
    expect(report.requirement.slots).toBe(14);
    expect(season2026CapacityRequirement(season.teams).slots).toBe(14);
    expect(/** @type {Object} */ (report.cap).limit).toBe(SEASON_2026_LEAGUE_CAP_PER_DATE);
  });

  it('counts conditional slots separately from unconditional ones', () => {
    const pitch2 = season2026SurfaceId('Alder Park', 'Pitch 2');
    const pitch3 = season2026SurfaceId('Alder Park', 'Pitch 3');

    for (const dateRow of report.dates) {
      const conditional = dateRow.bySurface.filter((row) => row.conditional);
      const unconditional = dateRow.bySurface.filter((row) => !row.conditional);
      // Exactly the two Alder pitches are conditional, on every date.
      expect(conditional.map((row) => row.surfaceId).sort()).toEqual([pitch2, pitch3].sort());
      expect(unconditional).toHaveLength(2);
      expect(dateRow.conditionalSlots).toBe(conditional.reduce((sum, row) => sum + row.slots, 0));
      expect(dateRow.unconditionalSlots).toBe(
        unconditional.reduce((sum, row) => sum + row.slots, 0)
      );
      // Every conditional slot got a verdict; none was left unjudged.
      expect(
        dateRow.conditionSatisfied + dateRow.conditionBlocked + dateRow.conditionUndecidable
      ).toBe(dateRow.conditionalSlots);
      expect(dateRow.available).toBe(dateRow.unconditionalSlots + dateRow.conditionSatisfied);
    }

    // The two columns really do differ: on the dates the rec layer occupies
    // Alder Pitch 1, conditional ground is worth less than it looks, and the
    // report says so rather than counting it as free.
    const shortfalls = report.dates.filter((dateRow) => dateRow.available < dateRow.slots);
    expect(shortfalls.length).toBeGreaterThan(0);
    for (const dateRow of shortfalls) {
      expect(dateRow.conditionBlocked).toBeGreaterThan(0);
    }
    // Five dates clear the requirement on the slot count and fail it once the
    // conditions are evaluated. They are exactly the rec Saturdays on which the
    // 9v9 layer stands on Alder Pitch 1 — 10/10 has no rec games at all and is
    // the control that shows the shortfall is caused by the rec layer rather
    // than by the model.
    const failing = report.dates
      .filter((dateRow) => !dateRow.availableMeetsRequirement)
      .map((dateRow) => dateRow.date);
    expect(failing).toEqual(['2026-09-19', '2026-09-26', '2026-10-03', '2026-10-17', '2026-10-31']);
    const noRecGames = /** @type {Object} */ (
      report.dates.find((dateRow) => dateRow.date === '2026-10-10')
    );
    expect(
      season.combinedGames.filter(
        (row) =>
          row.date === '2026-10-10' && row.venue === 'Alder Park' && row.field.startsWith('Pitch 1')
      )
    ).toHaveLength(0);
    expect(noRecGames.conditionBlocked).toBe(0);
    expect(noRecGames.available).toBe(noRecGames.slots);
    expect(
      report.findings.filter(
        (finding) => finding.code === RESERVE_REASON.RESERVE_CAPACITY_CONDITIONAL_SHORTFALL
      )
    ).toHaveLength(failing.length);
  });

  it('identifies sunset as what trims the two November dates to the bare minimum', () => {
    // The bare-minimum dates are found, not named: they are the dates whose slot
    // count equals the requirement exactly.
    expect(report.bareMinimumDates).toEqual(['2026-11-07', '2026-11-14']);
    for (const date of report.bareMinimumDates) {
      const dateRow = /** @type {Object} */ (report.dates.find((row) => row.date === date));
      expect(dateRow.slots).toBe(report.requirement.slots);
      expect(dateRow.spare).toBe(report.requirement.slots - SEASON_2026_LEAGUE_CAP_PER_DATE);

      const sunset = dateRow.cappedBy.find((entry) => entry.kind === 'sunset');
      expect(sunset).toBeTruthy();
      // Three surfaces lost one slot each to daylight; adding them back would
      // put the date at 17 and clear of the requirement, which is precisely
      // what "trims it to the bare minimum" means.
      expect(/** @type {Object} */ (sunset).slotsLostVsBest).toBe(3);
      expect(dateRow.slots + /** @type {Object} */ (sunset).slotsLostVsBest).toBeGreaterThan(
        report.requirement.slots
      );
      // Every surface sunset capped is unlit ground, and each really did offer
      // fewer slots here than on any other date in the report.
      for (const surfaceId of /** @type {Object} */ (sunset).surfaceIds) {
        const surfaceRow = dateRow.bySurface.find((row) => row.surfaceId === surfaceId);
        expect(surfaceRow.slots).toBeLessThan(report.bestSlotsBySurface[surfaceId]);
        // Strictly fewer than on every date that is *not* at the bare minimum.
        // The two November dates are equal to each other, which is the point:
        // they are the pair sunset trims, and nothing else.
        for (const other of report.dates) {
          if (report.bareMinimumDates.includes(other.date)) continue;
          const otherRow = other.bySurface.find((row) => row.surfaceId === surfaceId);
          expect(surfaceRow.slots).toBeLessThan(otherRow.slots);
        }
      }
      // The lit stadium is capped by its permit, not by daylight, and holds the
      // same count it holds on eight other dates.
      const stadium = dateRow.bySurface.find(
        (row) => row.surfaceId === season2026SurfaceId('Summit HS', 'Stadium')
      );
      expect(stadium.cappedByKinds).toEqual(['permit']);
    }

    // The claim is checkable against `sunsets.csv`: these two dates carry the
    // earliest sunsets of the season.
    const bySunset = [...sunsets].sort((a, b) => a.sunsetMinutes - b.sunsetMinutes);
    expect(
      bySunset
        .slice(0, 2)
        .map((entry) => entry.date)
        .sort()
    ).toEqual(report.bareMinimumDates);
    // …and the report says the bare minimum out loud.
    const atRequirement = report.findings.filter(
      (finding) => finding.code === RESERVE_REASON.RESERVE_CAPACITY_AT_REQUIREMENT
    );
    expect(atRequirement).toHaveLength(2);
  });

  it('names the constraint that caps every date, and no date is left unattributed', () => {
    for (const dateRow of report.dates) {
      expect(dateRow.cappedBy.length).toBeGreaterThan(0);
      for (const row of dateRow.bySurface) {
        // Every surface either ran out of legal kickoffs or ran off the end of
        // the searched day; the first is what we assert, because the second
        // would mean nothing bounded it.
        expect(row.firstRejectedKickoffMinutes).not.toBeNull();
        expect(row.cappedByKinds.length).toBeGreaterThan(0);
        expect(row.blockingCodes.length).toBeGreaterThan(0);
        // The slack is Phase 1.3's number, read back rather than recomputed:
        // negative, because the candidate that ended the run broke its bound.
        if (row.slots > 0) expect(row.slackMinutes).toBeLessThan(0);
      }
    }

    // The registry is consulted for the codes, not second-guessed: the sunset
    // margin constraint is the one that claims `SUNSET_MARGIN_VIOLATED`.
    const november = /** @type {Object} */ (report.dates.find((row) => row.date === '2026-11-07'));
    const unlit = november.bySurface.filter((row) => row.cappedByKinds.includes('sunset'));
    expect(unlit.length).toBe(3);
    for (const row of unlit) {
      expect(row.constraintIds).toContain(SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN);
    }
    const stadium = november.bySurface.find(
      (row) => row.surfaceId === season2026SurfaceId('Summit HS', 'Stadium')
    );
    expect(stadium.constraintIds).toContain(SEASON_2026_CONSTRAINT_ID.PERMIT_WINDOW);
  });

  it('reports the permit blackout as what caps 09/19, and the early open as what lifts 09/12', () => {
    const stadiumId = season2026SurfaceId('Summit HS', 'Stadium');
    const blackout = /** @type {Object} */ (report.dates.find((row) => row.date === '2026-09-19'));
    const stadiumOnBlackout = blackout.bySurface.find((row) => row.surfaceId === stadiumId);
    expect(stadiumOnBlackout.slots).toBe(0);
    expect(stadiumOnBlackout.cappedByKinds).toEqual(['permit']);
    expect(blackout.slots).toBe(15);

    const early = /** @type {Object} */ (report.dates.find((row) => row.date === '2026-09-12'));
    const stadiumOnEarly = early.bySurface.find((row) => row.surfaceId === stadiumId);
    expect(stadiumOnEarly.slots).toBe(3);
    expect(early.slots).toBe(report.maxSlots);
    // The extra slot exists because that one date's permit opens at 14:00
    // instead of 17:00 — a date-scoped exception, read by the availability
    // calendar rather than by this module.
    expect(stadiumOnEarly.kickoffMinutes[0]).toBe(14 * 60);
    expect(stadiumOnBlackout.kickoffMinutes).toEqual([]);
  });

  it('refuses a report that examined nothing', () => {
    expect(() =>
      buildReserveCapacityReport(
        { graph, table, calendar, registry },
        { ...capacityInput, dates: [] }
      )
    ).toThrow();
    // A report over a surface no format fits generates zero slots and says so
    // rather than clearing the requirement on an empty count.
    const empty = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      {
        ...capacityInput,
        surfaceIds: [season2026SurfaceId('Orchard Park', 'Field 1')],
        reservedSlots: [],
      }
    );
    expect(empty.meta.slotsGenerated).toBe(0);
    expect(observe(empty.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVE_CAPACITY_VACUOUS
    );
    expect(empty.status).toBe(RESERVE_STATUS.REJECTED);

    // …and a run that was given nothing to evaluate the conditions against is
    // refused at the door rather than reporting every conditional slot free.
    const { bookings: _bookings, ...withoutBookings } = capacityInput;
    expect(() =>
      buildReserveCapacityReport({ graph, table, calendar, registry }, withoutBookings)
    ).toThrow();
    // An explicit empty list is a different statement and is accepted, with
    // every condition then genuinely satisfied because nothing stands anywhere.
    const nothingBooked = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      { ...capacityInput, bookings: [] }
    );
    expect(nothingBooked.meta.conditionsEvaluated).toBeGreaterThan(0);
    expect(nothingBooked.dates.every((dateRow) => dateRow.available === dateRow.slots)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The refusals the corpus never triggers, each shown firing                   */
/* -------------------------------------------------------------------------- */

describe('reserve :: the refusals a clean season never triggers', () => {
  // Every code below is one the published corpus does not produce, which is why
  // each gets a constructed case. A refusal nothing ever exercises is a refusal
  // nobody has checked the meaning of.

  it('refuses a binding that names a slot nobody holds, overwrites a named side, or plays a team against itself', () => {
    const slot = unnamed[0];

    const unknown = applySlotBindings(
      unnamed,
      [{ slotId: 'no-such-slot', homeTeamId: selectTeamIds[0] }],
      { teamUniverse }
    );
    expect(observe(unknown.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVED_SLOT_UNKNOWN
    );

    const alreadyNamed = applySlotBindings(
      [
        makeReservedSlot({
          ...slot,
          homeSide: FIXTURE_SIDE.TEAM,
          homeTeamId: selectTeamIds[0],
          homeLabel: null,
        }),
      ],
      [{ slotId: slot.id, homeTeamId: selectTeamIds[1] }],
      { teamUniverse }
    );
    expect(observe(alreadyNamed.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVED_SLOT_SIDE_ALREADY_NAMED
    );

    const selfPlay = applySlotBindings(
      [slot],
      [{ slotId: slot.id, homeTeamId: selectTeamIds[0], awayTeamId: selectTeamIds[0] }],
      { teamUniverse }
    );
    expect(observe(selfPlay.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVED_SLOT_SIDES_IDENTICAL
    );

    // …and a half-filled slot is applied, and says it is half-filled.
    const partial = applySlotBindings([slot], [{ slotId: slot.id, homeTeamId: selectTeamIds[0] }], {
      teamUniverse,
    });
    expect(observe(partial.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVED_SLOT_PARTIALLY_BOUND
    );
    expect(partial.meta.bindingsApplied).toBe(1);
    expect(slotIsSettled(partial.slots[0])).toBe(false);
    // Half-filled or not, it did not move.
    expect(reservedSlotFootprint(partial.slots[0])).toBe(reservedSlotFootprint(slot));

    // A binding must name at least one side; one that names neither would report
    // success having done nothing.
    expect(() => applySlotBindings([slot], [{ slotId: slot.id }], { teamUniverse })).toThrow();
    expect(() => applySlotBindings([slot], [], /** @type {Object} */ ({}))).toThrow(/teamUniverse/);
  });

  it('treats held ground whose condition fails as a blocking problem, not a fact about the day', () => {
    // Constructed: move the corpus's Pitch 3 reservation onto Pitch 2 on a rec
    // Saturday, where the 9v9 layer stands on Pitch 1A/1B. The club would have
    // held ground it cannot use.
    const bookings = season2026ReserveBookings(season.combinedGames, {
      excludeIds: slots.map((entry) => entry.id),
    });
    const pitch2 = season2026SurfaceId('Alder Park', 'Pitch 2');
    const midday = /** @type {Object} */ (
      unnamed.find((entry) => entry.date === '2026-10-17' && entry.startMinutes === 12 * 60)
    );
    const moved = makeReservedSlot({
      ...midday,
      id: `${midday.id}#control`,
      surfaceId: pitch2,
      condition: conditionForSurface(graph, pitch2),
    });
    const verdict = evaluateSlotCondition(graph, moved, bookings, { reserved: true });
    expect(verdict.verdict).toBe(CONDITION_VERDICT.BLOCKED);
    expect(observe(verdict.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVED_SLOT_CONDITION_BLOCKED
    );
    expect(deriveReserveStatus(verdict.findings)).toBe(RESERVE_STATUS.REJECTED);
  });

  it('refuses a reason that is only whitespace, and a fixture counted twice', () => {
    // `UnplacedFixtureSchema` stops the empty string at the constructor; this is
    // the one that gets past it.
    const blank = makeUnplacedFixture({
      fixtureId: 'constructed-1',
      label: 'constructed v control',
      reason: '   ',
    });
    const accounting = accountForFixtures({
      expectedFixtureIds: ['constructed-1'],
      placedFixtureIds: [],
      unplaced: [blank],
    });
    expect(observe(accounting.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.FIXTURE_REASON_MISSING
    );
    expect(accounting.status).toBe(RESERVE_STATUS.REJECTED);
    expect(() => makeUnplacedFixture({ fixtureId: 'x', label: 'y', reason: '' })).toThrow();

    const both = accountForFixtures({
      expectedFixtureIds: ['constructed-2'],
      placedFixtureIds: ['constructed-2'],
      unplaced: [
        makeUnplacedFixture({
          fixtureId: 'constructed-2',
          label: 'a v b',
          reason: 'nowhere to go',
        }),
      ],
    });
    expect(observe(both.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.FIXTURE_DOUBLE_COUNTED
    );
  });

  it('reports a date over the external cap and a date under the requirement', () => {
    const tighter = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      {
        ...capacityInput,
        cap: { ...capacityInput.cap, limit: SEASON_2026_LEAGUE_CAP_PER_DATE - 1 },
      }
    );
    expect(observe(tighter.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVE_CAP_EXCEEDED
    );
    expect(tighter.dates.every((dateRow) => dateRow.overCap)).toBe(true);

    const demanding = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      {
        ...capacityInput,
        requirement: {
          ...capacityInput.requirement,
          slots: /** @type {number} */ (report.maxSlots) + 1,
        },
      }
    );
    expect(observe(demanding.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.RESERVE_CAPACITY_BELOW_REQUIREMENT
    );
    expect(demanding.dates.every((dateRow) => !dateRow.meetsRequirement)).toBe(true);
    expect(demanding.bareMinimumDates).toEqual([]);
  });

  it('hands reserved ground to the facility model as a booking (GAP-17)', () => {
    // A reservation is not a game and it still blocks a field. The proof is that
    // the Phase 1.1 conflict scan — which knows nothing about this module — sees
    // it clash with a concurrent booking on overlapping ground.
    const onPitch3 = /** @type {Object} */ (
      unnamed.find((slot) => slot.surfaceId === season2026SurfaceId('Alder Park', 'Pitch 3'))
    );
    const asBookings = slotsToBookings([onPitch3]);
    expect(asBookings[0].startMinutes).toBe(onPitch3.startMinutes);
    const neighbour = {
      id: 'constructed-neighbour',
      surfaceId: season2026SurfaceId('Alder Park', 'Pitch 4A'),
      date: onPitch3.date,
      startMinutes: onPitch3.startMinutes,
      endMinutes: onPitch3.startMinutes + 65,
      format: '9v9',
      label: 'constructed v control',
    };
    const scan = findFacilityConflicts(graph, [...asBookings, neighbour]);
    expect(scan.conflicts).toHaveLength(1);
    expect(scan.conflicts[0].code).toBe(FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP);
  });
});

/* -------------------------------------------------------------------------- */
/* The eight defects the pre-PR review found                                   */
/* -------------------------------------------------------------------------- */

describe('the pre-PR review :: a reservation must be able to block a conditional slot', () => {
  // GROUP A, proved end to end rather than as three unit tests. Three separate
  // defects combined into one hole — every reserved slot was ignored when a
  // condition was evaluated, the corpus's own reservation was stripped out of
  // the bookings before it could be, and the verdict's findings were dropped on
  // the floor — so held ground could never block a conditional slot, which is
  // most of what the conditional-slot requirement exists for.
  const pitch1 = season2026SurfaceId('Alder Park', 'Pitch 1');
  const pitch2 = season2026SurfaceId('Alder Park', 'Pitch 2');

  /**
   * 10/10 is the corpus's own control date: the rec layer plays nowhere on
   * Alder Park that day, so every conditional slot on it is satisfied and the
   * date's `available` equals its slot count. Anything that moves those numbers
   * moved because of the row added below and nothing else.
   */
  const blockedDate = '2026-10-10';

  /**
   * Constructed, in the corpus's own row shape: ground held on Pitch 1, which
   * physically overlaps Pitch 2, over a kickoff Pitch 2's grid generates.
   *
   * It is a `Scrimmage` like the corpus's own reservation — ground held for a
   * purpose, not a game of the format this report counts — so it is none of the
   * report's reserved slots and can move no count. The only thing it can change
   * is a condition, which is the point. Unlike the corpus's scrimmage it carries
   * an end, so the overlap is measurable and the honest verdict is `blocked`
   * rather than `undecidable`.
   */
  const heldGround = {
    id: 'constructed#alder-pitch-1-reservation',
    kind: 'reservation',
    date: blockedDate,
    venue: 'Alder Park',
    field: 'Pitch 1',
    kickoffMinutes: 600,
    endMinutes: 690,
    format: 'Scrimmage',
    division: 'Select',
    homeLabel: 'Scrimmage - teams TBD',
    awayLabel: '-',
  };

  const withHeldGround = season2026ReserveCapacityInput(
    { ...season, combinedGames: [...season.combinedGames, heldGround] },
    { graph, table }
  );
  const blockedReport = buildReserveCapacityReport(
    { graph, table, calendar, registry },
    withHeldGround
  );

  it('hands every reservation to the capacity report as a booking', () => {
    // The corpus's single field reservation is a booking, not a row the report
    // may quietly delete before asking whether the ground is free.
    expect(reservations).toHaveLength(1);
    expect(capacityInput.bookings.some((booking) => booking.id === reservations[0].id)).toBe(true);
    expect(withHeldGround.bookings.some((booking) => booking.id === heldGround.id)).toBe(true);
    // Every published row reaches the report; none is filtered out on its way.
    expect(capacityInput.bookings).toHaveLength(season.combinedGames.length);
  });

  it('blocks the conditional slot that stands on it, and says which booking did', () => {
    // The control: the same date, without the held ground, has nothing blocked.
    const control = /** @type {Object} */ (
      report.dates.find((dateRow) => dateRow.date === blockedDate)
    );
    expect(control.conditionBlocked).toBe(0);
    expect(control.available).toBe(control.slots);

    const blocked = /** @type {Object} */ (
      blockedReport.dates.find((dateRow) => dateRow.date === blockedDate)
    );
    // Pitch 1 is 9v9 ground, so it is not one of the surfaces this report
    // counts: the reservation changes the *conditions*, never the slot count.
    expect(withHeldGround.surfaceIds).not.toContain(pitch1);
    expect(blocked.slots).toBe(control.slots);
    expect(blocked.reserved).toBe(control.reserved);
    // …and exactly the one Pitch 2 candidate it overlaps is blocked.
    expect(blocked.conditionBlocked).toBe(1);
    expect(blocked.available).toBe(control.available - 1);
    const pitch2Row = blocked.bySurface.find((row) => row.surfaceId === pitch2);
    expect(pitch2Row.conditionBlocked).toBe(1);
    expect(pitch2Row.conditionSatisfied).toBe(pitch2Row.slots - 1);
  });

  it('reports the block rather than only counting it', () => {
    // A number that moves with no finding to explain it is the hollow-guarantee
    // shape this repository keeps finding: the verdict's findings must reach the
    // report an operator reads.
    observe(blockedReport.findings);
    const allBlocked = blockedReport.findings.filter(
      (finding) => finding.code === RESERVE_REASON.SLOT_CONDITION_BLOCKED
    );
    // One finding per blocked verdict, across the whole report: the count and
    // the findings are two views of one evaluation.
    expect(allBlocked).toHaveLength(
      blockedReport.dates.reduce((total, dateRow) => total + dateRow.conditionBlocked, 0)
    );
    // On the control date, the reservation is the only thing that blocks anything.
    const blocking = allBlocked.filter((finding) => finding.details.date === blockedDate);
    expect(blocking).toHaveLength(1);
    expect(/** @type {Object} */ (blocking[0]).details.blockingBookingIds).toEqual([heldGround.id]);
    expect(/** @type {Object} */ (blocking[0]).details.date).toBe(blockedDate);
    expect(/** @type {Object} */ (blocking[0]).details.startMinutes).toBe(
      heldGround.kickoffMinutes
    );
    // Every other conditional verdict is reported too, so the counts and the
    // findings are two views of one evaluation rather than two opinions.
    const conditionCodes = /** @type {Set<string>} */ (
      new Set([
        RESERVE_REASON.SLOT_CONDITION_SATISFIED,
        RESERVE_REASON.SLOT_CONDITION_BLOCKED,
        RESERVE_REASON.SLOT_CONDITION_UNDECIDABLE,
      ])
    );
    const reported = blockedReport.findings.filter((finding) => conditionCodes.has(finding.code));
    const judged = blockedReport.dates.reduce(
      (total, dateRow) =>
        total +
        dateRow.conditionSatisfied +
        dateRow.conditionBlocked +
        dateRow.conditionUndecidable,
      0
    );
    expect(judged).toBeGreaterThan(0);
    expect(reported.length).toBeGreaterThanOrEqual(judged);
  });

  it('reports an undecidable condition instead of dropping the count silently', () => {
    // GAP-14 through the whole path: a booking of unknown footprint on the
    // overlapping ground makes the condition undecidable, and the compromise
    // severity has to reach the report — the number moving on its own is what
    // the review caught.
    const unmeasurable = { ...heldGround, id: 'constructed#unmeasurable', endMinutes: null };
    const input = season2026ReserveCapacityInput(
      { ...season, combinedGames: [...season.combinedGames, unmeasurable] },
      { graph, table }
    );
    const undecided = buildReserveCapacityReport({ graph, table, calendar, registry }, input);
    observe(undecided.findings);
    const dateRow = /** @type {Object} */ (undecided.dates.find((row) => row.date === blockedDate));
    expect(dateRow.conditionUndecidable).toBeGreaterThan(0);
    expect(dateRow.available).toBeLessThan(dateRow.slots);
    const findings = undecided.findings.filter(
      (finding) => finding.code === RESERVE_REASON.SLOT_CONDITION_UNDECIDABLE
    );
    expect(findings).toHaveLength(dateRow.conditionUndecidable);
    expect(/** @type {Object} */ (findings[0]).details.undecidableBookingIds).toContain(
      unmeasurable.id
    );
    expect(undecided.status).toBe(RESERVE_STATUS.COMPROMISED);
  });

  it('is never blocked by the booking that is the candidate itself', () => {
    // Structural rather than filtered, and therefore checkable: a condition is
    // derived from the overlap relation with the surface's *own* id excluded, so
    // nothing standing on the candidate's own ground is ever watched. Enumerated
    // from the graph, which a break in `capacity.js` would leave intact.
    let checked = 0;
    for (const surfaceId of withHeldGround.surfaceIds) {
      const condition = conditionForSurface(graph, surfaceId);
      if (condition === null) continue;
      checked += 1;
      expect(condition.surfaceIds).not.toContain(surfaceId);
    }
    expect(checked).toBeGreaterThan(0);

    // The positive control that makes it falsifiable: force a condition to watch
    // its own ground, and a booking there does block the slot — unless it *is*
    // the slot, which `evaluateSlotCondition()` refuses by id.
    const selfWatching = {
      id: 'constructed#self-watching',
      date: blockedDate,
      startMinutes: 600,
      endMinutes: 690,
      condition: {
        kind: SLOT_CONDITION_KIND.SURFACE_IDLE,
        surfaceIds: [pitch2],
        derivedFrom: 'constructed for this control',
        reason: 'constructed: a condition that watches the ground it stands on',
      },
    };
    const ownBooking = {
      id: selfWatching.id,
      surfaceId: pitch2,
      date: blockedDate,
      startMinutes: 600,
      endMinutes: 690,
      format: '11v11',
      label: 'the candidate itself',
    };
    const itself = evaluateSlotCondition(graph, selfWatching, [ownBooking]);
    observe(itself.findings);
    expect(itself.verdict).toBe(CONDITION_VERDICT.SATISFIED);
    const somebodyElse = evaluateSlotCondition(graph, selfWatching, [
      { ...ownBooking, id: 'constructed#somebody-else' },
    ]);
    observe(somebodyElse.findings);
    expect(somebodyElse.verdict).toBe(CONDITION_VERDICT.BLOCKED);
  });

  it('moves no corpus figure it was not supposed to move', () => {
    expect(blockedReport.meta.reservedSlotsOffGrid).toBe(0);
    expect(blockedReport.meta.reservedSlotsMatched).toBe(100);
    expect(blockedReport.minSlots).toBe(report.minSlots);
    expect(blockedReport.maxSlots).toBe(report.maxSlots);
    for (const dateRow of blockedReport.dates) {
      const control = /** @type {Object} */ (report.dates.find((row) => row.date === dateRow.date));
      expect(dateRow.slots).toBe(control.slots);
      expect(dateRow.reserved).toBe(control.reserved);
      if (dateRow.date !== blockedDate) {
        expect(dateRow.available).toBe(control.available);
      }
    }
  });
});

describe('the pre-PR review :: an overlap nobody can measure is not an all-clear', () => {
  // GROUP B. `bookingsOverlapInTime()` returns `null` for an unknown footprint
  // (GAP-14) and `if (overlap !== true) continue` folded that into "no clash",
  // so a team bound into two slots one of which nobody can measure got a silent
  // pass. Zero is a measurement; unknown is not.
  const teamId = teamUniverse[0];
  const base = {
    kind: RESERVE_KIND.UNNAMED_FIXTURE,
    date: '2026-10-10',
    venueId: 'alder-park',
    surfaceId: season2026SurfaceId('Alder Park', 'Pitch 3'),
    format: '11v11',
    homeSide: FIXTURE_SIDE.TBD,
    awaySide: FIXTURE_SIDE.TBD,
    homeLabel: 'Select Game A',
  };
  const measurable = makeReservedSlot({
    ...base,
    id: 'constructed#measurable',
    label: 'Select Game A',
    startMinutes: 600,
    endMinutes: 690,
  });
  /** No `game_formats.csv` row means no footprint, exactly as the corpus's own
   * `Scrimmage` reservation has none. */
  const unmeasurable = makeReservedSlot({
    ...base,
    id: 'constructed#unmeasurable',
    label: 'Scrimmage - teams TBD',
    kind: RESERVE_KIND.RESERVATION,
    surfaceId: season2026SurfaceId('Riverbend', 'Turf'),
    venueId: 'riverbend',
    startMinutes: 610,
    endMinutes: null,
    format: 'Scrimmage',
    purpose: 'Scrimmage',
  });

  it('reports the pair it cannot measure rather than passing it', () => {
    const result = applySlotBindings(
      [measurable, unmeasurable],
      [
        { slotId: measurable.id, homeTeamId: teamId },
        { slotId: unmeasurable.id, homeTeamId: teamId },
      ],
      { teamUniverse }
    );
    observe(result.findings);
    expect(result.meta.bindingsApplied).toBe(2);
    const undecidable = result.findings.filter(
      (finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_TEAM_OVERLAP_UNDECIDABLE
    );
    expect(undecidable).toHaveLength(1);
    expect(/** @type {Object} */ (undecidable[0]).details.teamId).toBe(teamId);
    expect(/** @type {Object} */ (undecidable[0]).details.slotIds).toEqual(
      [measurable.id, unmeasurable.id].sort()
    );
    expect(reserveSeverityOf(RESERVE_REASON.RESERVED_SLOT_TEAM_OVERLAP_UNDECIDABLE)).toBe(
      RESERVE_SEVERITY.COMPROMISE
    );
    expect(result.status).toBe(RESERVE_STATUS.COMPROMISED);
    // …and it is *not* reported as a measured double booking, which would be the
    // opposite fabrication.
    expect(
      result.findings.some(
        (finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_TEAM_DOUBLE_BOOKED
      )
    ).toBe(false);
  });

  it('still says nothing about two measurable slots that genuinely do not overlap', () => {
    const later = makeReservedSlot({
      ...base,
      id: 'constructed#later',
      label: 'Select Game B',
      startMinutes: 720,
      endMinutes: 810,
    });
    const result = applySlotBindings(
      [measurable, later],
      [
        { slotId: measurable.id, homeTeamId: teamId },
        { slotId: later.id, homeTeamId: teamId },
      ],
      { teamUniverse }
    );
    observe(result.findings);
    expect(
      result.findings.some((finding) =>
        /** @type {string[]} */ ([
          RESERVE_REASON.RESERVED_SLOT_TEAM_DOUBLE_BOOKED,
          RESERVE_REASON.RESERVED_SLOT_TEAM_OVERLAP_UNDECIDABLE,
        ]).includes(finding.code)
      )
    ).toBe(false);
  });
});

describe('the pre-PR review :: one unplaced record describes one event', () => {
  // GROUP C1. The merged cause took `causeKind` from the report's entry and its
  // codes from the ledger's, so a single record could describe two different
  // events — and the precedence was the opposite of the one the file documents.
  const baseRun = {
    unplaced: [{ gameId: 'g-1', reason: 'no legal slot remained: TIME TBD (incident 10)' }],
    state: { baseline: { 'g-1': { date: '2026-09-19', homeLabel: 'A', awayLabel: 'B' } } },
  };
  const ledgerCause = {
    kind: 'constraint',
    codes: 'SUNSET_MARGIN_VIOLATED',
    constraintIds: ['sunset-margin'],
    counterpartGameIds: ['g-9'],
    bindingKinds: ['sunset'],
    slackMinutes: -25,
  };
  const reportCause = {
    gameId: 'g-1',
    label: 'A v B',
    causeKind: 'global-reoptimisation',
    codes: null,
    constraintIds: [],
    counterpartGameIds: [],
    bindingKinds: [],
    slackMinutes: null,
  };

  it('takes the whole cause from the ledger when the ledger has one', () => {
    const [fixture] = unplacedFromResolveRun({
      ...baseRun,
      report: { consequential: [reportCause], requested: [] },
      moves: [{ gameId: 'g-1', cause: ledgerCause }],
    });
    // Every field comes from the same event, and it is the one the file's header
    // says wins.
    expect(fixture.causeKind).toBe('constraint');
    expect(fixture.reasonCodes).toEqual(['SUNSET_MARGIN_VIOLATED']);
    expect(fixture.constraintIds).toEqual(['sunset-margin']);
    expect(fixture.counterpartFixtureIds).toEqual(['g-9']);
    expect(fixture.bindingKinds).toEqual(['sunset']);
    expect(fixture.slackMinutes).toBe(-25);
    // The label is an identity rather than a cause, so it still comes from the
    // report's record of the fixture.
    expect(fixture.label).toBe('A v B');
  });

  it('falls back to the report when the ledger named no cause', () => {
    const [fixture] = unplacedFromResolveRun({
      ...baseRun,
      report: {
        consequential: [
          {
            ...reportCause,
            causeKind: 'constraint',
            codes: 'PERMIT_WINDOW_CLOSED, SUNSET_MARGIN_VIOLATED',
            constraintIds: ['permit-window'],
            counterpartGameIds: ['g-4'],
          },
        ],
        requested: [],
      },
      moves: [{ gameId: 'g-1', cause: null }],
    });
    expect(fixture.causeKind).toBe('constraint');
    expect(fixture.reasonCodes).toEqual(['PERMIT_WINDOW_CLOSED', 'SUNSET_MARGIN_VIOLATED']);
    expect(fixture.constraintIds).toEqual(['permit-window']);
    expect(fixture.counterpartFixtureIds).toEqual(['g-4']);
  });

  it("never mixes one event's kind with another's codes", () => {
    const [fixture] = unplacedFromResolveRun({
      ...baseRun,
      report: { consequential: [reportCause], requested: [] },
      moves: [{ gameId: 'g-1', cause: ledgerCause }],
    });
    // The pairing is the assertion: a `global-reoptimisation` cause carries no
    // codes at all, so a record that reports one kind and the other's codes is
    // describing two events at once.
    if (fixture.causeKind === 'global-reoptimisation') {
      expect(fixture.reasonCodes).toEqual([]);
      expect(fixture.constraintIds).toEqual([]);
    } else {
      expect(fixture.causeKind).toBe(ledgerCause.kind);
      expect(fixture.reasonCodes).toEqual([ledgerCause.codes]);
    }
  });
});

describe('the pre-PR review :: the export coverage check can fail', () => {
  // GROUP C2, the anti-pattern `CLAUDE.md` names by name: `covered` was derived
  // from the rows the same loop had just emitted, so the check compared a set
  // against itself and was structurally unable to fail. The expected set now
  // comes from the inventory the rows are built *from*, and the drop below
  // proves it fires.
  const slot = /** @type {Object} */ (unnamed[0]);
  const fixture = makeUnplacedFixture({
    fixtureId: 'constructed#unplaced',
    label: 'A v B',
    reason: 'no candidate slot survived: TIME TBD',
  });
  const subjects = { slots: [slot], unplaced: [fixture] };

  it('passes when every subject produced a row', () => {
    const projection = publicationRowsFor(subjects);
    expect(projection.rows).toHaveLength(2);
    expect(publicationCoverageFindings(subjects, projection.rows)).toEqual([]);
    expect(projection.findings).toEqual([]);
  });

  it('fires when a subject produced none — the constructed drop', () => {
    const projection = publicationRowsFor(subjects);
    const withoutFixture = projection.rows.filter((entry) => entry.subjectId !== fixture.fixtureId);
    const dropped = observe(publicationCoverageFindings(subjects, withoutFixture));
    expect(dropped.map((finding) => finding.code)).toEqual([RESERVE_REASON.FIXTURE_DROPPED]);
    expect(/** @type {Object} */ (dropped[0]).details.fixtureId).toBe(fixture.fixtureId);
    expect(deriveReserveStatus(dropped)).toBe(RESERVE_STATUS.REJECTED);

    // A reserved slot that produced no row is the same failure on the other
    // half of the inventory: ground the club committed would print as free.
    const withoutSlot = projection.rows.filter((entry) => entry.subjectId !== slot.id);
    const lost = observe(publicationCoverageFindings(subjects, withoutSlot));
    expect(lost.map((finding) => finding.code)).toEqual([RESERVE_REASON.RESERVED_SLOT_DROPPED]);
    expect(/** @type {Object} */ (lost[0]).details.slotId).toBe(slot.id);
  });
});

describe('the pre-PR review :: a rendered time stays inside its day', () => {
  // GROUP C3. `naiveDateTime()` did not clamp to a day, so an end at or past
  // midnight rendered as `T24:00:00` — not a time, and unparseable in the `End`
  // column of an export.
  it('rolls a time past midnight onto the next date', () => {
    expect(naiveDateTime('2026-11-07', 24 * 60, PUBLICATION_TBD.TIME)).toBe('2026-11-08T00:00:00');
    expect(naiveDateTime('2026-11-07', 24 * 60 + 30, PUBLICATION_TBD.TIME)).toBe(
      '2026-11-08T00:30:00'
    );
    // Month and year boundaries are calendar arithmetic, not string surgery.
    expect(naiveDateTime('2026-10-31', 24 * 60 + 15, PUBLICATION_TBD.TIME)).toBe(
      '2026-11-01T00:15:00'
    );
    expect(naiveDateTime('2026-12-31', 25 * 60, PUBLICATION_TBD.TIME)).toBe('2027-01-01T01:00:00');
    // Nothing inside the day moves, and no time is invented for a slot with none.
    expect(naiveDateTime('2026-11-07', 23 * 60 + 59, PUBLICATION_TBD.TIME)).toBe(
      '2026-11-07T23:59:00'
    );
    expect(naiveDateTime('2026-11-07', null, PUBLICATION_TBD.TIME)).toBe(PUBLICATION_TBD.TIME);
  });

  it('never prints a 24th hour into an export column', () => {
    const late = makeReservedSlot({
      id: 'constructed#late',
      kind: RESERVE_KIND.UNNAMED_FIXTURE,
      label: 'Select Game Z',
      date: '2026-11-07',
      venueId: 'riverbend',
      surfaceId: season2026SurfaceId('Riverbend', 'Turf'),
      startMinutes: 23 * 60,
      endMinutes: 24 * 60 + 30,
      format: '11v11',
      homeSide: FIXTURE_SIDE.TBD,
      awaySide: FIXTURE_SIDE.TBD,
      homeLabel: 'Select Game Z',
    });
    const projection = publicationRowsFor({ slots: [late], unplaced: [] });
    const row = projection.rows[0].row;
    expect(row[SCHEDULE_EXPORT_HEADERS.START]).toBe('2026-11-07T23:00:00');
    expect(row[SCHEDULE_EXPORT_HEADERS.END]).toBe('2026-11-08T00:30:00');
    for (const column of [SCHEDULE_EXPORT_HEADERS.START, SCHEDULE_EXPORT_HEADERS.END]) {
      expect(row[column]).not.toMatch(/T2[4-9]:/);
    }
  });
});

describe('the pre-PR review :: a session is not an assignment', () => {
  // GROUP C4. `assigned` asked `slotIsSettled()`, which is true of a session,
  // an absent opponent and a visiting club alike, so a Minis capacity report
  // counted every session as assigned with no team named anywhere.
  // `slotNamesATeam()` is the sibling contract, adopted rather than replaced by
  // a third predicate.
  const field6 = season2026SurfaceId('Orchard Park', 'Field 6');
  const minisRows = season.combinedGames.filter(
    (row) => row.kind === SEASON_2026_KIND.MINIS_SESSION
  );
  /** The corpus's own Minis sessions as held ground, in this module's record. */
  const sessions = minisRows.map((row) => {
    const sides = season2026FixtureSides(row, { teamUniverse });
    return makeReservedSlot({
      id: String(row.id),
      kind: RESERVE_KIND.RESERVATION,
      label: String(row.homeLabel),
      date: String(row.date),
      venueId: 'orchard-park',
      surfaceId: field6,
      startMinutes: Number(row.kickoffMinutes),
      endMinutes: Number(row.endMinutes),
      format: 'Minis',
      purpose: 'Minis session',
      homeSide: sides.homeSide,
      awaySide: sides.awaySide,
      homeLabel: String(row.homeLabel),
      source: 'fixtures/season-2026/combined_schedule.csv',
    });
  });

  const minisReport = buildReserveCapacityReport(
    { graph, table, calendar, registry },
    {
      name: 'season-2026 Minis capacity',
      format: 'Minis',
      dates: [...new Set(sessions.map((slot) => slot.date))].sort(),
      surfaceIds: [field6],
      cadenceMinutes: table.formats.Minis.blockMinutes,
      earliestKickoffMinutes: 9 * 60,
      requirement: {
        slots: 4,
        label: 'all four Minis groups on the same morning',
        source: 'fixtures/season-2026/combined_schedule.csv, Minis rows',
      },
      cap: null,
      reservedSlots: sessions,
      bookings: season2026ReserveBookings(season.combinedGames),
    }
  );

  it('meta-assertion :: the report really is made of sessions', () => {
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((slot) => slot.homeSide === FIXTURE_SIDE.SESSION)).toBe(true);
    expect(sessions.every((slot) => slot.awaySide === FIXTURE_SIDE.NONE)).toBe(true);
    // Settled — there is nobody left to name — and naming no team at all. That
    // gap between the two predicates is the defect.
    expect(sessions.every((slot) => slotIsSettled(slot))).toBe(true);
    expect(sessions.some((slot) => slotNamesATeam(slot))).toBe(false);
    expect(minisReport.meta.slotsGenerated).toBeGreaterThan(0);
    expect(minisReport.dates.length).toBeGreaterThan(0);
  });

  it('counts no session as assigned, because none names a team', () => {
    for (const dateRow of minisReport.dates) {
      expect(dateRow.reserved).toBeGreaterThan(0);
      expect(dateRow.assigned).toBe(0);
      expect(dateRow.unassigned).toBe(dateRow.reserved);
    }
  });

  it('still counts a named team as assigned', () => {
    const named = sessions.slice(0, 1).map((slot) =>
      makeReservedSlot({
        ...slot,
        id: `${slot.id}#named`,
        homeSide: FIXTURE_SIDE.TEAM,
        homeTeamId: teamUniverse[0],
        homeLabel: null,
      })
    );
    const withTeam = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      {
        name: 'season-2026 Minis capacity, one named',
        format: 'Minis',
        dates: [named[0].date],
        surfaceIds: [field6],
        cadenceMinutes: table.formats.Minis.blockMinutes,
        earliestKickoffMinutes: 9 * 60,
        requirement: {
          slots: 4,
          label: 'all four Minis groups on the same morning',
          source: 'fixtures/season-2026/combined_schedule.csv, Minis rows',
        },
        cap: null,
        reservedSlots: named,
        bookings: season2026ReserveBookings(season.combinedGames),
      }
    );
    expect(withTeam.dates[0].reserved).toBe(1);
    expect(withTeam.dates[0].assigned).toBe(1);
    expect(withTeam.dates[0].unassigned).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The three defects the /code-review pass found                               */
/* -------------------------------------------------------------------------- */

describe('the code review :: a reservation the report does not cover is reconciled, not dropped', () => {
  // DEFECT 1. `inScope` filtered reserved slots on `surfaceIds` and nothing
  // reconciled the remainder, so `RESERVED_SLOT_OFF_GRID` caught a reservation
  // misplaced in *time* and nothing at all caught one misplaced in *space*: a
  // slot standing on ground the report does not cover fell out of every count
  // and every check. A commitment that disappears without a word is incident 10
  // in one line.
  const strandedDate = '2026-10-10';
  const brookside = season2026SurfaceId('Brookside Park', 'Upper 1');

  /**
   * Constructed, in the corpus's own row shape: an eleventh league placeholder
   * on a date the report covers, of the report's own format, standing on
   * Brookside ground the report's surface universe does not include.
   *
   * Brookside on purpose. It is 9v9/7v7 ground at a venue with no overlap pairs
   * at all, so this row can block no condition anywhere — the only thing it can
   * change is the reconciliation, which is what is under test.
   */
  const stranded = {
    id: 'constructed#brookside-placeholder',
    kind: SEASON_2026_KIND.LEAGUE_PLACEHOLDER,
    date: strandedDate,
    venue: 'Brookside Park',
    field: 'Upper 1',
    kickoffMinutes: 600,
    endMinutes: 690,
    format: SEASON_2026_RESERVE_FORMAT,
    division: 'Select',
    homeLabel: 'Select Game 101',
    awayLabel: '-',
  };

  const strandedInput = season2026ReserveCapacityInput(
    { ...season, combinedGames: [...season.combinedGames, stranded] },
    { graph, table }
  );
  const strandedReport = buildReserveCapacityReport(
    { graph, table, calendar, registry },
    strandedInput
  );

  it('really is out of the report — the premise, checked rather than assumed', () => {
    expect(strandedInput.surfaceIds).not.toContain(brookside);
    expect(strandedInput.surfaceIds).toEqual(capacityInput.surfaceIds);
    expect(strandedInput.dates).toEqual(capacityInput.dates);
    expect(strandedInput.reservedSlots.some((slot) => slot.id === stranded.id)).toBe(true);
  });

  it('counts it against the external cap and names the ground the report does not cover', () => {
    const dateRow = /** @type {Object} */ (
      strandedReport.dates.find((row) => row.date === strandedDate)
    );
    expect(dateRow.reserved).toBe(SEASON_2026_LEAGUE_CAP_PER_DATE + 1);
    expect(dateRow.overCap).toBe(true);
    expect(dateRow.atCap).toBe(false);

    const codes = observe(strandedReport.findings).map((finding) => finding.code);
    expect(codes).toContain(RESERVE_REASON.RESERVE_CAP_EXCEEDED);
    expect(codes).toContain(RESERVE_REASON.RESERVED_SLOT_UNCOVERED);
    const uncovered = strandedReport.findings.filter(
      (finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_UNCOVERED
    );
    expect(uncovered).toHaveLength(1);
    expect(/** @type {Object} */ (uncovered[0]).details.slotId).toBe(stranded.id);
    expect(/** @type {Object} */ (uncovered[0]).details.surfaceCovered).toBe(false);
    expect(/** @type {Object} */ (uncovered[0]).details.dateCovered).toBe(true);
    expect(/** @type {Object} */ (uncovered[0]).details.countedOnDate).toBe(true);
    expect(uncovered[0].severity).toBe(RESERVE_SEVERITY.BLOCKING);
    expect(strandedReport.status).toBe(RESERVE_STATUS.REJECTED);
  });

  it('reports a reservation on a date it does not cover, and says it counted nowhere', () => {
    const oneDate = capacityInput.dates[0];
    const narrowed = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      { ...capacityInput, dates: [oneDate] }
    );
    const offDate = observe(narrowed.findings).filter(
      (finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_UNCOVERED
    );
    // Ninety of the hundred stand on dates this narrowed report does not cover.
    expect(offDate).toHaveLength(90);
    expect(offDate.every((finding) => finding.details.dateCovered === false)).toBe(true);
    expect(offDate.every((finding) => finding.details.countedOnDate === false)).toBe(true);
    expect(narrowed.dates).toHaveLength(1);
    expect(/** @type {Object} */ (narrowed.dates[0]).reserved).toBe(
      SEASON_2026_LEAGUE_CAP_PER_DATE
    );
  });

  it('reconciles every reserved slot it was handed — the meta-assertion, with the identity', () => {
    // Every slot given is in exactly one of four buckets: another format (the
    // report's stated subject), uncovered ground or an uncovered date, matched
    // to a generated slot, or off the grid. A slot in none of them is the
    // silence this defect was.
    const balances = (meta) =>
      meta.slotsOtherFormat +
      meta.reservedSlotsUncovered +
      meta.reservedSlotsMatched +
      meta.reservedSlotsOffGrid;

    expect(report.meta.slotsExamined).toBe(slots.length);
    expect(report.meta.slotsExamined).toBe(101);
    // The corpus's own remainder: the single `Scrimmage` reservation, which is
    // held ground rather than a game of the format this report counts.
    expect(report.meta.slotsOtherFormat).toBe(1);
    expect(report.meta.reservedSlotsUncovered).toBe(0);
    expect(balances(report.meta)).toBe(report.meta.slotsExamined);

    // …and it balances where the remainder is not zero, which is what makes the
    // identity worth asserting.
    expect(strandedReport.meta.reservedSlotsUncovered).toBe(1);
    expect(strandedReport.meta.reservedSlotsMatched).toBe(100);
    expect(balances(strandedReport.meta)).toBe(strandedReport.meta.slotsExamined);
  });

  it('moves no other corpus figure', () => {
    expect(strandedReport.minSlots).toBe(report.minSlots);
    expect(strandedReport.maxSlots).toBe(report.maxSlots);
    for (const dateRow of strandedReport.dates) {
      const control = /** @type {Object} */ (report.dates.find((row) => row.date === dateRow.date));
      expect(dateRow.slots).toBe(control.slots);
      expect(dateRow.available).toBe(control.available);
      if (dateRow.date !== strandedDate) expect(dateRow.reserved).toBe(control.reserved);
    }
  });
});

describe('the code review :: held ground whose condition fails is blocking, from the production path', () => {
  // DEFECT 2. `RESERVED_SLOT_CONDITION_BLOCKED` fired only on `{ reserved: true }`
  // and `capacity.js` never passed it, so the code was declared, severity-tabled,
  // documented — and unreachable from anything but a test. Held ground whose
  // condition has failed is exactly the case that should block; that is what
  // holding the ground means.
  const pitch3 = season2026SurfaceId('Alder Park', 'Pitch 3');
  const pitch4 = season2026SurfaceId('Alder Park', 'Pitch 4');
  const heldDate = '2026-10-10';
  const heldKickoff = 10 * 60;

  /** Where the corpus's reserved slots actually stand, from the slots. */
  const reservedPositions = new Set(
    slots
      .filter((slot) => slot.format === SEASON_2026_RESERVE_FORMAT)
      .map((slot) => `${slot.date}|${slot.surfaceId}|${slot.startMinutes}`)
  );

  it('states plainly that the corpus produces no such case', () => {
    // The honest finding, asserted rather than assumed: the corpus's 26 blocked
    // conditional candidates are all on Alder Pitch 2, where the club reserved
    // nothing, and the only rows standing on Pitch 3's overlapping neighbours
    // (Pitch 4 and its halves) fall on two August dates the reserve season does
    // not reach. So no reserved slot in this corpus has a condition that fails:
    // the code is reachable in principle, and exercised by the constructed case
    // below rather than by the corpus.
    expect(reservedPositions.size).toBe(100);
    const blocked = report.findings.filter(
      (finding) => finding.code === RESERVE_REASON.SLOT_CONDITION_BLOCKED
    );
    // The check has subjects — without this it would pass on an empty set.
    expect(blocked.length).toBeGreaterThan(0);
    expect(
      blocked.filter((finding) => reservedPositions.has(String(finding.details.slotId)))
    ).toHaveLength(0);
    expect(
      report.findings.some(
        (finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_CONDITION_BLOCKED
      )
    ).toBe(false);
    const onPitch4 = season.combinedGames.filter(
      (row) => row.venue === 'Alder Park' && String(row.field).startsWith('Pitch 4')
    );
    expect(onPitch4.length).toBeGreaterThan(0);
    expect([...new Set(onPitch4.map((row) => row.date))].sort()).toEqual([
      '2026-08-22',
      '2026-08-29',
    ]);
    for (const row of onPitch4) expect(capacityInput.dates).not.toContain(row.date);
  });

  /**
   * Constructed: ground held on Alder Pitch 4, which physically overlaps
   * Pitch 3, across a kickoff the club has an 11v11 slot reserved on.
   *
   * A `Scrimmage` like the corpus's own reservation, so it is none of the
   * report's reserved slots and can move no slot or reserved count; it carries
   * an end, so the overlap is measurable and the verdict is `blocked` rather
   * than `undecidable`.
   */
  const heldGround = {
    id: 'constructed#alder-pitch-4-reservation',
    kind: SEASON_2026_KIND.RESERVATION,
    date: heldDate,
    venue: 'Alder Park',
    field: 'Pitch 4',
    kickoffMinutes: heldKickoff,
    endMinutes: heldKickoff + 90,
    format: 'Scrimmage',
    division: 'Select',
    homeLabel: 'Scrimmage - teams TBD',
    awayLabel: '-',
  };
  const heldInput = season2026ReserveCapacityInput(
    { ...season, combinedGames: [...season.combinedGames, heldGround] },
    { graph, table }
  );
  const heldReport = buildReserveCapacityReport({ graph, table, calendar, registry }, heldInput);

  it('fires the blocking code through buildReserveCapacityReport, not only a direct call', () => {
    const candidateId = `${heldDate}|${pitch3}|${heldKickoff}`;
    // The premise: that candidate really is ground the club reserved.
    expect(reservedPositions.has(candidateId)).toBe(true);
    expect(heldInput.surfaceIds).not.toContain(pitch4);

    const fired = observe(heldReport.findings).filter(
      (finding) => finding.code === RESERVE_REASON.RESERVED_SLOT_CONDITION_BLOCKED
    );
    expect(fired).toHaveLength(1);
    expect(/** @type {Object} */ (fired[0]).details.slotId).toBe(candidateId);
    expect(/** @type {Object} */ (fired[0]).details.blockingBookingIds).toEqual([heldGround.id]);
    expect(fired[0].severity).toBe(RESERVE_SEVERITY.BLOCKING);
    expect(heldReport.status).toBe(RESERVE_STATUS.REJECTED);
  });

  it('leaves an unreserved candidate at info — the same block, judged by who holds it', () => {
    // The control that makes the escalation falsifiable: the corpus's 26 Pitch 2
    // blocks are candidates nobody reserved and stay `info` in the very same
    // report. A fix that simply marked every candidate reserved would fail here.
    const stillInfo = heldReport.findings.filter(
      (finding) => finding.code === RESERVE_REASON.SLOT_CONDITION_BLOCKED
    );
    expect(stillInfo).toHaveLength(26);
    expect(stillInfo.every((finding) => finding.severity === RESERVE_SEVERITY.INFO)).toBe(true);
    expect(
      stillInfo.every((finding) => !reservedPositions.has(String(finding.details.slotId)))
    ).toBe(true);
    // The counts and the findings stay two views of one evaluation: 27 blocked
    // verdicts, 26 reported at `info` and one at `blocking`.
    const judged = heldReport.dates.reduce((total, dateRow) => total + dateRow.conditionBlocked, 0);
    expect(judged).toBe(27);
    expect(stillInfo.length + 1).toBe(judged);
  });

  it('moves the slot and reserved counts not at all, and `available` by exactly one', () => {
    const control = /** @type {Object} */ (report.dates.find((row) => row.date === heldDate));
    const held = /** @type {Object} */ (heldReport.dates.find((row) => row.date === heldDate));
    expect(held.slots).toBe(control.slots);
    expect(held.reserved).toBe(control.reserved);
    expect(held.conditionBlocked).toBe(control.conditionBlocked + 1);
    expect(held.available).toBe(control.available - 1);
    expect(heldReport.meta.reservedSlotsMatched).toBe(100);
    expect(heldReport.meta.reservedSlotsOffGrid).toBe(0);
  });
});

describe('the code review :: fixture accounting totals that cannot both be right', () => {
  // DEFECT 3. A fixture reported both placed and unplaced was counted in both
  // `placed` and `unplaced`, so `accounted` exceeded `expected` while `missing`
  // stayed 0 — a total inflated by the very disagreement the finding reports.
  // And `placedFixtureIds` / `unplaced` were unguarded where `expectedFixtureIds`
  // was guarded, in the same function.
  const unplacedFixture = (fixtureId) =>
    makeUnplacedFixture({ fixtureId, label: `${fixtureId} v control`, reason: 'nowhere to go' });

  it('counts a double-counted fixture once and names it', () => {
    const both = accountForFixtures({
      expectedFixtureIds: ['constructed-a', 'constructed-b', 'constructed-c'],
      placedFixtureIds: ['constructed-a', 'constructed-b'],
      unplaced: [unplacedFixture('constructed-b')],
    });
    expect(observe(both.findings).map((finding) => finding.code)).toContain(
      RESERVE_REASON.FIXTURE_DOUBLE_COUNTED
    );
    // The defect, first: `accounted` counted the disputed fixture twice, so it
    // exceeded `expected` while `missing` still named the one genuinely absent.
    expect(both.totals.expected).toBe(3);
    expect(both.totals.accounted).toBe(2);
    expect(both.totals.missing).toBe(1);
    expect(both.totals.accounted + both.totals.missing).toBe(both.totals.expected);
    expect(both.missingFixtureIds).toEqual(['constructed-c']);
    // Both source lists are still reported as each source stated them…
    expect(both.totals.placed).toBe(2);
    expect(both.totals.unplaced).toBe(1);
    // …and the disagreement is named rather than folded into a total.
    expect(both.doubleCountedFixtureIds).toEqual(['constructed-b']);
    expect(both.totals.doubleCounted).toBe(1);
  });

  it('keeps the identity on a clean accounting too', () => {
    const clean = accountForFixtures({
      expectedFixtureIds: ['constructed-a', 'constructed-b'],
      placedFixtureIds: ['constructed-a'],
      unplaced: [unplacedFixture('constructed-b')],
    });
    expect(clean.totals.doubleCounted).toBe(0);
    expect(clean.doubleCountedFixtureIds).toEqual([]);
    expect(clean.totals.accounted).toBe(2);
    expect(clean.totals.accounted + clean.totals.missing).toBe(clean.totals.expected);
    expect(clean.status).toBe(RESERVE_STATUS.COMPROMISED);
  });

  it('guards its other two inputs the way it guards the first', () => {
    expect(() => accountForFixtures(/** @type {Object} */ ({ expectedFixtureIds: ['x'] }))).toThrow(
      /placedFixtureIds/
    );
    expect(() =>
      accountForFixtures(
        /** @type {Object} */ ({ expectedFixtureIds: ['x'], placedFixtureIds: [] })
      )
    ).toThrow(/unplaced/);
    expect(() =>
      accountForFixtures(/** @type {Object} */ ({ placedFixtureIds: [], unplaced: [] }))
    ).toThrow(/expectedFixtureIds/);
  });
});

/* -------------------------------------------------------------------------- */
/* Reason-code hygiene                                                         */
/* -------------------------------------------------------------------------- */

describe('reserve :: reason codes and severities', () => {
  it('registers a severity for every code and refuses an unregistered one', () => {
    for (const code of Object.values(RESERVE_REASON)) {
      expect(Object.values(RESERVE_SEVERITY)).toContain(reserveSeverityOf(code));
      expect(RESERVE_REASON_SEVERITY[code]).toBe(reserveSeverityOf(code));
    }
    expect(Object.keys(RESERVE_REASON_SEVERITY).sort()).toEqual(
      Object.values(RESERVE_REASON).sort()
    );
    expect(() => reserveSeverityOf('RESERVE_NOT_A_CODE')).toThrow(/no registered severity/);
  });

  it('looks severity up rather than accepting it', () => {
    const finding = makeReserveFinding(RESERVE_REASON.RESERVED_SLOT_MOVED, 'x');
    expect(finding.severity).toBe(RESERVE_SEVERITY.BLOCKING);
    expect(deriveReserveStatus([finding])).toBe(RESERVE_STATUS.REJECTED);
    expect(deriveReserveStatus([])).toBe(RESERVE_STATUS.ALLOWED);
  });

  it('starts every counter at zero and merges additively', () => {
    const meta = createReserveMeta();
    expect(Object.values(meta).every((value) => value === 0)).toBe(true);
    const merged = mergeReserveMeta(createReserveMeta(), { ...meta, slotsExamined: 3 });
    expect(merged.slotsExamined).toBe(3);
  });

  it('emits every code it declares, somewhere in this suite', () => {
    // The meta-assertion over the whole file. A code the module can declare but
    // never produce is one nothing proves the meaning of — the `declared-only`
    // state, at the level of a reason table. `OBSERVED` is filled by `observe()`
    // at each place findings are produced above, so this fails the moment a code
    // is added without a case that fires it.
    expect(OBSERVED.size).toBeGreaterThan(0);
    const declared = /** @type {string[]} */ (Object.values(RESERVE_REASON)).sort();
    const missing = declared.filter((code) => !OBSERVED.has(code));
    expect(
      missing,
      `these reason codes are declared and nothing in this suite makes the module emit them: ${missing.join(', ')}`
    ).toEqual([]);
    // And nothing emitted a code that is not in the table — which
    // `reserveSeverityOf()` would have thrown on anyway, so this is the belt to
    // that brace.
    expect([...OBSERVED].filter((code) => !declared.includes(code))).toEqual([]);
  });
});
