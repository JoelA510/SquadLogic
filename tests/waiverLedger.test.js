/**
 * Tests for the waiver ledger (`packages/core/src/waivers/`) — Prompt 2.2,
 * [GAP-26](../docs/MODEL_GAPS.md#gap-26).
 *
 * The acceptance test at the bottom is **derived from the corpus**, not typed
 * in. It searches `coach_roster.csv` + `combined_schedule.csv` for the day
 * incident 9 describes — one coach, two venues, a gap under the hour — and
 * asserts that exactly **one** such day exists before asserting anything about
 * it. The counterfactual half ("re-solved with the league game at 12:30") is
 * the corpus's own `external_fixtures_published.csv`: the external league
 * published that fixture at 12:30 and the final agreement moved it to 12:00, so
 * both clock times in the acceptance criteria are real rows in real files and
 * neither is invented here.
 *
 * Meta-assertion discipline (incident 4 in `fixtures/season-2026/README.md`):
 * every behavioural check also asserts it examined a non-zero number of
 * records. `meta.subjectsExamined`, `meta.findingsExamined` and
 * `meta.transitionsJudged` matter most — a waiver engine handed nothing to
 * waive would report a perfectly clean, perfectly meaningless pass.
 */

import { describe, it, expect } from 'vitest';

import {
  BASE_REASON_SEVERITY,
  CONSTRAINT_STATUS,
  CONSTRAINT_TYPE,
  SEASON_2026_CONSTRAINT_ID,
  buildConstraintRegistry,
  buildSeason2026ConstraintRegistry,
  requireConstraint,
  retypeConstraint,
} from '@squadlogic/core/constraints/index.js';
import {
  EMPTY_VENUE_COMPLEX_MAP,
  buildSeason2026VenueComplexMap,
  buildVenueComplexMap,
  season2026VenueId,
} from '@squadlogic/core/facility/index.js';
import { loadSeason2026 } from '@squadlogic/core/fixtures/index.js';

import {
  DORMANCY_REASON,
  INCIDENT_9_OBSERVED_TRAVEL_MINUTES,
  SEASON_2026_WAIVER_ID,
  TRAVEL_POLICY,
  TRAVEL_REASON,
  TRAVEL_REASON_SEVERITY,
  WAIVER_DISPOSITION,
  WAIVER_REASON,
  WAIVER_REASON_SEVERITY,
  WAIVER_SEVERITY,
  WAIVER_STATUS,
  WaiverRecordSchema,
  annotationsBySubject,
  applyWaivers,
  buildSeason2026WaiverLedger,
  buildWaiverLedger,
  detectDormantWaivers,
  deriveWaiverDisposition,
  deriveWaiverStatus,
  evaluateCoachTravel,
  getWaiver,
  isWaived,
  judgeWaiverScope,
  makeWaiverFinding,
  mergeWaiverNote,
  normaliseWaiverContext,
  reconcileWaiverLedger,
  requireWaiver,
  travelConstraintIdByCode,
  travelSeverityOf,
  waiverNotesBySubject,
  waiverSeverityOf,
  waiverSpecificity,
  waiversForConstraint,
  withoutWaiver,
} from '@squadlogic/core/waivers/index.js';

/* -------------------------------------------------------------------------- */
/* Shared scaffolding                                                          */
/* -------------------------------------------------------------------------- */

const registry = buildSeason2026ConstraintRegistry();
const TRAVEL = SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES;
const SUNSET = SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN;
const EMPTY_LEDGER = buildWaiverLedger({ name: 'no waivers', waivers: [] });

/** A minimal valid waiver, so each test states only what it is about. */
function makeWaiver(overrides = {}) {
  return {
    id: 'test-waiver',
    constraintId: TRAVEL,
    name: 'A waiver under test',
    scope: { personId: 'person-1' },
    reason: 'because the test says so',
    approval: {
      approvedBy: 'the test suite',
      approvedAt: '2026-08-01',
      reference: 'tests/waiverLedger.test.js',
    },
    ...overrides,
  };
}

/** A ledger holding exactly the given waivers. */
function ledgerOf(...waivers) {
  return buildWaiverLedger({ name: 'test', waivers });
}

/** A subject carrying one finding of a given code and severity. */
function subjectWith(id, code, severity, context = {}) {
  return { id, context, findings: [{ code, severity, message: `${code} happened`, details: {} }] };
}

/** The link map the travel codes need while coach travel is `declared-only`. */
const travelLinks = travelConstraintIdByCode(registry);

/* -------------------------------------------------------------------------- */
/* Reason codes, severity and the disposition vocabulary                        */
/* -------------------------------------------------------------------------- */

