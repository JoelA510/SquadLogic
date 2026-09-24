/**
 * A standing guard for the defect class that produced rounds 1 and 2 of the
 * whole-build review.
 *
 * **The class.** `facility/facilityGraph.js` exposes two lookups. `getSurface()`
 * returns `null`; `requireSurface()` throws, and its own doc-comment says to use
 * it "where a missing surface is a programming error rather than user input".
 * Ten modules outside `facility/` import a function that reaches
 * `requireSurface()` — `surfacesConflict()`, `conflictingSurfacesOf()`,
 * `checkSizeEligibility()` and their neighbours — and every one of them is
 * handed surface ids that came from **data**: a CSV row, an external league's
 * feed, a query object a caller typed. Three times now, in three unrelated
 * modules, one of those calls has been left unguarded while a sibling in the
 * same flow reported `SURFACE_UNKNOWN` and carried on:
 *
 * - round 1, `externalImport/impact.js` — the pair scan threw while the
 *   enumerator beside it reported;
 * - round 2, `timing/warmup.js` — `conflictingBookingsOn()` guarded each
 *   booking's surface and not the query's own, while both siblings in
 *   `availability/kickoff.js` reported;
 * - round 2, `ruleEngine/rules.js` — `scanConcurrency()` threw, taking both
 *   concurrency rules down with it, so every real clash went unreported and the
 *   `OCCUPIED_*` counts fell to zero, which `verify` reads as an improvement.
 *
 * Each was found by a human reading the code. A class that depends on
 * remembering is what produced three of them.
 *
 * **What this file does.** It derives the list of modules at risk **from the
 * source** rather than from a list typed here, and requires every one of them to
 * be classified and pinned:
 *
 * - {@link REPORTS} — a driver below calls a public entry point with a surface
 *   id the graph does not hold and asserts it does not throw, and that it says
 *   so with the code it names.
 * - {@link REPORTS_ELSEWHERE} — the behaviour is already pinned by a named test
 *   in another file, and this file reads that file and asserts the title is
 *   still there.
 * - {@link DECIDED_TO_THROW} — the module has decided to throw, consistently,
 *   with a stated reason; the driver asserts it throws and that the message
 *   names the surface.
 * - {@link GRAPH_DERIVED_IDS} — every id the module passes was enumerated from
 *   the graph, so `requireSurface()` cannot fail; the reason is stated.
 *
 * A new module that imports a throwing lookup and is classified nowhere fails
 * the census assertion. That is the whole point: the next instance of this class
 * cannot be introduced silently, and the person introducing it has to say which
 * of the four it is.
 *
 * The categories are **not** a claim that reporting is always right. Two of the
 * ten deliberately throw, and this file records that as a decision rather than
 * quietly converting it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { PRACTICE_REASON, repairPracticeLoss } from '@squadlogic/core/practice/index.js';
import {
  buildAvailabilityCalendarFromSeason2026,
  buildClosureSet,
  checkClosures,
  checkKickoffAvailability,
  findClosureBreaches,
  latestLegalKickoff,
  resolveLighting,
} from '@squadlogic/core/availability/index.js';
import { buildSeason2026ConstraintRegistry } from '@squadlogic/core/constraints/index.js';
import {
  FACILITY_REASON,
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
} from '@squadlogic/core/facility/index.js';
import {
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import { FEASIBILITY_REASON, analyseMoveRequest } from '@squadlogic/core/feasibility/index.js';
import { buildAttributionContext } from '@squadlogic/core/attribution/index.js';
import { toSeason2026PlacementInput } from '@squadlogic/core/placement/index.js';
import { replaceGamesUnderRegistry } from '@squadlogic/core/placement/index.js';
import {
  buildReserveCapacityReport,
  conditionForSurface,
  evaluateSlotCondition,
} from '@squadlogic/core/reserve/index.js';
import { runRuleEngine, toSeason2026Schedule } from '@squadlogic/core/ruleEngine/index.js';
import { replacementSurfacesFor } from '@squadlogic/core/scenario/index.js';
import {
  buildFormatTimingTableFromSeason2026,
  earliestKickoffWithWarmup,
  warmupWindowAvailability,
} from '@squadlogic/core/timing/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus and engines                                                          */
/* -------------------------------------------------------------------------- */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = path.join(ROOT, 'packages', 'core', 'src');

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
const venueComplexes = buildSeason2026VenueComplexMap();
const season = loadSeason2026();
const schedule = toSeason2026Schedule(season);
const resources = { graph, timingTable: table, calendar, venueComplexes };

