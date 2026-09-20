/**
 * Move-request analysis — Prompt 8.7.
 *
 * > *"A parent asked to move this into that window. What can the club offer?"*
 *
 * Six properties are what this file is for, and each has a control that is
 * **constructed and shown to bite** rather than asserted:
 *
 * 1. **Read-only means read-only.** Every engine, the schedule, the context and
 *    the resolve state are deep-frozen and every query runs against them. The
 *    freeze is proved to bite before it is relied on.
 * 2. **The class has one producer.** `classifyMoveRequest()` is driven directly
 *    through all four arms, and a source scan proves no other line in
 *    `packages/core` assigns a `MOVE_REQUEST_CLASS` member to anything. The scan
 *    is shown matching something first.
 * 3. **A swap is two-sided, and the lift is what makes it one.** The positive
 *    control is `canGameMove()` refusing the very slot this module admits a swap
 *    into — because that query cannot vacate the counterparty and this one can.
 * 4. **The two acceptance cases, both as tests.** Every feasible slot held by
 *    holders who all rely on theirs for the same objective → `zero_sum_only`
 *    naming the count; free end-of-day slots at no counterparty cost →
 *    `vacancy_available`. Each is paired with the one-line change that moves it
 *    to the neighbouring class, so neither passes by construction.
 * 5. **Nothing is derived from the set a break would corrupt.** The holder index
 *    is enumerated from `schedule.games` and the caller's practices; the
 *    candidate grid from `buildReserveCapacityReport()` run independently here.
 *    Both universes are compared against the answer rather than read out of it.
 * 6. **`unknown` never collapses.** An undecidable occupant is never a vacancy,
 *    and a window that offers nothing while something went unjudged says so.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAttributionContext } from '@squadlogic/core/attribution/index.js';
import { buildAvailabilityCalendarFromSeason2026 } from '@squadlogic/core/availability/index.js';
import {
  CONSTRAINT_STATUS,
  buildSeason2026ConstraintRegistry,
} from '@squadlogic/core/constraints/index.js';
import {
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
} from '@squadlogic/core/facility/index.js';
import {
  loadCoachRoster,
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import { buildSeason2026CoachRoster } from '@squadlogic/core/people/index.js';
import { buildReserveCapacityReport, capacitySlotId } from '@squadlogic/core/reserve/index.js';
import { runRuleEngine, toSeason2026Schedule } from '@squadlogic/core/ruleEngine/index.js';
import {
  buildFormatTimingTableFromSeason2026,
  formatTimingOrUnknown,
} from '@squadlogic/core/timing/index.js';
import { travelConstraintIdByCode } from '@squadlogic/core/waivers/index.js';

import {
  FEASIBILITY_QUESTION,
  FEASIBILITY_REASON,
  FEASIBILITY_REASON_SEVERITY,
  FEASIBILITY_SEVERITY,
  FEASIBILITY_STATUS,
  FEASIBILITY_TIGHTNESS,
  FEASIBILITY_VERDICT,
  MOVE_REQUEST_CLASS,
  MOVE_REQUEST_CLASS_ORDER,
  MOVE_REQUEST_ENTITY,
  MoveRequestQuerySchema,
  analyseMoveRequest,
  canGameMove,
  classifyMoveRequest,
  feasibilitySeverityOf,
} from '@squadlogic/core/feasibility/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus and engines, loaded once                                             */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const graph = buildFacilityGraphFromSeason2026(loadFacilityGeometry());
const table = buildFormatTimingTableFromSeason2026(loadGameFormats());
const sunsets = loadSunsets();
/** Derived from the corpus rather than typed in, so a re-dated fixture moves it. */
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const permits = loadFacilityPermits({ seasonYear: SEASON_YEAR });
const calendar = buildAvailabilityCalendarFromSeason2026(permits, sunsets);
const registry = buildSeason2026ConstraintRegistry();
const venueComplexes = buildSeason2026VenueComplexMap();
const schedule = toSeason2026Schedule(season);
const roster = buildSeason2026CoachRoster(loadCoachRoster());
const verification = runRuleEngine(schedule, {
  registry,
  resources: { graph, timingTable: table, calendar, venueComplexes },
});

/**
 * Freeze an object graph in place, following plain objects and arrays only.
 *
 * @template T
 * @param {T} value
 * @param {Set<unknown>} [seen]
 * @returns {T}
 */
function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return value;
}

const context = deepFreeze(
  buildAttributionContext({
    graph,
    table,
    calendar,
    registry,
    schedule,
    verification,
    venueComplexes,
    roster,
  })
);
deepFreeze(graph);
deepFreeze(table);
deepFreeze(calendar);
deepFreeze(registry);
deepFreeze(schedule);
deepFreeze(venueComplexes);

/* -- the positions this file is about, all derived from the corpus --------- */

/** Clean from 08:00 to 16:00, `PERMIT_MARGIN_TIGHT` at 17:00, refused from 18:00. */
const BROOKSIDE_1 = 'brookside-park/upper-1';
const AUG_22 = '2026-08-22';
/** The blacked-out permit record 7.1's own tests already lean on. */
const SUMMIT = 'summit-hs/stadium';
const BLACKED_OUT = '2026-09-19';
/** 7v7 occupancy, from `game_formats.csv` and never typed here. */
const SEVEN_A_SIDE_OCCUPANCY = formatTimingOrUnknown(table, '7v7').occupancyMinutes.scheduled;

/**
 * One practice holding, spelled once.
 *
 * @param {string} id
 * @param {number} startMinutes
 * @param {Partial<Record<string, unknown>>} [over]
 * @returns {Record<string, unknown>}
 */
function practiceAt(id, startMinutes, over = {}) {
  return {
    id,
    date: AUG_22,
    surfaceId: BROOKSIDE_1,
    startMinutes,
    endMinutes: startMinutes + SEVEN_A_SIDE_OCCUPANCY,
    format: '7v7',
    teamIds: [`team-for-${id}`],
    personIds: [],
    label: id,
    ...over,
  };
}