describe('the waiver severity table', () => {
  it('registers a severity for every reason code', () => {
    const codes = Object.values(WAIVER_REASON);
    // Meta-assertion: an enum that had lost its members would make every
    // "this code fires" test below pass vacuously.
    expect(codes.length).toBeGreaterThan(10);
    let checked = 0;
    for (const code of codes) {
      expect(Object.keys(WAIVER_REASON_SEVERITY)).toContain(code);
      expect(waiverSeverityOf(code)).toBeTruthy();
      checked += 1;
    }
    expect(checked).toBe(codes.length);
  });

  it('refuses an unregistered code rather than defaulting it to info', () => {
    expect(() => waiverSeverityOf('NOT_A_REAL_CODE')).toThrow(/no registered severity/);
  });

  it('keeps WAIVER_APPLIED a compromise, which is what makes "never silently" mechanical', () => {
    // This one assertion is the whole "waived, not clean" guarantee: because
    // `deriveWaiverStatus` reads severities and nothing else, a subject
    // carrying this finding cannot derive `allowed` no matter what else is
    // true of it.
    expect(waiverSeverityOf(WAIVER_REASON.WAIVER_APPLIED)).toBe(WAIVER_SEVERITY.COMPROMISE);
    const status = deriveWaiverStatus([
      makeWaiverFinding(WAIVER_REASON.WAIVER_APPLIED, 'applied', {}),
    ]);
    expect(status).toBe(WAIVER_STATUS.COMPROMISED);
    expect(status).not.toBe(WAIVER_STATUS.ALLOWED);
  });

  it('keeps a waiver code out of the constraint registry’s base table', () => {
    // Deliberate, and asserted so that merging them later is a decision rather
    // than an accident: a constraint record must not be able to claim
    // `WAIVER_APPLIED` and pretend to set its hardness.
    let checked = 0;
    for (const code of Object.values(WAIVER_REASON)) {
      expect(BASE_REASON_SEVERITY[code]).toBeUndefined();
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
    // Same for the narrow travel evaluator's codes: registering them would be
    // the act of saying the registry enforces coach travel, which it does not.
    for (const code of Object.values(TRAVEL_REASON)) {
      expect(BASE_REASON_SEVERITY[code]).toBeUndefined();
    }
  });

  it('derives the disposition from the 2x2 rather than from a call site', () => {
    expect(deriveWaiverDisposition({ waivedCount: 0, uncoveredViolationCount: 0 })).toBe(
      WAIVER_DISPOSITION.CLEAN
    );
    expect(deriveWaiverDisposition({ waivedCount: 1, uncoveredViolationCount: 0 })).toBe(
      WAIVER_DISPOSITION.WAIVED
    );
    expect(deriveWaiverDisposition({ waivedCount: 1, uncoveredViolationCount: 2 })).toBe(
      WAIVER_DISPOSITION.WAIVED_PARTIAL
    );
    expect(deriveWaiverDisposition({ waivedCount: 0, uncoveredViolationCount: 3 })).toBe(
      WAIVER_DISPOSITION.UNWAIVED
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The record schema                                                           */
/* -------------------------------------------------------------------------- */

describe('the waiver record schema', () => {
  it('accepts a well-formed record and defaults the untouched fields', () => {
    const parsed = WaiverRecordSchema.parse(makeWaiver());
    expect(parsed.reasonCodes).toEqual([]);
    expect(parsed.effectiveTo).toBeNull();
    expect(parsed.scope.venueIds).toBeNull();
    expect(parsed.parameters).toEqual({});
  });

  it('refuses a waiver that narrows on nothing, because that is a repeal', () => {
    expect(() => WaiverRecordSchema.parse(makeWaiver({ scope: {} }))).toThrow(/at least one/);
  });

  it('refuses a record carrying a cached dormancy flag', () => {
    // `.strict()` is what makes "dormancy is computed, never stored" a
    // guarantee rather than a promise.
    expect(() => WaiverRecordSchema.parse({ ...makeWaiver(), dormant: false })).toThrow();
  });

  it('requires a note when the approval carries no date', () => {
    expect(() =>
      WaiverRecordSchema.parse(
        makeWaiver({
          approval: { approvedBy: 'board', approvedAt: null, reference: 'the log' },
        })
      )
    ).toThrow(/must carry a note/);
    expect(() =>
      WaiverRecordSchema.parse(
        makeWaiver({
          approval: {
            approvedBy: 'board',
            approvedAt: null,
            reference: 'the log',
            note: 'no date survives',
          },
        })
      )
    ).not.toThrow();
  });

  it('refuses an expiry that precedes the start, a duplicated venue and a doubled date axis', () => {
    expect(() =>
      WaiverRecordSchema.parse(
        makeWaiver({ effectiveFrom: '2026-09-01', effectiveTo: '2026-08-01' })
      )
    ).toThrow(/expire before/);
    expect(() => WaiverRecordSchema.parse(makeWaiver({ scope: { venueIds: ['a', 'a'] } }))).toThrow(
      /same venue twice/
    );
    expect(() =>
      WaiverRecordSchema.parse(
        makeWaiver({ scope: { personId: 'p', date: '2026-08-22', fromDate: '2026-08-01' } })
      )
    ).toThrow(/single date or a range/);
  });

  it('requires a reason and an approver', () => {
    expect(() => WaiverRecordSchema.parse(makeWaiver({ reason: '' }))).toThrow(
      /why it was granted/
    );
    expect(() =>
      WaiverRecordSchema.parse(
        makeWaiver({
          approval: { approvedBy: '', approvedAt: '2026-08-01', reference: 'x' },
        })
      )
    ).toThrow(/who approved it/);
  });
});

/* -------------------------------------------------------------------------- */
/* Building and reconciling the ledger                                          */
/* -------------------------------------------------------------------------- */

describe('the waiver ledger', () => {
  it('indexes, sorts and counts what it was given', () => {
    const ledger = ledgerOf(
      makeWaiver({ id: 'zulu' }),
      makeWaiver({ id: 'alpha', effectiveTo: '2026-12-31' })
    );
    expect(ledger.waiverIds).toEqual(['alpha', 'zulu']);
    expect(ledger.stats.waiverCount).toBe(2);
    expect(ledger.stats.constraintCount).toBe(1);
    expect(ledger.stats.expiringCount).toBe(1);
    expect(ledger.stats.openEndedCount).toBe(1);
    expect(ledger.stats.datedApprovalCount).toBe(2);
    expect(ledger.stats.scopeDimensionCount).toBe(2);
    expect(waiversForConstraint(ledger, TRAVEL).map((record) => record.id)).toEqual([
      'alpha',
      'zulu',
    ]);
    expect(ledger.meta.waiversConsidered).toBe(2);
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(() => requireWaiver(ledger, 'nope')).toThrow(/no waiver "nope"/);
  });

  it('never answers a lookup with something off Object.prototype', () => {
    // `byId` and `idsByConstraint` are maps, not objects with a prototype: an
    // id of `toString` must be absent rather than a function, and a waiver id
    // of `constructor` must be storable rather than read as a duplicate.
    const ledger = ledgerOf(
      makeWaiver({ id: 'constructor', constraintId: 'toString' }),
      makeWaiver({ id: 'hasOwnProperty', constraintId: 'toString' })
    );
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(getWaiver(ledgerOf(makeWaiver()), inherited), inherited).toBeNull();
      expect(waiversForConstraint(ledgerOf(makeWaiver()), inherited), inherited).toEqual([]);
    }
    expect([...ledger.waiverIds].sort()).toEqual(['constructor', 'hasOwnProperty']);
    expect(ledger.findings.map((finding) => finding.code)).not.toContain(
      WAIVER_REASON.WAIVER_ID_DUPLICATE
    );
    expect(getWaiver(ledger, 'constructor')?.id).toBe('constructor');
    expect(waiversForConstraint(ledger, 'toString').map((record) => record.id)).toEqual([
      'constructor',
      'hasOwnProperty',
    ]);
  });

  it('reports a duplicate id as blocking, because the loser would vanish', () => {
    const ledger = ledgerOf(makeWaiver(), makeWaiver({ reason: 'a different reason' }));
    const duplicate = ledger.findings.filter(
      (finding) => finding.code === WAIVER_REASON.WAIVER_ID_DUPLICATE
    );
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].severity).toBe(WAIVER_SEVERITY.BLOCKING);
    expect(ledger.status).toBe(WAIVER_STATUS.REJECTED);
    expect(ledger.stats.waiverCount).toBe(1);
  });

  it('reports an empty ledger as info, unlike an empty constraint registry', () => {
    // The asymmetry is deliberate and load bearing: an empty registry makes
    // every "allowed" answer true for the wrong reason; an empty ledger makes
    // every "nothing was waived" answer true for the right one.
    const empty = ledgerOf();
    expect(empty.findings.map((finding) => finding.code)).toEqual([
      WAIVER_REASON.WAIVER_LEDGER_EMPTY,
    ]);
    expect(empty.status).toBe(WAIVER_STATUS.ALLOWED);
    const emptyRegistry = buildConstraintRegistry({ name: 'empty', constraints: [] });
    expect(emptyRegistry.status).toBe(CONSTRAINT_STATUS.REJECTED);
  });

  it('removes a waiver into a new ledger and leaves the original alone', () => {
    const ledger = ledgerOf(makeWaiver({ id: 'a' }), makeWaiver({ id: 'b' }));
    const reduced = withoutWaiver(ledger, 'a');
    expect(reduced.waiverIds).toEqual(['b']);
    expect(ledger.waiverIds).toEqual(['a', 'b']);
    expect(reduced).not.toBe(ledger);
    expect(() => withoutWaiver(ledger, 'ghost')).toThrow(/no waiver "ghost"/);
  });

  it('refuses a waiver whose constraint the registry does not hold', () => {
    const ledger = ledgerOf(makeWaiver({ constraintId: 'constraint-that-was-renamed' }));
    const reconciled = reconcileWaiverLedger(ledger, registry);
    // The field names what it holds: these are *waiver* ids, and the constraint
    // the waiver names is the thing that is missing.
    expect(reconciled.waiverIdsWithUnknownConstraint).toEqual(['test-waiver']);
    expect(reconciled.status).toBe(WAIVER_STATUS.REJECTED);
    expect(reconciled.findings[0].code).toBe(WAIVER_REASON.WAIVER_CONSTRAINT_UNKNOWN);
    expect(reconciled.meta.waiversConsidered).toBe(1);
  });

  it('refuses a waiver of a constraint nobody may waive', () => {
    expect(requireConstraint(registry, SUNSET).waivable).toBe(false);
    const reconciled = reconcileWaiverLedger(
      ledgerOf(makeWaiver({ constraintId: SUNSET })),
      registry
    );
    expect(reconciled.waiverIdsNotWaivable).toEqual(['test-waiver']);
    expect(reconciled.findings[0].severity).toBe(WAIVER_SEVERITY.BLOCKING);
  });

  it('reports a waiver naming reason codes its constraint does not govern', () => {
    const adjacency = SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY;
    const waivable = retypeAdjacencyWaivable();
    const reconciled = reconcileWaiverLedger(
      ledgerOf(makeWaiver({ constraintId: adjacency, reasonCodes: ['NOT_A_CODE_IT_GOVERNS'] })),
      waivable
    );
    const finding = reconciled.findings.find(
      (entry) => entry.code === WAIVER_REASON.WAIVER_REASON_CODE_UNCLAIMED
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    expect(finding.details.unclaimed).toEqual(['NOT_A_CODE_IT_GOVERNS']);
    expect(/** @type {string[]} */ (finding.details.governed).length).toBeGreaterThan(0);
  });
});

/** Adjacency, made waivable, so the unclaimed-code path is reachable. */
function retypeAdjacencyWaivable() {
  return buildConstraintRegistry({
    name: 'adjacency waivable',
    constraints: registry.constraints.map((record) =>
      record.id === SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY
        ? { ...record, waivable: true }
        : record
    ),
  });
}

/* -------------------------------------------------------------------------- */
/* Scope and windows                                                            */
/* -------------------------------------------------------------------------- */

describe('waiver scope and windows', () => {
  it('treats an absent dimension as unjudged rather than as a wildcard', () => {
    const record = WaiverRecordSchema.parse(makeWaiver({ scope: { personId: 'coach-a' } }));
    const judged = judgeWaiverScope(record, normaliseWaiverContext({ date: '2026-08-22' }));
    expect(judged.judged).toBe(false);
    expect(judged.inScope).toBe(false);
    expect(judged.code).toBe(WAIVER_REASON.WAIVER_SCOPE_UNJUDGED);
    expect(judged.dimensionsTested).toBe(1);
    expect(waiverSeverityOf(judged.code)).toBe(WAIVER_SEVERITY.COMPROMISE);
  });

  it('composes several dimensions as a conjunction', () => {
    const record = WaiverRecordSchema.parse(
      makeWaiver({ scope: { personId: 'coach-a', venueIds: ['alder', 'brookside'] } })
    );
    expect(waiverSpecificity(record)).toBe(3);
    const matching = judgeWaiverScope(
      record,
      normaliseWaiverContext({ personId: 'coach-a', venueIds: ['brookside', 'alder'] })
    );
    expect(matching.inScope).toBe(true);
    expect(matching.dimensionsTested).toBe(2);

    // Right coach, a venue nobody approved: not the thing the board approved.
    const thirdVenue = judgeWaiverScope(
      record,
      normaliseWaiverContext({ personId: 'coach-a', venueIds: ['alder', 'orchard'] })
    );
    expect(thirdVenue.inScope).toBe(false);
    expect(thirdVenue.judged).toBe(true);

    // Right venues, wrong coach.
    const otherCoach = judgeWaiverScope(
      record,
      normaliseWaiverContext({ personId: 'coach-b', venueIds: ['alder'] })
    );
    expect(otherCoach.inScope).toBe(false);
  });

  it('reports a waiver outside its validity window without applying it', () => {
    const ledger = ledgerOf(makeWaiver({ effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' }));
    const before = applyWaivers(
      [
        subjectWith('s1', TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT, WAIVER_SEVERITY.BLOCKING, {
          date: '2026-08-22',
          personId: 'person-1',
        }),
      ],
      { ledger, registry, constraintIdByCode: travelLinks }
    );
    expect(before.subjects[0].findings.map((finding) => finding.code)).toContain(
      WAIVER_REASON.WAIVER_NOT_YET_EFFECTIVE
    );
    expect(before.subjects[0].disposition).toBe(WAIVER_DISPOSITION.UNWAIVED);
    expect(before.subjects[0].status).toBe(WAIVER_STATUS.REJECTED);

    const after = applyWaivers(
      [
        subjectWith('s1', TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT, WAIVER_SEVERITY.BLOCKING, {
          date: '2026-10-31',
          personId: 'person-1',
        }),
      ],
      { ledger, registry, constraintIdByCode: travelLinks }
    );
    expect(after.subjects[0].findings.map((finding) => finding.code)).toContain(
      WAIVER_REASON.WAIVER_EXPIRED
    );

    const during = applyWaivers(
      [
        subjectWith('s1', TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT, WAIVER_SEVERITY.BLOCKING, {
          date: '2026-09-12',
          personId: 'person-1',
        }),
      ],
      { ledger, registry, constraintIdByCode: travelLinks }
    );
    expect(during.subjects[0].disposition).toBe(WAIVER_DISPOSITION.WAIVED);
  });

  it('cannot decide a windowed waiver when the subject carries no date', () => {
    const ledger = ledgerOf(makeWaiver({ effectiveTo: '2026-09-30' }));
    const applied = applyWaivers(
      [
        subjectWith('s1', TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT, WAIVER_SEVERITY.BLOCKING, {
          personId: 'person-1',
        }),
      ],
      { ledger, registry, constraintIdByCode: travelLinks }
    );
    const unjudged = applied.subjects[0].findings.find(
      (finding) => finding.code === WAIVER_REASON.WAIVER_WINDOW_UNJUDGED
    );
    expect(unjudged).toBeDefined();
    expect(unjudged.severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    expect(applied.subjects[0].disposition).toBe(WAIVER_DISPOSITION.UNWAIVED);
  });

  it('reports a waiver broader than the constraint it excepts', () => {
    // The travel constraint is global (rank 0), so nothing is broader than it;
    // a venue-scoped constraint (rank 2) beaten by a date-range waiver (rank 1)
    // is the repeal-in-disguise case.
    const venueScoped = buildConstraintRegistry({
      name: 'venue scoped',
      constraints: registry.constraints.map((record) =>
        record.id === SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK
          ? { ...record, waivable: true }
          : record
      ),
    });
    const ledger = ledgerOf(
      makeWaiver({
        constraintId: SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK,
        scope: { fromDate: '2026-08-01', toDate: '2026-11-30' },
      })
    );
    const applied = applyWaivers(
      [
        {
          id: 's1',
          context: { date: '2026-09-12' },
          findings: [
            {
              code: 'SOME_TURNOVER_CODE',
              severity: WAIVER_SEVERITY.BLOCKING,
              message: 'too tight',
              details: {},
            },
          ],
        },
      ],
      {
        ledger,
        registry: venueScoped,
        constraintIdByCode: { SOME_TURNOVER_CODE: SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK },
      }
    );
    const broader = applied.subjects[0].findings.find(
      (finding) => finding.code === WAIVER_REASON.WAIVER_BROADER_THAN_CONSTRAINT
    );
    expect(broader).toBeDefined();
    expect(broader.severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    // It is still applied — the operator wrote it down — but nobody gets to be
    // surprised by it later.
    expect(applied.subjects[0].disposition).toBe(WAIVER_DISPOSITION.WAIVED);
  });
});

/* -------------------------------------------------------------------------- */
/* Applying the ledger                                                          */
/* -------------------------------------------------------------------------- */

describe('applying waivers', () => {
  const blockingSubject = () =>
    subjectWith('s1', TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT, WAIVER_SEVERITY.BLOCKING, {
      date: '2026-08-22',
      personId: 'person-1',
    });

  it('keeps the violation, demotes it, and stamps who signed it off', () => {
    const applied = applyWaivers([blockingSubject()], {
      ledger: ledgerOf(makeWaiver()),
      registry,
      constraintIdByCode: travelLinks,
    });
    const subject = applied.subjects[0];
    const violation = subject.findings.find(
      (finding) => finding.code === TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT
    );
    // Demoted, never deleted.
    expect(violation).toBeDefined();
    expect(violation.severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    expect(violation.details.waived).toBe(true);
    expect(violation.details.waiverId).toBe('test-waiver');
    expect(violation.details.waivedBy).toBe('the test suite');
    expect(violation.details.severityBeforeWaiver).toBe(WAIVER_SEVERITY.BLOCKING);
    expect(subject.findings.map((finding) => finding.code)).toContain(WAIVER_REASON.WAIVER_APPLIED);
    expect(applied.meta.findingsWaived).toBe(1);
    expect(applied.meta.subjectsExamined).toBe(1);
    expect(applied.meta.findingsExamined).toBe(1);
  });

  it('reports "waived" and "clean" as different answers with the same status', () => {
    const waived = applyWaivers([blockingSubject()], {
      ledger: ledgerOf(makeWaiver()),
      registry,
      constraintIdByCode: travelLinks,
    }).subjects[0];
    const ordinary = applyWaivers(
      [subjectWith('s2', 'SOMETHING_ELSE', WAIVER_SEVERITY.COMPROMISE, { date: '2026-08-22' })],
      { ledger: ledgerOf(makeWaiver()), registry, constraintIdByCode: travelLinks }
    ).subjects[0];

    // Identical three-state status...
    expect(waived.status).toBe(WAIVER_STATUS.COMPROMISED);
    expect(ordinary.status).toBe(WAIVER_STATUS.COMPROMISED);
    // ...and entirely different dispositions. This is the requirement.
    expect(waived.disposition).toBe(WAIVER_DISPOSITION.WAIVED);
    expect(ordinary.disposition).toBe(WAIVER_DISPOSITION.UNWAIVED);
    expect(isWaived(waived)).toBe(true);
    expect(isWaived(ordinary)).toBe(false);
    // And a waived subject is never `allowed`, whatever else is true of it.
    expect(waived.status).not.toBe(WAIVER_STATUS.ALLOWED);
  });

  it('never applies a waiver of a constraint nobody may waive', () => {
    const applied = applyWaivers([blockingSubject()], {
      ledger: ledgerOf(makeWaiver({ constraintId: SUNSET })),
      registry,
      constraintIdByCode: { [TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT]: SUNSET },
    });
    expect(applied.findings.map((finding) => finding.code)).toContain(
      WAIVER_REASON.WAIVER_CONSTRAINT_NOT_WAIVABLE
    );
    expect(applied.subjects[0].disposition).toBe(WAIVER_DISPOSITION.UNWAIVED);
    expect(applied.subjects[0].status).toBe(WAIVER_STATUS.REJECTED);
    expect(applied.status).toBe(WAIVER_STATUS.REJECTED);
  });

  it('reports an uncovered violation of a waivable constraint rather than staying quiet', () => {
    const applied = applyWaivers([blockingSubject()], {
      ledger: EMPTY_LEDGER,
      registry,
      constraintIdByCode: travelLinks,
    });
    const absent = applied.subjects[0].findings.find(
      (finding) => finding.code === WAIVER_REASON.WAIVER_ABSENT
    );
    expect(absent).toBeDefined();
    expect(absent.severity).toBe(WAIVER_SEVERITY.INFO);
    expect(applied.subjects[0].disposition).toBe(WAIVER_DISPOSITION.UNWAIVED);
  });

  it('mixes waived and unwaived violations into "waived-partial"', () => {
    const subject = {
      id: 's1',
      context: { date: '2026-08-22', personId: 'person-1' },
      findings: [
        {
          code: TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT,
          severity: WAIVER_SEVERITY.BLOCKING,
          message: 'travel',
          details: {},
        },
        {
          code: 'UNRELATED_PROBLEM',
          severity: WAIVER_SEVERITY.BLOCKING,
          message: 'unrelated',
          details: {},
        },
      ],
    };
    const applied = applyWaivers([subject], {
      ledger: ledgerOf(makeWaiver()),
      registry,
      constraintIdByCode: travelLinks,
    });
    expect(applied.subjects[0].disposition).toBe(WAIVER_DISPOSITION.WAIVED_PARTIAL);
    expect(applied.subjects[0].status).toBe(WAIVER_STATUS.REJECTED);
    expect(applied.subjects[0].waivedCount).toBe(1);
    expect(applied.subjects[0].uncoveredViolationCount).toBe(1);
  });

  it('reports an applier that could not have applied anything', () => {
    // Incident 4: findings exist, waivers exist, and no reason code links to
    // any constraint. An empty delta here must not read as "nothing to waive".
    const applied = applyWaivers(
      [subjectWith('s1', 'A_CODE_NO_CONSTRAINT_CLAIMS', WAIVER_SEVERITY.BLOCKING, {})],
      { ledger: ledgerOf(makeWaiver()), registry }
    );
    const unlinked = applied.findings.find(
      (finding) => finding.code === WAIVER_REASON.WAIVER_APPLY_UNLINKED
    );
    expect(unlinked).toBeDefined();
    expect(unlinked.severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    expect(unlinked.details.findingsExamined).toBe(1);
  });

  it('narrows to named reason codes when the waiver names any', () => {
    const ledger = ledgerOf(makeWaiver({ reasonCodes: ['A_DIFFERENT_CODE'] }));
    const applied = applyWaivers([blockingSubject()], {
      ledger,
      registry,
      constraintIdByCode: travelLinks,
    });
    expect(applied.subjects[0].disposition).toBe(WAIVER_DISPOSITION.UNWAIVED);
  });

  it('produces row annotations a published export can carry', () => {
    const applied = applyWaivers([blockingSubject()], {
      ledger: ledgerOf(makeWaiver()),
      registry,
      constraintIdByCode: travelLinks,
    });
    expect(applied.annotations).toHaveLength(1);
    const annotation = applied.annotations[0];
    expect(annotation.subjectId).toBe('s1');
    expect(annotation.waiverId).toBe('test-waiver');
    expect(annotation.constraintId).toBe(TRAVEL);
    expect(annotation.reasonCodes).toEqual([TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT]);
    expect(annotation.approvedBy).toBe('the test suite');
    expect(annotation.note).toContain('Waived');
    expect(annotation.note).toContain('the test suite');

    expect(Object.keys(annotationsBySubject(applied))).toEqual(['s1']);
    const notes = waiverNotesBySubject(applied);
    expect(notes.s1).toBe(annotation.note);
    // Subjects with no waiver are absent rather than empty-stringed.
    expect(notes.s2).toBeUndefined();
    expect(mergeWaiverNote('Field change', notes.s1)).toContain('Field change');
    expect(mergeWaiverNote('', notes.s1)).toBe(notes.s1);
    expect(mergeWaiverNote('Field change', undefined)).toBe('Field change');
  });
});

/* -------------------------------------------------------------------------- */
/* The narrow coach-travel evaluator                                            */
/* -------------------------------------------------------------------------- */

describe('the narrow coach-travel evaluator', () => {
  /** Codes of a finding list, for terse assertions. */
  const codesOf = (findings) => findings.map((finding) => finding.code);
  const commitment = (overrides) => ({
    id: 'c1',
    personId: 'coach-a',
    date: '2026-08-22',
    startMinutes: 600,
    endMinutes: 645,
    venueId: 'venue-one',
    ...overrides,
  });

  it('takes its floor from the registry rather than carrying one', () => {
    const result = evaluateCoachTravel(
      [
        commitment({}),
        commitment({ id: 'c2', startMinutes: 675, endMinutes: 720, venueId: 'venue-two' }),
      ],
      { registry }
    );
    expect(result.meta.transitionsJudged).toBe(1);
    const record = requireConstraint(registry, TRAVEL);
    expect(result.transitions[0].minimumGapMinutes).toBe(record.parameters.minimumGapMinutes);
    expect(result.transitions[0].policy).toBe(TRAVEL_POLICY.BETWEEN_VENUES);
    expect(result.transitions[0].gapMinutes).toBe(30);
    const violation = result.findings.find(
      (finding) => finding.code === TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT
    );
    expect(violation.details.shortfallMinutes).toBe(
      /** @type {number} */ (record.parameters.minimumGapMinutes) - 30
    );
  });

  it('takes its severity from the constraint record’s hardness (GAP-12)', () => {
    const commitments = [
      commitment({}),
      commitment({ id: 'c2', startMinutes: 675, endMinutes: 720, venueId: 'venue-two' }),
    ];
    const record = requireConstraint(registry, TRAVEL);
    expect(record.type).toBe(CONSTRAINT_TYPE.SOFT);
    const soft = evaluateCoachTravel(commitments, { registry });
    expect(soft.status).toBe(CONSTRAINT_STATUS.COMPROMISED);

    const hardened = retypeConstraint(registry, TRAVEL, {
      type: CONSTRAINT_TYPE.HARD,
      weight: null,
      by: 'tests/waiverLedger.test.js',
      note: 'the same rule, harder, to show the severity follows the record',
    });
    const hard = evaluateCoachTravel(commitments, { registry: hardened });
    expect(hard.status).toBe(CONSTRAINT_STATUS.REJECTED);
    // Same code, same data, different severity — and not a line of this
    // evaluator changed.
    expect(soft.findings[0].code).toBe(hard.findings[0].code);
    expect(soft.findings[0].severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    expect(hard.findings[0].severity).toBe(WAIVER_SEVERITY.BLOCKING);
  });

  it('applies the within-venue policy to a move between fields on one site', () => {
    const result = evaluateCoachTravel(
      [commitment({}), commitment({ id: 'c2', startMinutes: 650, endMinutes: 700 })],
      { registry }
    );
    expect(result.transitions[0].policy).toBe(TRAVEL_POLICY.WITHIN_VENUE);
    expect(result.transitions[0].minimumGapMinutes).toBe(
      requireConstraint(registry, SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_WITHIN_VENUE).parameters
        .minimumGapMinutes
    );
    expect(result.findings.map((finding) => finding.code)).toContain(
      TRAVEL_REASON.TRAVEL_WITHIN_VENUE_TOO_SHORT
    );
  });

  /**
   * The regression that this whole model exists for.
   *
   * Before venue complexes, the walking floor could only ever fire for two
   * commitments at the *identical* venue id, so for a move between two named
   * venues it was unreachable code. These two tests prove it is reachable now:
   * the same pair of commitments, judged under two different declarations,
   * takes two different floors — and under the complex it can still be short.
   */
  const complexOfTwo = buildVenueComplexMap({
    complexes: [
      {
        id: 'one-park',
        name: 'One Park',
        venueIds: ['venue-one', 'venue-two'],
        note: 'the two ends of one site',
        source: 'tests/waiverLedger.test.js',
      },
    ],
  });

  it('judges two venues in one complex against the walking floor, not the drive floor', () => {
    // 30 minutes: short of the 60-minute drive floor, comfortably over the
    // 15-minute walk. The declaration is the only thing that changes.
    const commitments = [
      commitment({}),
      commitment({ id: 'c2', startMinutes: 675, endMinutes: 720, venueId: 'venue-two' }),
    ];
    const apart = evaluateCoachTravel(commitments, { registry });
    const together = evaluateCoachTravel(commitments, {
      registry,
      venueComplexes: complexOfTwo,
    });

    expect(apart.meta.withinComplexTransitions).toBe(0);
    expect(together.meta.withinComplexTransitions).toBe(1);
    expect(together.meta.crossVenueTransitions).toBe(1);

    expect(apart.transitions[0].policy).toBe(TRAVEL_POLICY.BETWEEN_VENUES);
    expect(together.transitions[0].policy).toBe(TRAVEL_POLICY.WITHIN_VENUE);
    expect(apart.transitions[0].minimumGapMinutes).toBe(60);
    expect(together.transitions[0].minimumGapMinutes).toBe(15);
    expect(together.transitions[0].sameVenue).toBe(false);
    expect(together.transitions[0].sameComplex).toBe(true);
    expect(together.transitions[0].complexId).toBe('one-park');

    // The verdict flips, and the reason it flipped is reported rather than
    // implied by the absence of a violation.
    expect(codesOf(apart.findings)).toContain(TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT);
    expect(codesOf(together.findings)).not.toContain(TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT);
    const context = together.findings.find(
      (finding) => finding.code === TRAVEL_REASON.TRAVEL_WITHIN_COMPLEX_CROSS_VENUE
    );
    expect(context).toBeDefined();
    expect(context.severity).toBe(WAIVER_SEVERITY.INFO);
    expect(context.details).toMatchObject({
      complexId: 'one-park',
      fromVenueId: 'venue-one',
      toVenueId: 'venue-two',
      gapMinutes: 30,
    });
    // `info` is provenance: it does not move the status.
    expect(together.status).toBe(CONSTRAINT_STATUS.ALLOWED);
    expect(together.meta.violationsFound).toBe(0);
  });

  it('lets the 15-minute walking floor actually fire between two named venues', () => {
    // Ten minutes to cross a complex. Under the old venue-name test this pair
    // could only ever have been judged against 60 minutes; the walking rule was
    // dead code for it.
    const result = evaluateCoachTravel(
      [
        commitment({}),
        commitment({ id: 'c2', startMinutes: 655, endMinutes: 700, venueId: 'venue-two' }),
      ],
      { registry, venueComplexes: complexOfTwo }
    );
    expect(result.meta.withinComplexTransitions).toBe(1);
    expect(result.meta.violationsFound).toBe(1);
    const violation = result.findings.find(
      (finding) => finding.code === TRAVEL_REASON.TRAVEL_WITHIN_VENUE_TOO_SHORT
    );
    expect(violation).toBeDefined();
    expect(violation.details).toMatchObject({
      policy: TRAVEL_POLICY.WITHIN_VENUE,
      gapMinutes: 10,
      minimumGapMinutes: 15,
      shortfallMinutes: 5,
      // The distinction a reader needs: one site, two names.
      sameVenue: false,
      complexId: 'one-park',
      constraintId: SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_WITHIN_VENUE,
    });
    expect(violation.severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    expect(result.status).toBe(CONSTRAINT_STATUS.COMPROMISED);
    // …and the context note rides along, so the 15 is explained.
    expect(codesOf(result.findings)).toContain(TRAVEL_REASON.TRAVEL_WITHIN_COMPLEX_CROSS_VENUE);
  });

  it('defaults to no complexes, which is exactly venue-name equality', () => {
    const commitments = [
      commitment({}),
      commitment({ id: 'c2', startMinutes: 675, endMinutes: 720, venueId: 'venue-two' }),
    ];
    const defaulted = evaluateCoachTravel(commitments, { registry });
    const explicit = evaluateCoachTravel(commitments, {
      registry,
      venueComplexes: EMPTY_VENUE_COMPLEX_MAP,
    });
    expect(codesOf(defaulted.findings)).toEqual(codesOf(explicit.findings));
    expect(defaulted.transitions[0].policy).toBe(explicit.transitions[0].policy);
    expect(defaulted.transitions[0].sameComplex).toBe(false);
    expect(defaulted.transitions[0].complexId).toBeNull();
    // The season's own map is not empty, so the default is a real choice.
    expect(buildSeason2026VenueComplexMap().stats.complexCount).toBeGreaterThan(0);
  });

  it('keeps an overlap at its fixed severity whatever the record says', () => {
    const softened = retypeConstraint(registry, TRAVEL, {
      type: CONSTRAINT_TYPE.PREFERENCE,
      weight: 1,
      by: 'tests/waiverLedger.test.js',
      note: 'no hardness makes a person able to be in two places at once',
    });
    const result = evaluateCoachTravel(
      [
        commitment({}),
        commitment({ id: 'c2', startMinutes: 620, endMinutes: 700, venueId: 'venue-two' }),
      ],
      { registry: softened }
    );
    const overlap = result.findings.find(
      (finding) => finding.code === TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP
    );
    // Compromise since #61 (allowed with a warning) — and fixed: the PREFERENCE
    // record would read `info` if it were allowed to decide.
    expect(overlap.severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    expect(travelSeverityOf(TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP, null)).toBe(
      TRAVEL_REASON_SEVERITY[TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP]
    );
  });

  it('refuses to measure a gap after a commitment of unknown length', () => {
    const result = evaluateCoachTravel(
      [
        commitment({ endMinutes: null }),
        commitment({ id: 'c2', startMinutes: 675, endMinutes: 720, venueId: 'venue-two' }),
      ],
      { registry }
    );
    expect(result.meta.transitionsExamined).toBe(1);
    expect(result.meta.transitionsJudged).toBe(0);
    const unknown = result.findings.find(
      (finding) => finding.code === TRAVEL_REASON.TRAVEL_FOOTPRINT_UNKNOWN
    );
    expect(unknown.severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    expect(result.status).toBe(CONSTRAINT_STATUS.COMPROMISED);
  });

  it('reports a scan that found nothing to judge', () => {
    const result = evaluateCoachTravel([commitment({})], { registry });
    expect(result.meta.transitionsExamined).toBe(0);
    const vacuous = result.findings.find(
      (finding) => finding.code === TRAVEL_REASON.TRAVEL_SCAN_VACUOUS
    );
    expect(vacuous).toBeDefined();
    expect(vacuous.severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    expect(vacuous.details.commitmentsExamined).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The acceptance test — incident 9, derived from the corpus                    */
/* -------------------------------------------------------------------------- */

/**
 * > *Acceptance test using the fixture: with the coach's rec game ending
 * > 11:10am at one venue and his league game at 12:00pm at another, the
 * > 50-minute gap fails the 60-minute rule, passes with the waiver applied, and
 * > is reported as "waived, not clean." When the same fixture is re-solved with
 * > the league game at 12:30pm, the waiver is reported dormant.*
 *
 * Everything below is found in the corpus rather than typed in. The search is
 * for the shape incident 9 describes — one person, two venues on one day, a gap
 * under the travel floor, where the later fixture is one the external league
 * also published — and the first assertion is that the corpus contains exactly
 * **one** such day. If it contained none the suite would fail loudly rather
 * than test an invented scenario; if it contained several, "the coach" in the
 * acceptance text would be ambiguous and that too should fail.
 */
const season = loadSeason2026();

/** Every consecutive same-day inter-venue pair on one person's timeline. */
function interVenueTransitions() {
  const found = [];
  for (const [personKey, entries] of season.coachTimelines) {
    for (let index = 0; index < entries.length - 1; index += 1) {
      const from = entries[index];
      const to = entries[index + 1];
      if (from.date !== to.date) continue;
      if (from.game.venue === to.game.venue) continue;
      if (from.endMinutes === null || to.startMinutes === null) continue;
      found.push({ personKey, from, to, gapMinutes: to.startMinutes - from.endMinutes });
    }
  }
  return found;
}

/** The published external kickoff for a fixture, when the league published one. */
function publishedExternalFixture(game) {
  return season.externalFixtures.find(
    (fixture) => fixture.date === game.date && fixture.homeLabel === game.homeTeamId
  );
}

/** A loader timeline entry as a commitment for the travel evaluator. */
function toCommitment(entry, overrides = {}) {
  return {
    id: entry.gameId,
    personId: entry.personKey,
    date: entry.date,
    startMinutes: entry.startMinutes,
    endMinutes: entry.endMinutes,
    venueId: season2026VenueId(entry.game.venue),
    teamId: entry.teamId,
    gameId: entry.gameId,
    ...overrides,
  };
}

/** Clock rendering, for the assertions that quote the acceptance text. */
function clock(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = String(minutes % 60).padStart(2, '0');
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${minute} ${suffix}`;
}

describe('incident 9, end to end', () => {
  const candidates = interVenueTransitions()
    .filter(
      (entry) =>
        entry.gapMinutes <
        /** @type {number} */ (requireConstraint(registry, TRAVEL).parameters.minimumGapMinutes)
    )
    .filter((entry) => publishedExternalFixture(entry.to.game) !== undefined);

  it('finds exactly one coach in the corpus whose day incident 9 describes', () => {
    // Meta-assertion first: a search that matched nothing, or matched five
    // people, must fail rather than quietly pick one (incident 4).
    expect(season.coachTimelines.size).toBeGreaterThan(100);
    expect(candidates).toHaveLength(1);
    const scenario = candidates[0];
    expect(scenario.from.game.venue).not.toBe(scenario.to.game.venue);
    // The corpus's own numbers, quoted back: a rec game ending 11:10 AM at one
    // venue, a league game at 12:00 PM at another, 50 minutes apart.
    expect(clock(scenario.from.endMinutes)).toBe('11:10 AM');
    expect(clock(scenario.to.startMinutes)).toBe('12:00 PM');
    expect(scenario.gapMinutes).toBe(50);
    expect(scenario.from.game.format).not.toBe(scenario.to.game.format);
  });

  const scenario = candidates[0];
  const commitments = [toCommitment(scenario.from), toCommitment(scenario.to)];
  const venueIds = [...new Set(commitments.map((entry) => entry.venueId))].sort();
  const ledger = buildSeason2026WaiverLedger({
    personId: scenario.personKey,
    venueIds,
    subjectSource: 'coach_roster.csv + combined_schedule.csv',
  });

  /** The same registry with the travel floor hardened, so "fails" means rejected. */
  const hardRegistry = retypeConstraint(registry, TRAVEL, {
    type: CONSTRAINT_TYPE.HARD,
    weight: null,
    by: 'tests/waiverLedger.test.js',
    note: 'incident 9 describes a floor that needed a board decision to breach, which is a hard rule for the person it binds; the seeded record is soft and both readings are exercised here',
  });
  const hardLinks = travelConstraintIdByCode(hardRegistry);

  it('seeds the waiver from what the incident log records, and no more', () => {
    const waiver = requireWaiver(ledger, SEASON_2026_WAIVER_ID.COACH_TRAVEL_BOARD_EXCEPTION);
    expect(waiver.constraintId).toBe(TRAVEL);
    expect(waiver.scope.personId).toBe(scenario.personKey);
    expect(waiver.scope.venueIds).toEqual(venueIds);
    expect(waiver.approval.approvedBy).toBe('club board');
    // The log preserves the order of events, not their dates.
    expect(waiver.approval.approvedAt).toBeNull();
    expect(waiver.approval.note).toMatch(/code comment/);
    expect(waiver.parameters.observedTravelMinutes).toBe(INCIDENT_9_OBSERVED_TRAVEL_MINUTES);
    expect(reconcileWaiverLedger(ledger, registry).status).toBe(WAIVER_STATUS.ALLOWED);
    expect(requireConstraint(registry, TRAVEL).waivable).toBe(true);
  });

  it('fails the 60-minute rule without the waiver', () => {
    const travel = evaluateCoachTravel(commitments, { registry: hardRegistry });
    expect(travel.meta.transitionsJudged).toBe(1);
    const transition = travel.transitions[0];
    expect(transition.gapMinutes).toBe(scenario.gapMinutes);
    expect(transition.minimumGapMinutes).toBe(60);
    expect(transition.gapMinutes).toBeLessThan(transition.minimumGapMinutes);

    const unwaived = applyWaivers(travel.subjects, {
      ledger: EMPTY_LEDGER,
      registry: hardRegistry,
      constraintIdByCode: hardLinks,
    });
    expect(unwaived.meta.subjectsExamined).toBe(1);
    expect(unwaived.meta.findingsExamined).toBe(1);
    expect(unwaived.subjects[0].status).toBe(WAIVER_STATUS.REJECTED);
    expect(unwaived.subjects[0].disposition).toBe(WAIVER_DISPOSITION.UNWAIVED);
  });

  it('passes with the waiver applied, and is reported "waived, not clean"', () => {
    const travel = evaluateCoachTravel(commitments, { registry: hardRegistry });
    const waived = applyWaivers(travel.subjects, {
      ledger,
      registry: hardRegistry,
      constraintIdByCode: hardLinks,
    });
    const subject = waived.subjects[0];

    // Passes: no longer rejected.
    expect(subject.statusWithoutWaivers).toBe(WAIVER_STATUS.REJECTED);
    expect(subject.status).toBe(WAIVER_STATUS.COMPROMISED);
    // Not clean: never `allowed`, and the disposition says why.
    expect(subject.status).not.toBe(WAIVER_STATUS.ALLOWED);
    expect(subject.disposition).toBe(WAIVER_DISPOSITION.WAIVED);
    expect(subject.disposition).not.toBe(WAIVER_DISPOSITION.CLEAN);
    expect(isWaived(subject)).toBe(true);

    // And it is visible in the finding, not only in the status string.
    const violation = subject.findings.find(
      (finding) => finding.code === TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT
    );
    expect(violation.details.waived).toBe(true);
    expect(violation.details.severityBeforeWaiver).toBe(WAIVER_SEVERITY.BLOCKING);
    expect(violation.details.waivedBy).toBe('club board');
    expect(violation.details.gapMinutes).toBe(scenario.gapMinutes);
    const applied = subject.findings.find(
      (finding) => finding.code === WAIVER_REASON.WAIVER_APPLIED
    );
    expect(applied.details.waiverId).toBe(SEASON_2026_WAIVER_ID.COACH_TRAVEL_BOARD_EXCEPTION);

    // The published row carries it.
    const notes = waiverNotesBySubject(waived);
    expect(Object.keys(notes)).toHaveLength(1);
    expect(notes[subject.id]).toContain('club board');
    expect(notes[subject.id]).toContain('five minutes apart');
  });

  it('reports the same waiver as waived rather than clean under the seeded soft record', () => {
    // The seeded record is `soft`, so the gap is a compromise rather than a
    // rejection. The status is therefore the same with and without the waiver
    // — which is exactly the case where a boolean would hide everything and
    // the disposition does not.
    const travel = evaluateCoachTravel(commitments, { registry });
    const withWaiver = applyWaivers(travel.subjects, {
      ledger,
      registry,
      constraintIdByCode: travelLinks,
    }).subjects[0];
    const without = applyWaivers(travel.subjects, {
      ledger: EMPTY_LEDGER,
      registry,
      constraintIdByCode: travelLinks,
    }).subjects[0];

    expect(withWaiver.status).toBe(WAIVER_STATUS.COMPROMISED);
    expect(without.status).toBe(WAIVER_STATUS.COMPROMISED);
    expect(withWaiver.disposition).toBe(WAIVER_DISPOSITION.WAIVED);
    expect(without.disposition).toBe(WAIVER_DISPOSITION.UNWAIVED);
  });

  it('does not apply the waiver to a different coach or a third venue', () => {
    const travel = evaluateCoachTravel(commitments, { registry: hardRegistry });
    const otherCoach = travel.subjects.map((subject) => ({
      ...subject,
      context: { ...subject.context, personId: 'somebody else', personIds: undefined },
    }));
    const applied = applyWaivers(otherCoach, {
      ledger,
      registry: hardRegistry,
      constraintIdByCode: hardLinks,
    });
    expect(applied.subjects[0].disposition).toBe(WAIVER_DISPOSITION.UNWAIVED);
    expect(applied.subjects[0].status).toBe(WAIVER_STATUS.REJECTED);
    expect(applied.meta.waiversOutOfScope).toBe(1);
  });

  it('reports the waiver load-bearing while the fixture kicks off at 12:00', () => {
    const travel = evaluateCoachTravel(commitments, { registry: hardRegistry });
    const dormancy = detectDormantWaivers(travel.subjects, {
      ledger,
      registry: hardRegistry,
      constraintIdByCode: hardLinks,
    });
    expect(dormancy.meta.subjectsExamined).toBeGreaterThan(0);
    expect(dormancy.meta.dormancyProbes).toBe(1);
    expect(dormancy.dormantWaiverIds).toEqual([]);
    expect(dormancy.loadBearingWaiverIds).toEqual([
      SEASON_2026_WAIVER_ID.COACH_TRAVEL_BOARD_EXCEPTION,
    ]);

    const verdict = dormancy.waivers[0];
    expect(verdict.dormant).toBe(false);
    expect(verdict.loadBearing).toBe(true);
    expect(verdict.changesStatus).toBe(true);
    expect(verdict.retirementCandidate).toBe(false);
    expect(verdict.appliedCount).toBe(1);
    expect(verdict.reason).toBe(DORMANCY_REASON.LOAD_BEARING);
    expect(verdict.statusDeltas).toEqual([
      {
        id: travel.subjects[0].id,
        statusWith: WAIVER_STATUS.COMPROMISED,
        statusWithout: WAIVER_STATUS.REJECTED,
      },
    ]);
    expect(dormancy.findings).toEqual([]);
  });

  it('reports the waiver dormant when the fixture moves back to its published 12:30', () => {
    // Not an invented counterfactual: `external_fixtures_published.csv` is the
    // external league's own publication of this fixture, and the final
    // agreement moved it 30 minutes earlier (incident 3). Re-solving against
    // the published time is re-solving against a real row in a real file.
    const published = publishedExternalFixture(scenario.to.game);
    expect(published).toBeDefined();
    expect(clock(published.kickoffMinutes)).toBe('12:30 PM');
    expect(published.kickoffMinutes).toBeGreaterThan(scenario.to.startMinutes);

    const duration = scenario.to.endMinutes - scenario.to.startMinutes;
    const shifted = [
      toCommitment(scenario.from),
      toCommitment(scenario.to, {
        startMinutes: published.kickoffMinutes,
        endMinutes: published.kickoffMinutes + duration,
      }),
    ];

    const travel = evaluateCoachTravel(shifted, { registry: hardRegistry });
    expect(travel.meta.transitionsJudged).toBe(1);
    expect(travel.transitions[0].gapMinutes).toBe(
      published.kickoffMinutes - scenario.from.endMinutes
    );
    expect(travel.transitions[0].gapMinutes).toBeGreaterThanOrEqual(
      travel.transitions[0].minimumGapMinutes
    );
    expect(travel.status).toBe(CONSTRAINT_STATUS.ALLOWED);

    const dormancy = detectDormantWaivers(travel.subjects, {
      ledger,
      registry: hardRegistry,
      constraintIdByCode: hardLinks,
    });
    // Meta-assertion: the scan looked at a real subject. "Every waiver is
    // dormant" over an empty scan is incident 4, and is reported as such.
    expect(dormancy.meta.subjectsExamined).toBe(1);
    expect(dormancy.findings.map((finding) => finding.code)).not.toContain(
      WAIVER_REASON.WAIVER_SCAN_VACUOUS
    );

    expect(dormancy.dormantWaiverIds).toEqual([SEASON_2026_WAIVER_ID.COACH_TRAVEL_BOARD_EXCEPTION]);
    const verdict = dormancy.waivers[0];
    expect(verdict.dormant).toBe(true);
    expect(verdict.loadBearing).toBe(false);
    expect(verdict.appliedCount).toBe(0);
    expect(verdict.reason).toBe(DORMANCY_REASON.NEVER_MATCHED);
    expect(verdict.retirementCandidate).toBe(true);
    const dormant = dormancy.findings.find(
      (finding) => finding.code === WAIVER_REASON.WAIVER_DORMANT
    );
    expect(dormant.severity).toBe(WAIVER_SEVERITY.INFO);
    expect(dormant.details.subjectsExamined).toBe(1);
    expect(dormancy.status).toBe(WAIVER_STATUS.ALLOWED);
  });

  it('brings the same waiver back to life when the times shift again', () => {
    // The third act of incident 9: the waiver became unnecessary, then
    // relevant again, without a character of the record changing. Nothing is
    // cached, so nothing has to be invalidated.
    const travel = evaluateCoachTravel(commitments, { registry: hardRegistry });
    const again = detectDormantWaivers(travel.subjects, {
      ledger,
      registry: hardRegistry,
      constraintIdByCode: hardLinks,
    });
    expect(again.waivers[0].dormant).toBe(false);
    expect(again.waivers[0].appliedCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Dormancy detection in general                                                */
/* -------------------------------------------------------------------------- */

describe('dormancy detection', () => {
  const violation = (id) =>
    subjectWith(id, TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT, WAIVER_SEVERITY.BLOCKING, {
      date: '2026-08-22',
      personId: 'person-1',
    });

  it('reports a scan over no subjects rather than calling every waiver dormant', () => {
    const report = detectDormantWaivers([], {
      ledger: ledgerOf(makeWaiver()),
      registry,
      constraintIdByCode: travelLinks,
    });
    const vacuous = report.findings.find(
      (finding) => finding.code === WAIVER_REASON.WAIVER_SCAN_VACUOUS
    );
    expect(vacuous).toBeDefined();
    expect(vacuous.severity).toBe(WAIVER_SEVERITY.COMPROMISE);
    expect(report.status).toBe(WAIVER_STATUS.COMPROMISED);
  });

  it('separates "covered nothing" from "covered something nobody depends on"', () => {
    // The violation is a plain `compromise` here, so waiving it changes no
    // verdict — weaker than dormant, and still a retirement candidate.
    const softViolation = subjectWith(
      's1',
      TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT,
      WAIVER_SEVERITY.COMPROMISE,
      { date: '2026-08-22', personId: 'person-1' }
    );
    const report = detectDormantWaivers([softViolation], {
      ledger: ledgerOf(makeWaiver()),
      registry,
      constraintIdByCode: travelLinks,
    });
    const verdict = report.waivers[0];
    expect(verdict.dormant).toBe(false);
    expect(verdict.appliedCount).toBe(1);
    expect(verdict.changesStatus).toBe(false);
    expect(verdict.retirementCandidate).toBe(true);
    expect(verdict.reason).toBe(DORMANCY_REASON.NOT_STATUS_BEARING);
    expect(report.findings.map((finding) => finding.code)).toContain(
      WAIVER_REASON.WAIVER_NOT_STATUS_BEARING
    );
    expect(report.retirementCandidateIds).toEqual(['test-waiver']);
    expect(report.dormantWaiverIds).toEqual([]);
  });

  it('judges each waiver against the ledger minus itself, not against an empty one', () => {
    // Two waivers covering the same violation: neither is load-bearing on its
    // own, and a scan that removed both at once would call both essential.
    const ledger = ledgerOf(
      makeWaiver({ id: 'waiver-a' }),
      makeWaiver({ id: 'waiver-b', reason: 'a second, redundant approval' })
    );
    const report = detectDormantWaivers([violation('s1')], {
      ledger,
      registry,
      constraintIdByCode: travelLinks,
    });
    expect(report.meta.dormancyProbes).toBe(2);
    const [a, b] = report.waivers;
    // Only one of them can have covered the finding; the other covered nothing
    // and is dormant, which is the honest answer for a redundant approval.
    expect(a.appliedCount + b.appliedCount).toBe(1);
    expect(report.dormantWaiverIds).toHaveLength(1);
    // Removing the one that fired leaves the other to cover it, so no verdict
    // changes and neither is status-bearing.
    expect(a.changesStatus).toBe(false);
    expect(b.changesStatus).toBe(false);
  });

  it('carries meta counters proving the scan examined records', () => {
    const report = detectDormantWaivers([violation('s1'), violation('s2')], {
      ledger: ledgerOf(makeWaiver()),
      registry,
      constraintIdByCode: travelLinks,
    });
    expect(report.meta.subjectsExamined).toBe(2);
    expect(report.meta.findingsExamined).toBe(2);
    expect(report.meta.findingsWaived).toBe(2);
    expect(report.meta.dormancyProbes).toBe(1);
    expect(report.waivers[0].subjectIds).toEqual(['s1', 's2']);
  });
});