/** A real surface, so only its presence in the graph differs from the ghost. */
const REAL = 'alder-park/pitch-2';
/** Ground the graph does not hold, spelled from a real id. */
const GHOST = `${REAL}-not-in-the-graph`;
/** A date the corpus actually schedules on. */
const DATE = schedule.games.find((game) => game.surfaceId === REAL)?.date ?? '2026-08-22';

/** Every reason code a returned value carries, however deeply. */
function codesIn(value, seen = new Set()) {
  /** @type {string[]} */
  const out = [];
  if (value === null || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (typeof value.code === 'string' && typeof value.severity === 'string') out.push(value.code);
  for (const inner of Array.isArray(value) ? value : Object.values(value)) {
    out.push(...codesIn(inner, seen));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The census, derived from the source                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every `facility/` export that reaches a throwing lookup.
 *
 * `requireSurface()` itself, plus everything that calls it on a caller-supplied
 * id. `getSurface()`, `findSurfaceByName()` and `bookingsOverlapInTime()` are
 * deliberately absent: they return `null` or a boolean and cannot throw.
 */
const THROWING_LOOKUPS = Object.freeze([
  'requireSurface',
  'surfacesConflict',
  'conflictingSurfacesOf',
  'occupancyFootprint',
  'cellsOf',
  'lineageOf',
  'descendantsOf',
  'checkOccupancy',
  'checkSizeEligibility',
  'checkLining',
  'checkEquipment',
  'checkFieldEligibility',
  'checkBooking',
]);

/**
 * Every `.js` file under one directory, recursively, as a repo-relative path.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function sourceFilesUnder(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...sourceFilesUnder(full));
    else if (entry.endsWith('.js')) files.push(full);
  }
  return files;
}

/**
 * Which modules outside `facility/` import a throwing lookup from it, and which.
 *
 * Read off the import statements rather than off a list, so a module that starts
 * importing one appears here without anybody remembering to add it.
 *
 * @returns {Record<string, string[]>}
 */
function census() {
  /** @type {Record<string, string[]>} */
  const found = {};
  const facilityDir = path.join(CORE_SRC, 'facility') + path.sep;
  for (const file of sourceFilesUnder(CORE_SRC)) {
    if (file.startsWith(facilityDir)) continue;
    const source = readFileSync(file, 'utf8');
    const key = path.relative(CORE_SRC, file).split(path.sep).join('/');
    for (const match of source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*'([^']*facility\/[^']*)'/g
    )) {
      const imported = match[1]
        .split(',')
        .map((name) => name.trim().split(' as ')[0].trim())
        .filter(Boolean);
      const risky = imported.filter((name) => THROWING_LOOKUPS.includes(name));
      if (risky.length === 0) continue;
      found[key] = [...new Set([...(found[key] ?? []), ...risky])].sort();
    }
  }
  return found;
}

const CENSUS = census();

/* -------------------------------------------------------------------------- */
/* The classification                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Modules whose public answer about ground the graph does not hold is a
 * **finding**, driven here. `expectCode` is the code the answer must carry, or
 * `null` with a stated reason when the module produces no finding of its own.
 *
 * @type {Record<string, Array<{ label: string, run: () => unknown, expectCode: string|null, reason?: string }>>}
 */
/** One all-day closure over the whole of Alder, so a real booking would be inside it. */
const closureSet = buildClosureSet(graph, {
  closures: [
    {
      id: 'alder-shut',
      fromDate: DATE,
      toDate: DATE,
      startMinutes: 0,
      endMinutes: 23 * 60,
      allDay: true,
      scope: { kind: 'venue', venueIds: [graph.surfaces[REAL].venueId] },
      reason: 'census',
    },
  ],
});

const REPORTS = {
  'practice/repair.js': [
    {
      label: 'repairPracticeLoss(a loss naming ground the graph does not hold)',
      expectCode: PRACTICE_REASON.REPAIR_LOSS_UNKNOWN_SURFACE,
      run: () =>
        repairPracticeLoss({
          plan: {
            slots: [
              {
                id: 'census:slot',
                // A series standing on unknown ground too: it is compared by
                // id and never handed to a throwing lookup.
                surfaceId: GHOST,
                weekday: 'TUE',
                startMinutes: 17 * 60,
                durationMinutes: 60,
                validFrom: '2026-09-01',
                validUntil: '2026-11-30',
              },
            ],
            assignments: [{ id: 'census:assignment', slotId: 'census:slot', teamId: 'census' }],
          },
          graph,
          loss: { surfaceIds: [GHOST], from: '2026-10-05', reason: 'census' },
          inventory: [
            { surfaceId: GHOST, weekday: 'WED', startMinutes: 17 * 60, durationMinutes: 60 },
            { surfaceId: REAL, weekday: 'WED', startMinutes: 17 * 60, durationMinutes: 60 },
          ],
        }),
    },
  ],
  'feasibility/moveRequest.js': [
    {
      label: 'analyseMoveRequest(a practice on ground the graph does not hold)',
      expectCode: FEASIBILITY_REASON.MOVE_REQUEST_HOLDING_SURFACE_UNKNOWN,
      run: () =>
        analyseMoveRequest(
          buildAttributionContext({
            graph,
            table,
            calendar,
            registry,
            schedule,
            verification: null,
            venueComplexes,
            roster: null,
          }),
          {
            entityKind: 'practice',
            entityId: 'census:subject',
            dates: [DATE],
            surfaceIds: [REAL],
            cadenceMinutes: 60,
            earliestKickoffMinutes: 10 * 60,
            latestKickoffMinutes: 11 * 60,
          },
          {
            venueComplexes,
            practices: [
              {
                id: 'census:subject',
                date: DATE,
                surfaceId: REAL,
                startMinutes: 9 * 60,
                endMinutes: 9 * 60 + 55,
                format: '7v7',
                teamIds: ['census-subject'],
                personIds: [],
              },
              // The id that came from data. `surfacesConflict()` would throw on
              // it; the query has to answer instead.
              {
                id: 'census:ghost',
                date: DATE,
                surfaceId: GHOST,
                startMinutes: 10 * 60,
                endMinutes: 10 * 60 + 55,
                format: '7v7',
                teamIds: ['census-ghost'],
                personIds: [],
              },
            ],
          }
        ),
    },
  ],
  'availability/closures.js': [
    {
      label: 'checkClosures()',
      expectCode: FACILITY_REASON.SURFACE_UNKNOWN,
      run: () =>
        checkClosures(graph, closureSet, {
          id: 'ghost',
          surfaceId: GHOST,
          date: DATE,
          startMinutes: 600,
          endMinutes: 660,
        }),
    },
    {
      label: 'findClosureBreaches()',
      expectCode: FACILITY_REASON.SURFACE_UNKNOWN,
      run: () =>
        findClosureBreaches(graph, closureSet, [
          { id: 'ghost', surfaceId: GHOST, date: DATE, startMinutes: 600, endMinutes: 660 },
          { id: 'real', surfaceId: REAL, date: DATE, startMinutes: 600, endMinutes: 660 },
        ]),
    },
  ],
  'availability/kickoff.js': [
    {
      label: 'checkKickoffAvailability()',
      expectCode: FACILITY_REASON.SURFACE_UNKNOWN,
      run: () =>
        checkKickoffAvailability(graph, table, calendar, {
          surfaceId: GHOST,
          date: DATE,
          kickoffMinutes: 600,
          format: '11v11',
        }),
    },
    {
      label: 'latestLegalKickoff()',
      expectCode: FACILITY_REASON.SURFACE_UNKNOWN,
      run: () =>
        latestLegalKickoff(graph, table, calendar, {
          surfaceId: GHOST,
          date: DATE,
          format: '11v11',
          notAfterMinutes: 1200,
        }),
    },
  ],
  'timing/warmup.js': [
    {
      label: 'warmupWindowAvailability()',
      expectCode: FACILITY_REASON.SURFACE_UNKNOWN,
      run: () =>
        warmupWindowAvailability(
          graph,
          table,
          { surfaceId: GHOST, date: DATE, kickoffMinutes: 600, format: '11v11', warmupMinutes: 30 },
          { existingBookings: bookingsOnDate() }
        ),
    },
    {
      label: 'earliestKickoffWithWarmup()',
      expectCode: FACILITY_REASON.SURFACE_UNKNOWN,
      run: () =>
        earliestKickoffWithWarmup(
          graph,
          table,
          {
            surfaceId: GHOST,
            date: DATE,
            format: '11v11',
            warmupMinutes: 30,
            notBeforeMinutes: 480,
          },
          { existingBookings: bookingsOnDate() }
        ),
    },
  ],
  'ruleEngine/rules.js': [
    {
      label: 'runRuleEngine() over a schedule holding one such game',
      expectCode: FACILITY_REASON.SURFACE_UNKNOWN,
      run: () => runRuleEngine(poisonedSchedule(), { registry, resources }),
    },
  ],
  'reserve/conditions.js': [
    {
      label: 'conditionForSurface()',
      expectCode: null,
      reason:
        'it answers "this surface carries no condition" with `null`, which for unknown ground would be a fabricated unconditional. The pipeline never reaches that: `buildReserveCapacityReport()` generates no slot on ground `checkKickoffAvailability()` rejects, and the next driver asserts that rejection is `SURFACE_UNKNOWN` on the row itself.',
      run: () => conditionForSurface(graph, GHOST),
    },
    {
      label: 'evaluateSlotCondition() watching ground the graph does not hold',
      expectCode: null,
      reason:
        'the condition is data the caller supplies and the evaluation compares booking ids and clocks, never the graph; there is no lookup in it to fail.',
      run: () =>
        evaluateSlotCondition(
          graph,
          {
            id: 'probe',
            date: DATE,
            startMinutes: 600,
            endMinutes: 690,
            condition: {
              kind: 'surface-idle',
              surfaceIds: [GHOST],
              derivedFrom: 'tests/unknownSurfaceDiscipline.test.js',
              reason: 'constructed: ground the graph does not hold, named as a condition',
            },
          },
          []
        ),
    },
    {
      label: 'buildReserveCapacityReport() over such a surface',
      expectCode: null,
      reason:
        'the report records the rejection on the row as `blockingCodes`, which is a list of code strings rather than a list of findings, so it is asserted by name in its own case below rather than by the generic code harvest.',
      run: () =>
        buildReserveCapacityReport(
          { graph, table, calendar, registry },
          {
            name: 'ground the graph does not hold',
            format: '11v11',
            dates: [DATE],
            surfaceIds: [GHOST],
            cadenceMinutes: 120,
            earliestKickoffMinutes: 540,
            requirement: { slots: 1, label: 'probe', source: 'probe' },
            reservedSlots: [],
            bookings: [],
          }
        ),
    },
  ],
};

/**
 * Modules whose behaviour on unknown ground is already pinned by a named test
 * elsewhere. The title is read back out of that file, so deleting or renaming it
 * fails here.
 *
 * @type {Record<string, { file: string, title: string }>}
 */
const REPORTS_ELSEWHERE = {
  'externalImport/impact.js': {
    file: 'tests/externalFixtureImport.test.js',
    title: 'reports the unknown surface and finishes, rather than throwing out of the analysis',
  },
  'externalImport/avoidWindows.js': {
    file: 'tests/externalFixtureImport.test.js',
    title: '7 — a scope surface the facility graph does not have is reported, not thrown',
  },
};

/**
 * Modules that have decided to throw, and are consistent about it. Each driver
 * asserts the throw and that its message names the surface, so "it throws" stays
 * a pinned decision rather than an accident nobody looked at.
 *
 * @type {Record<string, { reason: string, run: () => unknown }>}
 */
const DECIDED_TO_THROW = {
  'placement/replaceGames.js': {
    reason:
      'a bounded single-venue harness that validates its stated inputs by throwing: the line above this lookup throws when a candidate surface belongs to another venue, and the module refuses a `freeze` argument outright rather than accepting one it cannot honour. A candidate surface list is a stated input, not user data, and every throw carries an operator-readable message.',
    run: () =>
      replaceGamesUnderRegistry(
        { graph, table, calendar, registry },
        {
          date: DATE,
          games: [{ id: 'probe-game', format: '11v11', label: 'a v b' }],
          fixedBookings: [],
          candidateSurfaceIds: [GHOST],
          candidateKickoffMinutes: [600],
        }
      ),
  },
  'placement/adapters/season2026Placement.js': {
    reason:
      'the corpus adapter for that same harness, which throws on four separate malformed-input cases in a row — no rows on the date, no rows of the format, rows spanning two venues, and this one. Reporting one of the four and throwing on three would be the inconsistency this file exists to catch.',
    run: () =>
      toSeason2026PlacementInput(graph, [{ ...ghostRow() }], { date: DATE, format: '11v11' }),
  },
};

/**
 * Modules whose *own* lookup throws while their public answer reports. The
 * driver pins both halves: a module that quietly converted one to the other
 * would be changing a decision without saying so.
 *
 * @type {Record<string, { reason: string, raw: () => unknown, publicAnswer: () => unknown, expectCode: string }>}
 */
const INTERNAL_LOOKUP = {
  'availability/calendar.js': {
    reason:
      "`resolveLighting()` is the calendar's own lineage walk and throws, and both of the module's public entry points guard the same id with `getSurface()` and report `SURFACE_UNKNOWN` before they reach it. The split is deliberate: the low-level walk is reached only after the guard, and a caller reaching for it directly is asking a question about ground that does not exist.",
    raw: () => resolveLighting(graph, calendar, GHOST),
    publicAnswer: () =>
      checkKickoffAvailability(graph, table, calendar, {
        surfaceId: GHOST,
        date: DATE,
        kickoffMinutes: 600,
        format: '11v11',
      }),
    expectCode: FACILITY_REASON.SURFACE_UNKNOWN,
  },
};

/**
 * Modules that pass only ids they enumerated from the graph, so the lookup
 * cannot fail.
 *
 * @type {Record<string, string>}
 */
const GRAPH_DERIVED_IDS = {
  'scenario/relocation.js':
    'the only id it hands to `checkSizeEligibility()` is `surface.id` from `Object.values(graph.surfaces)`, which it is iterating at the time; there is no caller-supplied surface id anywhere in `replacementSurfacesFor()`. The assertion below runs it over the whole corpus for every format the rank table knows.',
};

/* -------------------------------------------------------------------------- */
/* Fixtures the drivers need                                                   */
/* -------------------------------------------------------------------------- */

/** The corpus's own bookings on `DATE`, so a comparison loop has work to do. */
function bookingsOnDate() {
  return schedule.games
    .filter((game) => game.date === DATE)
    .map((game) => ({
      id: game.id,
      surfaceId: game.surfaceId,
      date: game.date,
      startMinutes: game.startMinutes,
      endMinutes: game.endMinutes,
      format: game.format,
      label: game.id,
    }));
}

/**
 * The corpus with one concurrent game moved onto ground the graph does not hold,
 * its surface universe moved with it exactly as `toSeason2026Schedule()` would.
 */
function poisonedSchedule() {
  const concurrent = (a, b) =>
    a.date === b.date &&
    a.endMinutes !== null &&
    b.endMinutes !== null &&
    a.startMinutes < b.endMinutes &&
    b.startMinutes < a.endMinutes;
  const victim = schedule.games.find((game) =>
    schedule.games.some(
      (other) => other.id !== game.id && other.venueId === game.venueId && concurrent(game, other)
    )
  );
  return {
    ...schedule,
    games: schedule.games.map((game) =>
      game.id === /** @type {Object} */ (victim).id ? { ...game, surfaceId: GHOST } : game
    ),
    surfaceUniverse: [...new Set([...schedule.surfaceUniverse, GHOST])].sort(),
  };
}

/** One parsed corpus row pointed at a field the geometry does not carry. */
function ghostRow() {
  const row = season.combinedGames.find((game) => game.date === DATE && game.format === '11v11');
  return { ...(row ?? {}), field: 'Pitch 99', format: '11v11', date: DATE };
}

/* -------------------------------------------------------------------------- */
/* The guard                                                                   */
/* -------------------------------------------------------------------------- */

describe('unknown-surface discipline :: the census', () => {
  it('finds the modules that can reach a throwing facility lookup', () => {
    // The meta-assertion this whole file rests on. A walk that found nothing, or
    // a `THROWING_LOOKUPS` list nothing matched, would make every classification
    // below vacuously satisfied.
    expect(Object.keys(CENSUS).length).toBeGreaterThan(5);
    // The three modules the review found a defect in are in it, so the census
    // demonstrably covers the shape it was built for.
    expect(CENSUS['ruleEngine/rules.js']).toContain('surfacesConflict');
    expect(CENSUS['timing/warmup.js']).toContain('surfacesConflict');
    expect(CENSUS['externalImport/impact.js']).toContain('surfacesConflict');
    // …and `facility/` itself is excluded, or the module that owns the lookups
    // would have to classify itself.
    expect(Object.keys(CENSUS).some((file) => file.startsWith('facility/'))).toBe(false);
  });

  it('classifies every module it finds, and classifies nothing it does not', () => {
    const classified = {
      ...REPORTS,
      ...REPORTS_ELSEWHERE,
      ...DECIDED_TO_THROW,
      ...INTERNAL_LOOKUP,
      ...GRAPH_DERIVED_IDS,
    };
    const unclassified = Object.keys(CENSUS).filter((file) => !(file in classified));
    expect(
      unclassified,
      'these modules import a throwing facility lookup and are classified nowhere in tests/unknownSurfaceDiscipline.test.js; say which of the four they are'
    ).toEqual([]);
    const stale = Object.keys(classified).filter((file) => !(file in CENSUS));
    expect(
      stale,
      'these modules are classified here and no longer import a throwing facility lookup'
    ).toEqual([]);
    // Every category is populated: an empty one would be a category nobody is
    // being held to.
    /** @type {Array<[string, Record<string, unknown>]>} */
    const groups = [
      ['REPORTS', REPORTS],
      ['REPORTS_ELSEWHERE', REPORTS_ELSEWHERE],
      ['DECIDED_TO_THROW', DECIDED_TO_THROW],
      ['INTERNAL_LOOKUP', INTERNAL_LOOKUP],
      ['GRAPH_DERIVED_IDS', GRAPH_DERIVED_IDS],
    ];
    for (const [name, group] of groups) {
      expect(Object.keys(group).length, name).toBeGreaterThan(0);
    }
  });

  it('is asking about ground the graph really does not hold', () => {
    expect(graph.surfaceIds).toContain(REAL);
    expect(graph.surfaceIds).not.toContain(GHOST);
    expect(bookingsOnDate().length).toBeGreaterThan(5);
  });
});

describe('unknown-surface discipline :: modules that report', () => {
  for (const [file, drivers] of Object.entries(REPORTS)) {
    for (const driver of drivers) {
      it(`${file} — ${driver.label} answers instead of throwing`, () => {
        let threw = null;
        let answer = null;
        try {
          answer = driver.run();
        } catch (error) {
          threw = error;
        }
        expect(
          threw && /** @type {Error} */ (threw).message,
          `${file} threw on an id that came from data`
        ).toBeNull();
        if (driver.expectCode === null) {
          // Stated exemptions carry a reason, and a one-word reason is not one.
          expect(String(driver.reason ?? '').length).toBeGreaterThan(60);
          return;
        }
        expect(codesIn(answer), `${file} — ${driver.label}`).toContain(driver.expectCode);
      });
    }
  }

  it('the rule engine keeps running every rule while it reports', () => {
    // The half that made round 2's finding 5 the worst of the five: not that it
    // threw, but that the throw silenced every other verdict in the run.
    const run = runRuleEngine(poisonedSchedule(), { registry, resources });
    expect(run.meta.rulesThrew).toBe(0);
    expect(run.meta.rulesRun).toBe(run.meta.rulesRegistered);
  });

  it('rejects a driver whose entry point throws', () => {
    // The positive control. The predicate the drivers above are judged by is run
    // against a call that does throw, so a passing driver means something.
    const judge = (run) => {
      try {
        return { threw: null, codes: codesIn(run()) };
      } catch (error) {
        return { threw: error, codes: [] };
      }
    };
    const throwing = judge(() => {
      throw new Error(`facility: unknown surface "${GHOST}"`);
    });
    expect(throwing.threw).not.toBeNull();
    const silent = judge(() => ({ status: 'allowed', findings: [] }));
    expect(silent.threw).toBeNull();
    expect(silent.codes).not.toContain(FACILITY_REASON.SURFACE_UNKNOWN);
  });
});

describe('unknown-surface discipline :: modules pinned elsewhere', () => {
  for (const [file, where] of Object.entries(REPORTS_ELSEWHERE)) {
    it(`${file} — ${where.file} still holds the test that pins it`, () => {
      const source = readFileSync(path.join(ROOT, where.file), 'utf8');
      expect(source, `${where.file} no longer contains "${where.title}"`).toContain(where.title);
    });
  }
});

describe('unknown-surface discipline :: modules that have decided to throw', () => {
  for (const [file, entry] of Object.entries(DECIDED_TO_THROW)) {
    it(`${file} — throws, on purpose, and names the ground`, () => {
      // Stated decisions carry a reason, and the reason is read back so it
      // cannot decay into an empty string.
      expect(entry.reason.length).toBeGreaterThan(80);
      let threw = null;
      try {
        entry.run();
      } catch (error) {
        threw = error;
      }
      expect(threw, `${file} no longer throws; move it to REPORTS`).not.toBeNull();
      expect(/** @type {Error} */ (threw).message).toMatch(/surface|Pitch|venue/i);
    });
  }
});

describe('unknown-surface discipline :: modules passing only graph-derived ids', () => {
  for (const [file, reason] of Object.entries(GRAPH_DERIVED_IDS)) {
    it(`${file} — states why the lookup cannot fail`, () => {
      expect(reason.length).toBeGreaterThan(80);
    });
  }

  it('scenario/relocation.js runs clean over the whole corpus, for every ranked format', () => {
    // The claim made behavioural rather than left as prose: every format the
    // rank table knows, over every surface the graph holds.
    const formats = ['Minis', '4v4', '5v5', '7v7', '9v9', '11v11'];
    for (const format of formats) {
      expect(() => replacementSurfacesFor(graph, { format })).not.toThrow();
    }
    // Non-vacuous: it really did look at the whole graph, and the expected set
    // is **stated** rather than filtered with the production predicate. (It was
    // filtered with it, in the predicate's own words, until round 2 -- so a
    // change to the rule moved both sides of the equality at once.) This is the
    // *game* graph: its only parents are Alder Pitch 1 and Pitch 4, whose halves
    // are themselves 9v9 ground, so relocation offers the halves and not the
    // parents.
    const OFFERABLE_PARENT_IDS = [];
    const offerable = (id) =>
      graph.surfaces[id].childIds.length === 0 || OFFERABLE_PARENT_IDS.includes(id);
    const bigEnough = (id) =>
      graph.surfaces[id].sizes.some((size) => ['9v9', '11v11'].includes(size));
    const expected = graph.surfaceIds.filter((id) => offerable(id) && bigEnough(id)).sort();
    expect(replacementSurfacesFor(graph, { format: '9v9', maxGradesAbove: 9 })).toEqual(expected);
    // ... and the ground the statement withholds is real ground, so "leaves
    // plus a named list" is a restriction and not a synonym for "everything".
    const parents = graph.surfaceIds.filter((id) => graph.surfaces[id].childIds.length > 0);
    expect(parents.sort()).toEqual(['alder-park/pitch-1', 'alder-park/pitch-4']);
    for (const id of parents) {
      expect(bigEnough(id), id).toBe(true);
      expect(expected, id).not.toContain(id);
    }
    expect(expected.length).toBeGreaterThan(5);
  });
});

describe('unknown-surface discipline :: modules whose own lookup throws', () => {
  for (const [file, entry] of Object.entries(INTERNAL_LOOKUP)) {
    it(`${file} — the raw lookup throws and the public answer reports`, () => {
      expect(entry.reason.length).toBeGreaterThan(80);
      let threw = null;
      try {
        entry.raw();
      } catch (error) {
        threw = error;
      }
      expect(threw, `${file}'s raw lookup no longer throws`).not.toBeNull();
      // …and the public entry point, on the very same id, answers.
      expect(codesIn(entry.publicAnswer()), file).toContain(entry.expectCode);
    });
  }
});

describe('unknown-surface discipline :: a capacity report over unknown ground', () => {
  it('records the rejection on the row rather than counting slots on it', () => {
    const report = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      {
        name: 'ground the graph does not hold',
        format: '11v11',
        dates: [DATE],
        surfaceIds: [GHOST],
        cadenceMinutes: 120,
        earliestKickoffMinutes: 540,
        requirement: { slots: 1, label: 'probe', source: 'probe' },
        reservedSlots: [],
        bookings: [],
      }
    );
    const row = report.dates[0].bySurface[0];
    expect(row.surfaceId).toBe(GHOST);
    expect(row.blockingCodes).toContain(FACILITY_REASON.SURFACE_UNKNOWN);
    // No slot is generated on it, so `conditionForSurface()`'s `null` — which
    // would otherwise read as "unconditional" — is never consulted about ground
    // the graph does not hold.
    expect(row.kickoffMinutes).toEqual([]);
    expect(row.slots).toBe(0);
    expect(row.conditional).toBe(false);
  });

  it('counts slots on the same date for ground the graph does hold', () => {
    // The negative control: a report that produced nothing for every surface
    // would pass the assertion above without meaning anything.
    const report = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      {
        name: 'real ground',
        format: '11v11',
        dates: [DATE],
        surfaceIds: [REAL],
        cadenceMinutes: 120,
        earliestKickoffMinutes: 540,
        requirement: { slots: 1, label: 'probe', source: 'probe' },
        reservedSlots: [],
        bookings: [],
      }
    );
    const row = report.dates[0].bySurface[0];
    expect(row.slots).toBeGreaterThan(0);
    expect(row.blockingCodes).not.toContain(FACILITY_REASON.SURFACE_UNKNOWN);
  });
});