/** The subject sits at 17:00, the one kickoff this ground admits and calls tight. */
const TIGHT_KICKOFF = 17 * 60;

/* -------------------------------------------------------------------------- */
/* Guard block — runs before anything behavioural                              */
/* -------------------------------------------------------------------------- */

describe('move request :: corpus guard', () => {
  it('is asked of the whole published season, not a slice of it', () => {
    expect(schedule.games.length).toBe(679);
    expect(schedule.commitments.length).toBeGreaterThan(0);
    expect(context.verification).not.toBeNull();
    expect(context.travel).not.toBeNull();
    expect(SEVEN_A_SIDE_OCCUPANCY).toBe(55);
  });

  it('stands on the two positions every constructed case below depends on', () => {
    // Without these, the zero-sum case would be a statement about whatever the
    // permit happens to allow rather than about a tight kickoff and clean ones.
    const clean = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      {
        name: 'guard',
        format: '7v7',
        dates: [AUG_22],
        surfaceIds: [BROOKSIDE_1],
        cadenceMinutes: 60,
        earliestKickoffMinutes: 8 * 60,
        latestKickoffMinutes: 19 * 60,
        requirement: { slots: 1, label: 'guard', source: 'guard' },
        reservedSlots: [],
        bookings: [],
      }
    );
    const offered = clean.dates[0].bySurface[0].kickoffMinutes;
    expect(offered).toContain(8 * 60);
    expect(offered).toContain(9 * 60);
    expect(offered).toContain(TIGHT_KICKOFF);
    // …and the ground refuses the hour after, which is why 17:00 is the last
    // position and the tight one.
    expect(offered).not.toContain(18 * 60);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 1 — read-only means read-only                                          */
/* -------------------------------------------------------------------------- */

describe('move request :: read-only', () => {
  it('froze the world hard enough for the next test to mean something', () => {
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(context.state)).toBe(true);
    expect(() => {
      /** @type {any} */ (schedule.games[0]).startMinutes = 1;
    }).toThrow(TypeError);
  });

  it('answers without writing anywhere in the world it was handed', () => {
    const subject = schedule.games.find((game) => game.format === '7v7');
    const before = JSON.stringify({
      game: schedule.games[0],
      games: Object.keys(context.state.games).length,
      commitments: schedule.commitments.length,
    });
    expect(() =>
      analyseMoveRequest(
        context,
        {
          entityKind: MOVE_REQUEST_ENTITY.GAME,
          entityId: subject.id,
          dates: [subject.date],
          surfaceIds: [subject.surfaceId],
          cadenceMinutes: 60,
          earliestKickoffMinutes: 9 * 60,
          latestKickoffMinutes: 17 * 60,
        },
        { venueComplexes }
      )
    ).not.toThrow();
    expect(
      JSON.stringify({
        game: schedule.games[0],
        games: Object.keys(context.state.games).length,
        commitments: schedule.commitments.length,
      })
    ).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 2 — the class has exactly one producer                                 */
/* -------------------------------------------------------------------------- */

describe('move request :: the classifier is the only producer of a class', () => {
  it('produces each of the four classes from constructed parts', () => {
    const costly = { free: false };
    const free = { free: true };
    expect(classifyMoveRequest({ vacancies: [{}], swaps: [] }).classification).toBe(
      MOVE_REQUEST_CLASS.VACANCY_AVAILABLE
    );
    // A vacancy beats every swap, free or not — the first test of the three.
    expect(classifyMoveRequest({ vacancies: [{}], swaps: [costly, free] }).classification).toBe(
      MOVE_REQUEST_CLASS.VACANCY_AVAILABLE
    );
    expect(classifyMoveRequest({ vacancies: [], swaps: [costly, free] }).classification).toBe(
      MOVE_REQUEST_CLASS.FREE_SWAP_AVAILABLE
    );
    expect(classifyMoveRequest({ vacancies: [], swaps: [costly, costly] }).classification).toBe(
      MOVE_REQUEST_CLASS.ZERO_SUM_ONLY
    );
    expect(classifyMoveRequest({ vacancies: [], swaps: [] }).classification).toBe(
      MOVE_REQUEST_CLASS.INFEASIBLE
    );
    // Every declared class is reachable from this one function — a class nothing
    // can produce is a token in a docstring.
    expect(new Set(MOVE_REQUEST_CLASS_ORDER).size).toBe(4);
  });

  it('refuses a swap whose price is not a boolean, and a part that is not a list', () => {
    // The collapse this guard exists for: `if (swap.free)` is `false` for
    // `undefined`, which silently reads "this swap costs somebody something".
    // Cast at the call, because the point of these three is exactly the shapes
    // the type says cannot arrive — and they do, from JSON, from a mock, and
    // from a future field rename.
    const ask = /** @type {(parts: unknown) => unknown} */ (
      /** @type {unknown} */ (classifyMoveRequest)
    );
    expect(() => ask({ vacancies: [], swaps: [{}] })).toThrow(/"free"/);
    expect(() => ask({ vacancies: [], swaps: [{ free: null }] })).toThrow(/"free"/);
    expect(() => ask({ vacancies: null, swaps: [] })).toThrow(/vacancies/);
  });

  it('carries its own provenance finding, with the counts the class came from', () => {
    const produced = classifyMoveRequest({
      vacancies: [],
      swaps: [{ free: false }, { free: false }, { free: true }],
    });
    expect(produced.classification).toBe(MOVE_REQUEST_CLASS.FREE_SWAP_AVAILABLE);
    expect(produced.finding.code).toBe(FEASIBILITY_REASON.MOVE_REQUEST_CLASS_REACHED);
    expect(produced.finding.details).toMatchObject({
      classification: MOVE_REQUEST_CLASS.FREE_SWAP_AVAILABLE,
      vacancies: 0,
      swaps: 3,
      freeSwaps: 1,
      costlySwaps: 2,
    });
  });

  it('is the only line in packages/core that assigns a class member', () => {
    // **The single-producer claim, made structural.** A caller that rebuilt the
    // class from `vacancies.length` would be plausible and wrong, and no
    // behavioural test would notice until the two disagreed.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const core = path.join(root, 'packages', 'core', 'src');
    /** @param {string} dir @param {string[]} out */
    const walk = (dir, out) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (entry.endsWith('.js')) out.push(full);
      }
      return out;
    };
    /** @type {Array<{ file: string, line: string }>} */
    const uses = [];
    /** @type {Array<{ file: string, line: string }>} */
    const assignments = [];
    for (const file of walk(core, [])) {
      const relative = path.relative(core, file);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((raw) => {
          const line = raw.trim();
          if (/MOVE_REQUEST_CLASS\./.test(line)) uses.push({ file: relative, line });
          // An assignment, never a comparison: `=[^=]` excludes `===`.
          if (/\bclassification\s*=[^=]/.test(line)) assignments.push({ file: relative, line });
        });
    }
    // Meta-assertion: a scan that matched nothing would make both checks below
    // pass over an empty set. Both patterns are shown matching first, and the
    // wider one matches lines this module does not own — `fairness/` has two
    // locals of the same name — which is what makes the narrowing below real
    // rather than a filter over a set of one.
    expect(uses.length).toBeGreaterThanOrEqual(4);
    expect(assignments.length).toBeGreaterThanOrEqual(3);
    expect(
      assignments.filter((entry) => entry.file !== 'feasibility/moveRequest.js').length
    ).toBeGreaterThan(0);
    expect([...new Set(uses.map((use) => use.file))]).toEqual([
      'feasibility/moveRequest.js',
      'feasibility/reasonCodes.js',
    ]);
    // Exactly one line in the package assigns a classification **onto an
    // object**, and it assigns the classifier's own answer. A caller rebuilding
    // the class from `vacancies.length` would be plausible, wrong, and
    // invisible to every behavioural test until the two copies disagreed.
    expect(assignments.filter((entry) => /\.classification\s*=[^=]/.test(entry.line))).toEqual([
      {
        file: 'feasibility/moveRequest.js',
        line: 'answer.classification = classified.classification;',
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance 1 — every feasible slot held, all for the same objective         */
/* -------------------------------------------------------------------------- */

/**
 * The zero-sum world: the subject at the one tight kickoff this ground has, and
 * every earlier position in the window held by somebody who is clean there and
 * would not be at 17:00.
 *
 * @param {ReadonlyArray<number>} holderKickoffs
 * @returns {Array<Record<string, unknown>>}
 */
function zeroSumPractices(holderKickoffs) {
  return [
    practiceAt('practice:subject', TIGHT_KICKOFF),
    ...holderKickoffs.map((kickoff, index) => practiceAt(`practice:holder-${index}`, kickoff)),
  ];
}

/**
 * @param {ReadonlyArray<Record<string, unknown>>} practices
 * @param {{ earliest: number, latest: number }} window
 * @returns {import('@squadlogic/core/feasibility/types.js').MoveRequestAnalysis}
 */
function askSubject(practices, window) {
  return analyseMoveRequest(
    context,
    {
      entityKind: MOVE_REQUEST_ENTITY.PRACTICE,
      entityId: 'practice:subject',
      dates: [AUG_22],
      surfaceIds: [BROOKSIDE_1],
      cadenceMinutes: 60,
      earliestKickoffMinutes: window.earliest,
      latestKickoffMinutes: window.latest,
    },
    { venueComplexes, practices }
  );
}

describe('move request :: zero_sum_only, and the count it names', () => {
  const answer = askSubject(zeroSumPractices([8 * 60, 9 * 60]), {
    earliest: 8 * 60,
    latest: 9 * 60,
  });

  it('classifies zero_sum_only when every feasible slot is held', () => {
    expect(answer.classification).toBe(MOVE_REQUEST_CLASS.ZERO_SUM_ONLY);
    expect(answer.counts.candidatesOnGrid).toBe(2);
    expect(answer.counts.feasible).toBe(2);
    expect(answer.counts.vacancies).toBe(0);
    expect(answer.counts.swapsAdmissible).toBe(2);
    expect(answer.counts.swapsFree).toBe(0);
    expect(answer.counts.swapsCostly).toBe(2);
  });

  it('names the objective every holder relies on, and how many of them there are', () => {
    // The acceptance sentence, as an assertion: one objective, and the count.
    expect(answer.zeroSum.holderCount).toBe(2);
    expect(answer.zeroSum.objectives).toHaveLength(1);
    const [objective] = answer.zeroSum.objectives;
    expect(objective.holderCount).toBe(2);
    expect(objective.holderIds).toEqual(['practice:holder-0', 'practice:holder-1']);
    // What they lose is the permit's comfort margin, which they have at 08:00
    // and 09:00 and would not have at 17:00. The code is the availability
    // layer's own; no registry constraint claims it, which the answer says
    // rather than reporting an empty cost.
    expect(objective.codes).toEqual(['PERMIT_MARGIN_TIGHT']);
    expect(objective.objective).toBe('code:PERMIT_MARGIN_TIGHT');
    expect(
      answer.findings.filter(
        (finding) => finding.code === FEASIBILITY_REASON.MOVE_REQUEST_COST_UNCLAIMED
      )
    ).toHaveLength(2);
  });

  it('prices each holder against its own standing position, not against nothing', () => {
    for (const swap of answer.swaps) {
      expect(swap.free).toBe(false);
      expect(swap.cost.codes).toEqual(['PERMIT_MARGIN_TIGHT']);
      // Both legs were judged, and both are legal — a costly swap is still an
      // admissible one, which is the whole difference from `infeasible`.
      expect(swap.subjectLeg.verdict).toBe(FEASIBILITY_VERDICT.FEASIBLE);
      expect(swap.counterpartyLeg.verdict).toBe(FEASIBILITY_VERDICT.FEASIBLE);
      expect(swap.counterpartyLeg.tight).toBe(FEASIBILITY_TIGHTNESS.TIGHT);
      expect(swap.counterpartyKind).toBe(MOVE_REQUEST_ENTITY.PRACTICE);
    }
    expect(answer.meta.swapsConsidered).toBe(2);
    expect(answer.meta.swapLegsJudged).toBe(4);
  });

  it('**the break**: move the subject off the tight kickoff and the class changes', () => {
    // The control. If the holders were priced against nothing rather than
    // against their own positions, this would stay `zero_sum_only` — the
    // exchange still moves them — and the assertion above would be unfalsifiable.
    // 16:00 is the last kickoff of this ground that is both free of the four
    // standing fixtures and clean, so the exchange costs the holders nothing.
    const cheapSubject = zeroSumPractices([8 * 60, 9 * 60]).map((practice) =>
      practice.id === 'practice:subject' ? practiceAt('practice:subject', 16 * 60) : practice
    );
    const relaxed = askSubject(cheapSubject, { earliest: 8 * 60, latest: 9 * 60 });
    expect(relaxed.classification).toBe(MOVE_REQUEST_CLASS.FREE_SWAP_AVAILABLE);
    expect(relaxed.counts.swapsFree).toBe(2);
    expect(relaxed.zeroSum.holderCount).toBe(0);
    expect(relaxed.zeroSum.objectives).toEqual([]);
  });

  it('charges a counterparty nothing for a compromise it already carries', () => {
    // **The `held` comparison, pinned.** Alder Pitch 2 is unlined for 7v7, so
    // `LINING_MISMATCH` speaks at every kickoff it admits — the counterparty
    // has it where it stands and would have it where the subject stands. A
    // cost measured against nothing rather than against the counterparty's own
    // position would call that exchange zero-sum, which is the club telling a
    // family it is giving something up when it is not.
    const surfaceId = 'alder-park/pitch-2';
    const holding = (id, startMinutes) => ({
      id,
      date: AUG_22,
      surfaceId,
      startMinutes,
      endMinutes: startMinutes + SEVEN_A_SIDE_OCCUPANCY,
      format: '7v7',
      teamIds: [`team-for-${id}`],
      personIds: [],
      label: id,
    });
    const answer = analyseMoveRequest(
      context,
      {
        entityKind: MOVE_REQUEST_ENTITY.PRACTICE,
        entityId: 'practice:subject',
        dates: [AUG_22],
        surfaceIds: [surfaceId],
        cadenceMinutes: 60,
        earliestKickoffMinutes: 15 * 60,
        latestKickoffMinutes: 15 * 60,
      },
      {
        venueComplexes,
        practices: [holding('practice:subject', 16 * 60), holding('practice:holder-0', 15 * 60)],
      }
    );
    // Both positions are legal and both are compromised, which is the premise.
    expect(answer.counts.candidatesOnGrid).toBe(1);
    expect(answer.feasibleSlots[0].verdict).toBe(FEASIBILITY_VERDICT.FEASIBLE);
    expect(answer.feasibleSlots[0].tight).toBe(FEASIBILITY_TIGHTNESS.TIGHT);
    expect(answer.counts.swapsAdmissible).toBe(1);
    expect(answer.swaps[0].counterpartyLeg.tight).toBe(FEASIBILITY_TIGHTNESS.TIGHT);
    // …and the exchange still costs it nothing, because it loses nothing.
    expect(answer.swaps[0].cost.codes).toEqual([]);
    expect(answer.swaps[0].free).toBe(true);
    expect(answer.classification).toBe(MOVE_REQUEST_CLASS.FREE_SWAP_AVAILABLE);
  });

  it('**the second break**: widen the window until one position is free and a vacancy wins', () => {
    // `vacancy_available` beats a swap however good the swap is, and this proves
    // the classifier's first test rather than restating it. 15:00 is the first
    // kickoff of this ground that clears the last standing fixture, which ends
    // at 14:55 — derived below rather than asserted from memory.
    const lastStandingEnd = Math.max(
      ...schedule.games
        .filter((game) => game.date === AUG_22 && game.surfaceId === BROOKSIDE_1)
        .map((game) => game.endMinutes)
    );
    expect(lastStandingEnd).toBeLessThan(15 * 60);
    const widened = askSubject(zeroSumPractices([8 * 60, 9 * 60]), {
      earliest: 8 * 60,
      latest: 15 * 60,
    });
    expect(widened.counts.vacancies).toBe(1);
    expect(widened.vacancies[0].kickoffMinutes).toBe(15 * 60);
    expect(widened.classification).toBe(MOVE_REQUEST_CLASS.VACANCY_AVAILABLE);
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance 2 — free end-of-day slots at no counterparty cost                */
/* -------------------------------------------------------------------------- */

describe('move request :: vacancy_available', () => {
  const answer = askSubject([practiceAt('practice:subject', 8 * 60)], {
    earliest: 15 * 60,
    latest: TIGHT_KICKOFF,
  });

  it('classifies vacancy_available on free end-of-day ground', () => {
    expect(answer.classification).toBe(MOVE_REQUEST_CLASS.VACANCY_AVAILABLE);
    expect(answer.counts.candidatesOnGrid).toBe(3);
    expect(answer.counts.vacancies).toBe(3);
    // Nobody is being asked to give anything up, which is the "at no
    // counterparty cost" half of the acceptance sentence.
    expect(answer.counts.swapsAdmissible).toBe(0);
    expect(answer.zeroSum.holderCount).toBe(0);
    expect(answer.vacancies.map((slot) => slot.kickoffMinutes)).toEqual([
      15 * 60,
      16 * 60,
      TIGHT_KICKOFF,
    ]);
  });

  it('carries each vacancy with its own verdict, tightness and margin', () => {
    const last = answer.vacancies.find((slot) => slot.kickoffMinutes === TIGHT_KICKOFF);
    expect(last.verdict).toBe(FEASIBILITY_VERDICT.FEASIBLE);
    // The three-valued tightness survives: the last slot of the day is legal and
    // inside the permit's stated comfort margin, and the earlier ones are not.
    expect(last.tight).toBe(FEASIBILITY_TIGHTNESS.TIGHT);
    expect(answer.vacancies[0].tight).toBe(FEASIBILITY_TIGHTNESS.CLEAN);
    expect(last.slotId).toBe(capacitySlotId(AUG_22, BROOKSIDE_1, TIGHT_KICKOFF));
    expect(last.occupantIds).toEqual([]);
    expect(last.undecidableOccupantIds).toEqual([]);
  });

  it('**the break**: park a holder on every one of those slots and the class falls', () => {
    const crowded = [
      practiceAt('practice:subject', 8 * 60),
      practiceAt('practice:holder-0', 15 * 60),
      practiceAt('practice:holder-1', 16 * 60),
      practiceAt('practice:holder-2', TIGHT_KICKOFF),
    ];
    const answerWhenHeld = askSubject(crowded, { earliest: 15 * 60, latest: TIGHT_KICKOFF });
    expect(answerWhenHeld.counts.vacancies).toBe(0);
    expect(answerWhenHeld.classification).not.toBe(MOVE_REQUEST_CLASS.VACANCY_AVAILABLE);
    // And every one of them is a swap rather than a refusal: the ground is
    // legal, it is simply taken.
    expect(answerWhenHeld.counts.swapsAdmissible).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 3 — a swap is two-sided, and the lift is what makes it one             */
/* -------------------------------------------------------------------------- */

describe('move request :: both parties are lifted before either is judged', () => {
  const subject = schedule.games.find(
    (game) => game.format === '7v7' && game.date === '2026-10-03'
  );
  const answer = analyseMoveRequest(
    context,
    {
      entityKind: MOVE_REQUEST_ENTITY.GAME,
      entityId: subject.id,
      dates: [subject.date],
      surfaceIds: [],
      cadenceMinutes: 60,
      earliestKickoffMinutes: 8 * 60,
      latestKickoffMinutes: 19 * 60,
    },
    { venueComplexes }
  );

  it('found swaps at all, so the control below is about something', () => {
    expect(answer.counts.swapsAdmissible).toBeGreaterThan(0);
    expect(answer.meta.holdingsIndexed).toBe(schedule.games.length);
    expect(answer.meta.occupancyPairsCompared).toBeGreaterThan(0);
  });

  it('admits a swap into a slot canGameMove() refuses, because that query cannot vacate it', () => {
    // **The positive control for the whole module.** `canGameMove()` judges
    // against the resolve state as it stands, so the counterparty is still
    // standing on the slot and the move is blocked. A swap vacates it first.
    // Without this, "two-sided" would be a word in a docstring.
    let checked = 0;
    for (const swap of answer.swaps) {
      const oneSided = canGameMove(
        context,
        {
          gameId: subject.id,
          insteadOfDate: swap.date,
          insteadOfSurfaceId: swap.surfaceId,
          insteadOfMinutes: swap.kickoffMinutes,
        },
        { venueComplexes, minimalSet: false }
      );
      expect(oneSided.verdict).toBe(FEASIBILITY_VERDICT.INFEASIBLE);
      expect(swap.subjectLeg.verdict).toBe(FEASIBILITY_VERDICT.FEASIBLE);
      checked += 1;
    }
    // Meta-assertion: a loop over an empty list proves nothing.
    expect(checked).toBe(answer.swaps.length);
    expect(checked).toBeGreaterThan(0);
  });

  it('agrees with canGameMove() wherever the two are asked the same question', () => {
    // On an **unoccupied** candidate nothing is lifted but the subject, so the
    // two queries are looking at the same world and must reach the same verdict.
    // This is the claim `moveRequest.js`'s header makes about not losing a layer
    // by probing instead of calling that query, pinned so it cannot drift.
    let compared = 0;
    let agreed = 0;
    for (const slot of answer.feasibleSlots) {
      if (slot.occupantIds.length > 0) continue;
      if (slot.undecidableOccupantIds.length > 0) continue;
      if (slot.ownCommitmentClashIds.length > 0) continue;
      const other = canGameMove(
        context,
        {
          gameId: subject.id,
          insteadOfDate: slot.date,
          insteadOfSurfaceId: slot.surfaceId,
          insteadOfMinutes: slot.kickoffMinutes,
        },
        { venueComplexes, minimalSet: false, standingPositionIsAnAnswer: true }
      );
      compared += 1;
      if (other.verdict === slot.verdict) agreed += 1;
    }
    expect(compared).toBeGreaterThanOrEqual(10);
    expect(agreed).toBe(compared);
  });

  it('**the break**: the same comparison against a deliberately wrong position fails', () => {
    // The control for the control. If the loop above compared two things that
    // agree whatever happens, it would be a check nobody can make fail.
    const clean = answer.feasibleSlots.find(
      (slot) =>
        slot.verdict === FEASIBILITY_VERDICT.FEASIBLE &&
        slot.occupantIds.length === 0 &&
        slot.undecidableOccupantIds.length === 0
    );
    expect(clean).toBeDefined();
    const blackedOut = canGameMove(
      context,
      {
        gameId: subject.id,
        insteadOfDate: BLACKED_OUT,
        insteadOfSurfaceId: SUMMIT,
        insteadOfMinutes: clean.kickoffMinutes,
      },
      { venueComplexes, minimalSet: false }
    );
    expect(blackedOut.verdict).toBe(FEASIBILITY_VERDICT.INFEASIBLE);
    expect(blackedOut.verdict).not.toBe(clean.verdict);
  });

  it('names a registry-claimed objective where the registry can claim one', () => {
    // `PERMIT_MARGIN_TIGHT` above has no claim; the travel constraints do, and
    // through a different lookup. Without this the `objectives` field could be
    // permanently empty and every test above would still pass.
    const travelObjectives = new Set(Object.values(travelConstraintIdByCode(registry)));
    expect(travelObjectives.size).toBeGreaterThan(0);
    const named = answer.swaps.filter((swap) => swap.cost.objectives.length > 0);
    expect(named.length).toBeGreaterThan(0);
    for (const swap of named) {
      for (const objective of swap.cost.objectives) {
        expect(registry.byId[objective] ?? null).not.toBeNull();
      }
      expect(swap.cost.unclaimedCodes).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 4 — no universe is read out of the answer it is checking               */
/* -------------------------------------------------------------------------- */

describe('move request :: the holder index and the grid come from their own producers', () => {
  const practices = [
    practiceAt('practice:subject', 8 * 60),
    practiceAt('practice:holder-0', 9 * 60),
  ];
  const answer = askSubject(practices, { earliest: 8 * 60, latest: TIGHT_KICKOFF });

  it('indexes every game the run holds plus every practice handed in', () => {
    // Enumerated from `schedule.games` and the caller's own list — neither from
    // the grid nor from the answer's slots, which is what a broken join would
    // corrupt.
    expect(answer.meta.holdingsIndexed).toBe(schedule.games.length + practices.length);
  });

  it('offers exactly the positions an independently built capacity report offers', () => {
    const independent = buildReserveCapacityReport(
      { graph, table, calendar, registry },
      {
        name: 'independent',
        format: '7v7',
        dates: [AUG_22],
        surfaceIds: [BROOKSIDE_1],
        cadenceMinutes: 60,
        earliestKickoffMinutes: 8 * 60,
        latestKickoffMinutes: TIGHT_KICKOFF,
        requirement: { slots: 1, label: 'independent', source: 'independent' },
        reservedSlots: [],
        bookings: [],
      }
    );
    const expected = independent.dates
      .flatMap((dateRow) =>
        dateRow.bySurface.flatMap((surfaceRow) =>
          surfaceRow.kickoffMinutes.map((kickoff) =>
            capacitySlotId(dateRow.date, surfaceRow.surfaceId, kickoff)
          )
        )
      )
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(answer.feasibleSlots.map((slot) => slot.slotId).sort()).toEqual(expected);
    expect(answer.meta.capacitySlotsJoined).toBe(expected.length);
  });

  it('answers every candidate it considered, and drops none', () => {
    expect(answer.meta.candidatesConsidered).toBe(answer.meta.candidatesAnswered);
    expect(answer.feasibleSlots.length).toBe(answer.counts.candidatesOnGrid);
    expect(answer.counts.feasible + answer.counts.infeasible + answer.counts.undecidable).toBe(
      answer.counts.candidatesOnGrid
    );
    expect(
      answer.findings.some(
        (finding) => finding.code === FEASIBILITY_REASON.FEASIBILITY_CANDIDATE_DROPPED
      )
    ).toBe(false);
  });

  it('refuses two holdings under one key rather than letting one become invisible', () => {
    const collided = analyseMoveRequest(
      context,
      {
        entityKind: MOVE_REQUEST_ENTITY.PRACTICE,
        entityId: 'practice:subject',
        dates: [AUG_22],
        surfaceIds: [BROOKSIDE_1],
        cadenceMinutes: 60,
        earliestKickoffMinutes: 8 * 60,
        latestKickoffMinutes: 10 * 60,
      },
      {
        venueComplexes,
        practices: [
          practiceAt('practice:subject', 8 * 60),
          // A practice wearing a game's id. Silently last-wins would make the
          // game invisible to occupancy, vacancy and every swap.
          practiceAt(schedule.games[0].id, 9 * 60),
        ],
      }
    );
    const duplicated = collided.findings.filter(
      (finding) => finding.code === FEASIBILITY_REASON.MOVE_REQUEST_HOLDING_DUPLICATED
    );
    expect(duplicated).toHaveLength(1);
    expect(duplicated[0].severity).toBe(FEASIBILITY_SEVERITY.BLOCKING);
    expect(duplicated[0].details.ids).toEqual([schedule.games[0].id]);
    expect(collided.status).toBe(FEASIBILITY_STATUS.REJECTED);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 5 — unknown never collapses                                            */
/* -------------------------------------------------------------------------- */

describe('move request :: undecidable is neither free nor taken', () => {
  it('never offers ground whose occupancy could not be decided', () => {
    // GAP-14: a holding with no known end. `bookingsOverlapInTime()` answers
    // `null`, and `null` is not "no clash".
    const practices = [
      practiceAt('practice:subject', 8 * 60),
      practiceAt('practice:open-ended', 9 * 60, { endMinutes: null }),
    ];
    const answer = askSubject(practices, { earliest: 9 * 60, latest: 9 * 60 });
    expect(answer.counts.candidatesOnGrid).toBe(1);
    const [slot] = answer.feasibleSlots;
    expect(slot.occupantIds).toEqual([]);
    expect(slot.undecidableOccupantIds).toEqual(['practice:open-ended']);
    expect(answer.counts.vacancies).toBe(0);
    expect(
      answer.unknowns.some(
        (entry) => entry.code === FEASIBILITY_REASON.MOVE_REQUEST_OCCUPANCY_UNDECIDABLE
      )
    ).toBe(true);
    // …and no swap either: an exchange with a holding that may not be there is
    // not an offer.
    expect(answer.counts.swapsAdmissible).toBe(0);
    expect(answer.classification).toBe(MOVE_REQUEST_CLASS.INFEASIBLE);
  });

  it('**the break**: give that holding an end and the same ground becomes a swap', () => {
    const practices = [
      practiceAt('practice:subject', 8 * 60),
      practiceAt('practice:open-ended', 9 * 60),
    ];
    const answer = askSubject(practices, { earliest: 9 * 60, latest: 9 * 60 });
    expect(answer.feasibleSlots[0].occupantIds).toEqual(['practice:open-ended']);
    expect(answer.feasibleSlots[0].undecidableOccupantIds).toEqual([]);
    expect(answer.counts.swapsAdmissible).toBe(1);
    expect(answer.classification).toBe(MOVE_REQUEST_CLASS.FREE_SWAP_AVAILABLE);
  });

  it('answers rather than throwing when a holding stands on ground the graph does not hold', () => {
    // `surfacesConflict()` reaches `requireSurface()`, which throws, and a
    // practice's surface id came from data. Three modules have shipped that
    // throw; `tests/unknownSurfaceDiscipline.test.js` carries the census this
    // module is now in.
    const practices = [
      practiceAt('practice:subject', 8 * 60),
      practiceAt('practice:ghost', 9 * 60, { surfaceId: `${BROOKSIDE_1}-not-in-the-graph` }),
    ];
    /** @type {import('@squadlogic/core/feasibility/types.js').MoveRequestAnalysis|null} */
    let answer = null;
    expect(() => {
      answer = askSubject(practices, { earliest: 9 * 60, latest: 9 * 60 });
    }).not.toThrow();
    const settled =
      /** @type {import('@squadlogic/core/feasibility/types.js').MoveRequestAnalysis} */ (answer);
    expect(settled.feasibleSlots[0].undecidableOccupantIds).toEqual(['practice:ghost']);
    expect(settled.counts.vacancies).toBe(0);
    expect(
      settled.unknowns.some(
        (entry) => entry.code === FEASIBILITY_REASON.MOVE_REQUEST_HOLDING_SURFACE_UNKNOWN
      )
    ).toBe(true);
  });

  it('never marks a slot feasible while something undecidable may stand on it', () => {
    // The invariant that replaces a guard the break table showed could not
    // fire: an undecidable occupant always arrives beside a verdict-bearing
    // unknown, so the slot is `unknown` and can never be offered. Asserted over
    // real answers rather than restated in the filter, and red the moment that
    // unknown stops bearing on a verdict.
    const answers = [
      askSubject(
        [
          practiceAt('practice:subject', 8 * 60),
          practiceAt('practice:open-ended', 9 * 60, { endMinutes: null }),
        ],
        { earliest: 9 * 60, latest: 10 * 60 }
      ),
      askSubject(
        [
          practiceAt('practice:subject', 8 * 60),
          practiceAt('practice:ghost', 9 * 60, {
            surfaceId: `${BROOKSIDE_1}-not-in-the-graph`,
          }),
        ],
        { earliest: 9 * 60, latest: 10 * 60 }
      ),
    ];
    let withUndecidable = 0;
    for (const answer of answers) {
      for (const slot of answer.feasibleSlots) {
        if (slot.undecidableOccupantIds.length === 0) continue;
        withUndecidable += 1;
        expect(slot.verdict).not.toBe(FEASIBILITY_VERDICT.FEASIBLE);
        expect(answer.vacancies.map((entry) => entry.slotId)).not.toContain(slot.slotId);
      }
    }
    // Meta-assertion: a sweep with no undecidable slot in it proves nothing.
    expect(withUndecidable).toBeGreaterThanOrEqual(2);
  });

  it('says so when a window offers nothing and something in it went unjudged', () => {
    // The only candidate in the window is held by an open-ended holding, so
    // whether the ground is free could not be decided. "Nothing to offer" is
    // then a floor rather than a finding, and the class says which.
    const practices = [
      practiceAt('practice:subject', 8 * 60),
      practiceAt('practice:open-ended', 9 * 60, { endMinutes: null }),
    ];
    const answer = askSubject(practices, { earliest: 9 * 60, latest: 9 * 60 });
    expect(answer.counts.undecidable).toBe(1);
    expect(answer.counts.feasible).toBe(0);
    expect(answer.classification).toBe(MOVE_REQUEST_CLASS.INFEASIBLE);
    expect(answer.verdict).toBe(FEASIBILITY_VERDICT.UNKNOWN);
    expect(
      answer.findings.some(
        (finding) => finding.code === FEASIBILITY_REASON.MOVE_REQUEST_CLASS_UNDER_UNKNOWN
      )
    ).toBe(true);
  });

  it('is `infeasible` with no such finding when the window was searched to the bottom', () => {
    // The negative control for the line above: same class, nothing unjudged, and
    // the qualifier must be absent or it would be decoration on every answer.
    const answer = analyseMoveRequest(
      context,
      {
        entityKind: MOVE_REQUEST_ENTITY.GAME,
        entityId: schedule.games.find((game) => game.date === BLACKED_OUT).id,
        dates: [BLACKED_OUT],
        surfaceIds: [SUMMIT],
        cadenceMinutes: 60,
        earliestKickoffMinutes: 9 * 60,
        latestKickoffMinutes: 17 * 60,
      },
      { venueComplexes }
    );
    expect(answer.counts.candidatesOnGrid).toBe(0);
    expect(answer.counts.undecidable).toBe(0);
    expect(answer.classification).toBe(MOVE_REQUEST_CLASS.INFEASIBLE);
    expect(
      answer.findings.some(
        (finding) => finding.code === FEASIBILITY_REASON.MOVE_REQUEST_CLASS_UNDER_UNKNOWN
      )
    ).toBe(false);
    // The blacked-out permit makes the capacity report itself say it generated
    // nothing, and that is lifted rather than swallowed: "no vacancy" over an
    // empty grid is a fact about the report, not about the season.
    expect(
      answer.findings.some(
        (finding) => finding.code === FEASIBILITY_REASON.MOVE_REQUEST_CAPACITY_IMPEACHED
      )
    ).toBe(true);
    expect(
      answer.findings.some(
        (finding) => finding.code === FEASIBILITY_REASON.FEASIBILITY_QUERY_VACUOUS
      )
    ).toBe(true);
    expect(answer.status).toBe(FEASIBILITY_STATUS.REJECTED);
  });
});

/* -------------------------------------------------------------------------- */
/* The subject, the schema, and the vocabulary                                 */
/* -------------------------------------------------------------------------- */

describe('move request :: the subject and the query', () => {
  it('refuses a subject nothing holds, and says how much it looked at', () => {
    const answer = analyseMoveRequest(
      context,
      {
        entityKind: MOVE_REQUEST_ENTITY.GAME,
        entityId: 'no-such-fixture',
        dates: [AUG_22],
        surfaceIds: [BROOKSIDE_1],
        cadenceMinutes: 60,
        earliestKickoffMinutes: 9 * 60,
        latestKickoffMinutes: 10 * 60,
      },
      { venueComplexes }
    );
    expect(answer.classification).toBe(MOVE_REQUEST_CLASS.INFEASIBLE);
    expect(answer.verdict).toBe(FEASIBILITY_VERDICT.UNKNOWN);
    const stated = answer.findings.find(
      (finding) => finding.code === FEASIBILITY_REASON.MOVE_REQUEST_SUBJECT_UNKNOWN
    );
    expect(stated).toBeDefined();
    expect(stated.details.indexed).toBe(schedule.games.length);
    expect(answer.meta.candidatesConsidered).toBe(answer.meta.candidatesAnswered);
  });

  it('refuses a game asked about as a practice rather than answering a different question', () => {
    const answer = analyseMoveRequest(
      context,
      {
        entityKind: MOVE_REQUEST_ENTITY.PRACTICE,
        entityId: schedule.games[0].id,
        dates: [AUG_22],
        surfaceIds: [BROOKSIDE_1],
        cadenceMinutes: 60,
        earliestKickoffMinutes: 9 * 60,
        latestKickoffMinutes: 10 * 60,
      },
      { venueComplexes }
    );
    expect(answer.verdict).toBe(FEASIBILITY_VERDICT.UNKNOWN);
    expect(
      answer.unknowns.some(
        (entry) => entry.code === FEASIBILITY_REASON.MOVE_REQUEST_SUBJECT_UNKNOWN
      )
    ).toBe(true);
  });

  it('says which layer is silent for a practice, and does not say it for a game', () => {
    const practice = askSubject([practiceAt('practice:subject', 8 * 60)], {
      earliest: 9 * 60,
      latest: 10 * 60,
    });
    const game = analyseMoveRequest(
      context,
      {
        entityKind: MOVE_REQUEST_ENTITY.GAME,
        entityId: schedule.games.find((entry) => entry.format === '7v7').id,
        dates: [AUG_22],
        surfaceIds: [BROOKSIDE_1],
        cadenceMinutes: 60,
        earliestKickoffMinutes: 9 * 60,
        latestKickoffMinutes: 10 * 60,
      },
      { venueComplexes }
    );
    const silentFor = (answer) =>
      answer.findings.filter(
        (finding) => finding.code === FEASIBILITY_REASON.MOVE_REQUEST_LAYER_SILENT
      );
    expect(silentFor(practice)).toHaveLength(1);
    expect(silentFor(practice)[0].severity).toBe(FEASIBILITY_SEVERITY.INFO);
    expect(silentFor(game)).toHaveLength(0);
    // And the silence does not become an `unknown`: a rule that does not govern
    // a practice is inapplicable, not unmeasured.
    expect(
      practice.unknowns.some(
        (entry) => entry.code === FEASIBILITY_REASON.FEASIBILITY_VERIFICATION_ABSENT
      )
    ).toBe(false);
  });

  it('reports ground inside the window that the cadence does not offer', () => {
    // A holder at a minute the grid does not generate was never considered as a
    // counterparty, and saying "no swap available" without saying so would be
    // describing the cadence rather than the season.
    const answer = askSubject(
      [practiceAt('practice:subject', 8 * 60), practiceAt('practice:odd', 9 * 60 + 30)],
      { earliest: 9 * 60, latest: 10 * 60 }
    );
    const offGrid = answer.findings.find(
      (finding) => finding.code === FEASIBILITY_REASON.MOVE_REQUEST_OFF_CAPACITY_GRID
    );
    expect(offGrid).toBeDefined();
    expect(offGrid.details.holdingIds).toContain('practice:odd');
  });

  it('parses its window strictly, and refuses an empty one', () => {
    expect(() =>
      MoveRequestQuerySchema.parse({
        entityKind: 'game',
        entityId: 'x',
        dates: [],
        cadenceMinutes: 60,
        earliestKickoffMinutes: 540,
      })
    ).toThrow();
    expect(() =>
      MoveRequestQuerySchema.parse({
        entityKind: 'game',
        entityId: 'x',
        dates: ['2026-08-22'],
        cadenceMinutes: 60,
        earliestKickoffMinutes: 540,
        nonsense: true,
      })
    ).toThrow();
    const parsed = MoveRequestQuerySchema.parse({
      entityKind: 'practice',
      entityId: 'x',
      dates: ['2026-08-22'],
      cadenceMinutes: 60,
      earliestKickoffMinutes: 540,
    });
    expect(parsed.surfaceIds).toEqual([]);
    expect(parsed.latestKickoffMinutes).toBe(24 * 60);
  });

  it('registers a severity for every reason code it can emit', () => {
    const declared = Object.values(FEASIBILITY_REASON).filter((code) =>
      code.startsWith('MOVE_REQUEST_')
    );
    expect(declared.length).toBe(10);
    for (const code of declared) {
      expect(FEASIBILITY_REASON_SEVERITY[code]).toBeDefined();
      expect(() => feasibilitySeverityOf(code)).not.toThrow();
    }
    expect(FEASIBILITY_QUESTION.ANALYSE_MOVE_REQUEST).toBe('analyse-move-request');
  });

  it('carries the answer shape every other query in this module carries', () => {
    const answer = askSubject([practiceAt('practice:subject', 8 * 60)], {
      earliest: 9 * 60,
      latest: 10 * 60,
    });
    expect(answer.question).toBe(FEASIBILITY_QUESTION.ANALYSE_MOVE_REQUEST);
    expect(answer.subject.date).toBe(AUG_22);
    expect(answer.subject.surfaceId).toBe(BROOKSIDE_1);
    expect(answer.subject.kickoffMinutes).toBe(8 * 60);
    expect(answer.subject.venueId).toBe('brookside-park');
    expect(answer.marginUnit).toBe('minutes');
    expect([
      CONSTRAINT_STATUS.ALLOWED,
      CONSTRAINT_STATUS.COMPROMISED,
      CONSTRAINT_STATUS.REJECTED,
    ]).toContain(answer.status);
    // `seal()`'s provenance finding, so the two channels are both present.
    expect(
      answer.findings.some(
        (finding) => finding.code === FEASIBILITY_REASON.FEASIBILITY_VERDICT_REACHED
      )
    ).toBe(true);
    expect(
      answer.findings.some(
        (finding) => finding.code === FEASIBILITY_REASON.MOVE_REQUEST_CLASS_REACHED
      )
    ).toBe(true);
  });
});
