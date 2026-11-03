/**
 * Tests for the constraint registry (`packages/core/src/constraints/`).
 *
 * The seeded set is loaded once at module scope and **every expectation about
 * it is derived from the corpus or from the Phase 1 severity tables**, never
 * typed in as a literal that could drift: the Orchard Park venue id comes from
 * the geometry adapter, the reason codes come from the three `*_REASON` enums,
 * and the claim "seeding changes no Phase 1 severity" is checked against
 * `BASE_REASON_SEVERITY` rather than asserted.
 *
 * Meta-assertion discipline (incident 4 in `fixtures/season-2026/README.md`):
 * every behavioural check also asserts it examined a non-zero number of
 * records. `meta.constraintsConsidered > 0` and `overrides.length > 0` matter
 * most — a registry that had quietly lost its records would make "nothing was
 * overridden" pass for exactly the wrong reason.
 *
 * The gaps under test:
 *   GAP-12 constraint hardness and scope (above all) · GAP-24 division labels
 *   are not a key · GAP-26 waivers as records (the `waivable` flag only; the
 *   lifecycle is Phase 2.2).
 */

import { describe, it, expect } from 'vitest';

import { AVAILABILITY_REASON } from '@squadlogic/core/availability/index.js';
import { FACILITY_REASON, season2026VenueId } from '@squadlogic/core/facility/index.js';
import { TIMING_REASON } from '@squadlogic/core/timing/index.js';

import {
  BASE_REASON_SEVERITY,
  CONSTRAINT_ENFORCEMENT,
  CONSTRAINT_REASON,
  CONSTRAINT_SCOPE_KIND,
  CONSTRAINT_SCOPE_SPECIFICITY,
  CONSTRAINT_SEVERITY,
  CONSTRAINT_STATUS,
  CONSTRAINT_TYPE,
  ConstraintRecordSchema,
  ORCHARD_PARK_VENUE_ID,
  SEASON_2026_CONSTRAINTS,
  SEASON_2026_CONSTRAINT_ID,
  activeConstraintsOn,
  applyRegistrySeverity,
  baseSeverityOf,
  buildConstraintRegistry,
  buildSeason2026ConstraintRegistry,
  constraintsForPolicy,
  effectiveSeverityTable,
  getConstraint,
  governedReasonCodes,
  isKnownReasonCode,
  makeConstraintFinding,
  requireConstraint,
  resolveConstraints,
  resolvePolicy,
  retypeConstraint,
  severityForType,
  severityMatrixFor,
  specificityOf,
  whatIfConstraintType,
} from '@squadlogic/core/constraints/index.js';

/* -------------------------------------------------------------------------- */
/* The seeded registry, built once                                             */
/* -------------------------------------------------------------------------- */

const seeded = buildSeason2026ConstraintRegistry();

const ADJACENCY = SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY;
const SAME_GROUND = SEASON_2026_CONSTRAINT_ID.FIELD_SAME_GROUND_EXCLUSIVE;

/** A minimal valid record, so each test states only what it is about. */
function makeRecord(overrides = {}) {
  return {
    id: 'test-constraint',
    policy: 'test-policy',
    name: 'A constraint under test',
    type: CONSTRAINT_TYPE.HARD,
    scope: { kind: CONSTRAINT_SCOPE_KIND.GLOBAL },
    parameters: {},
    restrictiveDirection: 'none',
    rationale: 'because the test says so',
    source: {
      setBy: 'the test suite',
      setAt: '2026-08-22',
      reference: 'tests/constraintRegistry.test.js',
    },
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: null,
    waivable: false,
    ...overrides,
  };
}

/** A registry holding exactly the given records. */
function registryOf(...records) {
  return buildConstraintRegistry({ name: 'test', constraints: records });
}

/* -------------------------------------------------------------------------- */
/* The merged base severity table                                              */
/* -------------------------------------------------------------------------- */

describe('the base severity table', () => {
  it('collects every reason code the four modules register', () => {
    const codes = Object.keys(BASE_REASON_SEVERITY);
    // Meta-assertion: a table that had failed to import a module would make
    // every "the registry governs this code" test below pass vacuously.
    expect(codes.length).toBeGreaterThan(50);
    for (const code of Object.values(FACILITY_REASON)) {
      expect(codes).toContain(code);
    }
    for (const code of Object.values(TIMING_REASON)) {
      expect(codes).toContain(code);
    }
    for (const code of Object.values(AVAILABILITY_REASON)) {
      expect(codes).toContain(code);
    }
    for (const code of Object.values(CONSTRAINT_REASON)) {
      expect(codes).toContain(code);
    }
  });

  it('agrees with each module about the codes it owns', () => {
    let compared = 0;
    for (const code of Object.values(FACILITY_REASON)) {
      expect(BASE_REASON_SEVERITY[code]).toBeTruthy();
      compared += 1;
    }
    expect(compared).toBeGreaterThan(10);
    expect(baseSeverityOf(FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP)).toBe(
      CONSTRAINT_SEVERITY.BLOCKING
    );
    expect(baseSeverityOf(FACILITY_REASON.LINING_MISMATCH)).toBe(CONSTRAINT_SEVERITY.COMPROMISE);
  });

  it('refuses an unregistered code rather than defaulting it to info', () => {
    expect(isKnownReasonCode('NOT_A_REAL_CODE')).toBe(false);
    expect(() => baseSeverityOf('NOT_A_REAL_CODE')).toThrow(/not registered/);
  });

  it('maps each constraint type to exactly one severity', () => {
    expect(severityForType(CONSTRAINT_TYPE.HARD)).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(severityForType(CONSTRAINT_TYPE.SOFT)).toBe(CONSTRAINT_SEVERITY.COMPROMISE);
    expect(severityForType(CONSTRAINT_TYPE.PREFERENCE)).toBe(CONSTRAINT_SEVERITY.INFO);
    expect(() => severityForType('inviolable-ish')).toThrow(/no registered severity/);
  });
});

/* -------------------------------------------------------------------------- */
/* Schema discipline                                                           */
/* -------------------------------------------------------------------------- */

describe('the constraint record schema', () => {
  it('is strict: an unrecognised key is an error, not a passenger', () => {
    expect(() => ConstraintRecordSchema.parse(makeRecord({ hardness: 'very' }))).toThrow();
  });

  it('requires a scope to name exactly one dimension', () => {
    expect(() =>
      ConstraintRecordSchema.parse(makeRecord({ scope: { kind: CONSTRAINT_SCOPE_KIND.VENUE } }))
    ).toThrow(/must carry venueId/);
    expect(() =>
      ConstraintRecordSchema.parse(
        makeRecord({
          scope: { kind: CONSTRAINT_SCOPE_KIND.VENUE, venueId: 'v1', date: '2026-08-22' },
        })
      )
    ).toThrow(/exactly one dimension/);
  });

  it('refuses a date range that ends before it starts', () => {
    expect(() =>
      ConstraintRecordSchema.parse(
        makeRecord({
          scope: {
            kind: CONSTRAINT_SCOPE_KIND.DATE_RANGE,
            fromDate: '2026-10-01',
            toDate: '2026-09-01',
          },
        })
      )
    ).toThrow(/must not end before it starts/);
  });

  it('refuses a constraint that expires before it takes effect', () => {
    expect(() =>
      ConstraintRecordSchema.parse(
        makeRecord({ effectiveFrom: '2026-10-01', effectiveTo: '2026-09-01' })
      )
    ).toThrow(/must not expire before it takes effect/);
  });

  it('ties weight to hardness in both directions', () => {
    expect(() => ConstraintRecordSchema.parse(makeRecord({ weight: 5 }))).toThrow(/no weight/);
    expect(() =>
      ConstraintRecordSchema.parse(makeRecord({ type: CONSTRAINT_TYPE.SOFT, weight: null }))
    ).toThrow(/must state one/);
    expect(() =>
      ConstraintRecordSchema.parse(makeRecord({ type: CONSTRAINT_TYPE.SOFT, weight: 5 }))
    ).toBeTruthy();
  });

  it('refuses a half-wired record in either direction', () => {
    expect(() =>
      ConstraintRecordSchema.parse(
        makeRecord({ enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES, reasonCodes: [] })
      )
    ).toThrow(/at least one code/);
    expect(() =>
      ConstraintRecordSchema.parse(
        makeRecord({
          enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
          reasonCodes: [FACILITY_REASON.OCCUPIED_SAME_SURFACE],
        })
      )
    ).toThrow(/must claim none/);
  });

  it('refuses a source with neither a date nor an explanation for its absence', () => {
    expect(() =>
      ConstraintRecordSchema.parse(
        makeRecord({ source: { setBy: 'someone', reference: 'somewhere' } })
      )
    ).toThrow(/explaining why the date is unknown/);
    expect(() =>
      ConstraintRecordSchema.parse(
        makeRecord({
          source: { setBy: 'someone', reference: 'somewhere', note: 'the log records no date' },
        })
      )
    ).toBeTruthy();
  });

  it('requires a rationale and a citation', () => {
    expect(() => ConstraintRecordSchema.parse(makeRecord({ rationale: '' }))).toThrow();
    expect(() =>
      ConstraintRecordSchema.parse(
        makeRecord({ source: { setBy: 'x', setAt: '2026-08-22', reference: '' } })
      )
    ).toThrow(/cite where it came from/);
  });

  it('refuses the same reason code claimed twice', () => {
    expect(() =>
      ConstraintRecordSchema.parse(
        makeRecord({
          enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
          reasonCodes: [
            FACILITY_REASON.OCCUPIED_SAME_SURFACE,
            FACILITY_REASON.OCCUPIED_SAME_SURFACE,
          ],
        })
      )
    ).toThrow(/same reason code twice/);
  });
});

/* -------------------------------------------------------------------------- */
/* Building a registry                                                         */
/* -------------------------------------------------------------------------- */

describe('building a registry', () => {
  it('treats an empty registry as a loud failure, never a silent pass', () => {
    const empty = buildConstraintRegistry({ name: 'empty', constraints: [] });
    expect(empty.status).toBe(CONSTRAINT_STATUS.REJECTED);
    expect(empty.findings.map((f) => f.code)).toContain(CONSTRAINT_REASON.REGISTRY_EMPTY);
    expect(empty.stats.constraintCount).toBe(0);
  });

  it('rejects a duplicate id rather than letting the loser vanish', () => {
    const registry = registryOf(makeRecord(), makeRecord({ policy: 'other-policy' }));
    expect(registry.status).toBe(CONSTRAINT_STATUS.REJECTED);
    const duplicate = registry.findings.find(
      (f) => f.code === CONSTRAINT_REASON.CONSTRAINT_ID_DUPLICATE
    );
    expect(duplicate).toBeTruthy();
    expect(registry.stats.constraintCount).toBe(1);
    expect(registry.meta.constraintsConsidered).toBe(2);
  });

  it('rejects a claim on a reason code no module registers', () => {
    const registry = registryOf(
      makeRecord({
        enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
        reasonCodes: ['OCCUPIED_SPATIAL_OVERLAPP'],
      })
    );
    expect(registry.status).toBe(CONSTRAINT_STATUS.REJECTED);
    const finding = registry.findings.find(
      (f) => f.code === CONSTRAINT_REASON.CONSTRAINT_REASON_CODE_UNKNOWN
    );
    expect(finding?.details.code).toBe('OCCUPIED_SPATIAL_OVERLAPP');
    expect(registry.stats.governedReasonCodeCount).toBe(0);
  });

  it('says out loud that a declared-only constraint governs nothing yet', () => {
    const registry = registryOf(makeRecord());
    const finding = registry.findings.find(
      (f) => f.code === CONSTRAINT_REASON.CONSTRAINT_DECLARED_ONLY
    );
    expect(finding?.severity).toBe(CONSTRAINT_SEVERITY.INFO);
    expect(registry.status).toBe(CONSTRAINT_STATUS.ALLOWED);
  });

  it('is frozen, so nobody edits a constraint in place', () => {
    const record = requireConstraint(seeded, ADJACENCY);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.scope)).toBe(true);
    expect(Object.isFrozen(record.history)).toBe(true);
    expect(() => {
      record.type = CONSTRAINT_TYPE.PREFERENCE;
    }).toThrow();
  });

  it('never answers a lookup with something off Object.prototype', () => {
    // `byId` and `idsByPolicy` are maps, not objects with a prototype: an id of
    // `toString` must be absent, not a function, and an id of `constructor`
    // must be storable rather than read as a duplicate of Object itself.
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(getConstraint(seeded, inherited), inherited).toBeNull();
      expect(constraintsForPolicy(seeded, inherited), inherited).toEqual([]);
      expect(seeded.idsByReasonCode[inherited], inherited).toBeUndefined();
    }
    const awkward = buildConstraintRegistry({
      name: 'awkward',
      source: 'tests/constraintRegistry.test.js',
      constraints: [
        makeRecord({ id: 'constructor', policy: 'toString' }),
        makeRecord({ id: 'hasOwnProperty', policy: 'toString' }),
      ],
    });
    expect([...awkward.constraintIds].sort()).toEqual(['constructor', 'hasOwnProperty']);
    expect(awkward.findings.map((finding) => finding.code)).not.toContain(
      CONSTRAINT_REASON.CONSTRAINT_ID_DUPLICATE
    );
    expect(getConstraint(awkward, 'constructor')?.id).toBe('constructor');
    expect(constraintsForPolicy(awkward, 'toString').map((record) => record.id)).toEqual([
      'constructor',
      'hasOwnProperty',
    ]);
  });

  it('answers lookups by id and by policy, and names what it holds when it cannot', () => {
    expect(getConstraint(seeded, 'no-such-constraint')).toBeNull();
    expect(() => requireConstraint(seeded, 'no-such-constraint')).toThrow(/no constraint/);
    const turnover = constraintsForPolicy(seeded, 'turnover-minimum');
    expect(turnover.map((r) => r.id).sort()).toEqual([
      SEASON_2026_CONSTRAINT_ID.TURNOVER_FLOOR_GLOBAL,
      SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK,
      SEASON_2026_CONSTRAINT_ID.TURNOVER_PREFERRED_GLOBAL,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The seeded season-2026 set                                                  */
/* -------------------------------------------------------------------------- */

describe('the seeded season-2026 constraint set', () => {
  it('builds clean and holds every constraint the prompt names', () => {
    expect(seeded.status).toBe(CONSTRAINT_STATUS.ALLOWED);
    expect(seeded.stats.constraintCount).toBe(SEASON_2026_CONSTRAINTS.length);
    expect(seeded.stats.constraintCount).toBeGreaterThan(10);
    for (const id of Object.values(SEASON_2026_CONSTRAINT_ID)) {
      expect(getConstraint(seeded, id)).toBeTruthy();
    }
  });

  it('covers all three hardnesses, so no test below is trivially satisfied', () => {
    expect(seeded.stats.hardCount).toBeGreaterThan(0);
    expect(seeded.stats.softCount).toBeGreaterThan(0);
    expect(seeded.stats.preferenceCount).toBeGreaterThan(0);
    expect(seeded.stats.hardCount + seeded.stats.softCount + seeded.stats.preferenceCount).toBe(
      seeded.stats.constraintCount
    );
  });

  it('cites a real source for every constraint, and never invents a date', () => {
    let checked = 0;
    for (const record of seeded.constraints) {
      expect(record.source.reference.length).toBeGreaterThan(10);
      expect(record.source.setBy.length).toBeGreaterThan(0);
      expect(record.rationale.length).toBeGreaterThan(20);
      if (record.source.setAt === null) {
        // No date is allowed only with an explanation of why there is none.
        expect(record.source.note).toBeTruthy();
      }
      checked += 1;
    }
    expect(checked).toBe(seeded.stats.constraintCount);
  });

  it('records the corpus files the constraints came out of', () => {
    const references = seeded.constraints.map((r) => r.source.reference).join('\n');
    expect(references).toContain('facility_permits.csv');
    expect(references).toContain('facility_geometry.json');
    expect(references).toContain('game_formats.csv');
    expect(references).toContain('incident 3');
    expect(references).toContain('incident 9');
  });

  it('carries the Orchard Park traffic constraint as a venue-scoped hard rule', () => {
    const record = requireConstraint(seeded, SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK);
    expect(record.type).toBe(CONSTRAINT_TYPE.HARD);
    expect(record.scope.kind).toBe(CONSTRAINT_SCOPE_KIND.VENUE);
    // Derived from the geometry adapter, never spelled by hand.
    expect(record.scope.venueId).toBe(season2026VenueId('Orchard Park'));
    expect(ORCHARD_PARK_VENUE_ID).toBe(season2026VenueId('Orchard Park'));
    expect(record.parameters.minimumGapMinutes).toBe(20);
    expect(record.source.reference).toContain('20-min turnover HARD');
  });

  it('remembers that field adjacency was a preference first (incident 3)', () => {
    const record = requireConstraint(seeded, ADJACENCY);
    expect(record.type).toBe(CONSTRAINT_TYPE.HARD);
    expect(record.history).toHaveLength(2);
    expect(record.history[0].to).toBe(CONSTRAINT_TYPE.PREFERENCE);
    expect(record.history[1].from).toBe(CONSTRAINT_TYPE.PREFERENCE);
    expect(record.history[1].to).toBe(CONSTRAINT_TYPE.HARD);
    const finding = seeded.findings.find(
      (f) =>
        f.code === CONSTRAINT_REASON.CONSTRAINT_TYPE_CHANGED && f.details.constraintId === ADJACENCY
    );
    expect(finding).toBeTruthy();
    expect(seeded.stats.retypedCount).toBeGreaterThan(0);
  });

  it('keeps same-ground exclusivity separate from adjacency', () => {
    // If they shared a record, demoting adjacency would legalise two games on
    // the identical patch of grass. They do not.
    const adjacency = requireConstraint(seeded, ADJACENCY);
    const sameGround = requireConstraint(seeded, SAME_GROUND);
    expect(adjacency.policy).not.toBe(sameGround.policy);
    expect(adjacency.reasonCodes).toContain(FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP);
    expect(adjacency.reasonCodes).not.toContain(FACILITY_REASON.OCCUPIED_SAME_SURFACE);
    expect(sameGround.reasonCodes).toContain(FACILITY_REASON.OCCUPIED_SAME_SURFACE);
    expect(sameGround.reasonCodes).toContain(FACILITY_REASON.OCCUPIED_PARENT_CHILD);
  });

  it('wires the four constraints that have a Phase 1 code and admits the rest do not', () => {
    expect(seeded.stats.wiredCount).toBe(4);
    expect(seeded.stats.declaredOnlyCount).toBe(
      seeded.stats.constraintCount - seeded.stats.wiredCount
    );
    expect(seeded.stats.declaredOnlyCount).toBeGreaterThan(0);
    for (const record of seeded.constraints) {
      if (record.enforcement !== CONSTRAINT_ENFORCEMENT.REASON_CODES) continue;
      expect(record.reasonCodes.length).toBeGreaterThan(0);
      for (const code of record.reasonCodes) expect(isKnownReasonCode(code)).toBe(true);
    }
  });

  it('marks the waivable constraints incident 9 is about', () => {
    const travel = requireConstraint(seeded, SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES);
    expect(travel.type).toBe(CONSTRAINT_TYPE.SOFT);
    expect(travel.waivable).toBe(true);
    expect(travel.parameters.minimumGapMinutes).toBe(60);
    expect(seeded.stats.waivableCount).toBeGreaterThan(0);
  });

  it('reproduces the Phase 1 severities exactly — seeding writes down what is already true', () => {
    const table = effectiveSeverityTable(seeded, {
      date: '2026-08-22',
      venueId: 'alder-park',
      surfaceId: 'alder-park/pitch-1a',
      surfaceLineage: ['alder-park/pitch-1a', 'alder-park/pitch-1'],
    });
    // Meta-assertion: an empty override list would make the next line vacuous.
    expect(table.overrides.length).toBeGreaterThan(5);
    expect(table.meta.reasonCodesGoverned).toBeGreaterThan(5);
    for (const override of table.overrides) {
      expect(override.severity).toBe(BASE_REASON_SEVERITY[override.code]);
      expect(override.changed).toBe(false);
    }
    expect(table.meta.reasonCodesOverridden).toBe(0);
  });

  it('governs the codes the prompt’s constraint list names', () => {
    const governed = governedReasonCodes(seeded);
    expect(governed).toContain(FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP);
    expect(governed).toContain(TIMING_REASON.WARMUP_OCCUPIED_SPATIAL_OVERLAP);
    expect(governed).toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
    expect(governed).toContain(AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED);
    expect(governed).toContain(AVAILABILITY_REASON.PERMIT_BLACKOUT);
  });
});

/* -------------------------------------------------------------------------- */
/* Scope resolution and precedence                                             */
/* -------------------------------------------------------------------------- */

describe('scope precedence', () => {
  it('ranks global loosest and one named thing tightest', () => {
    expect(specificityOf(CONSTRAINT_SCOPE_KIND.GLOBAL)).toBe(0);
    expect(specificityOf(CONSTRAINT_SCOPE_KIND.VENUE)).toBeGreaterThan(
      specificityOf(CONSTRAINT_SCOPE_KIND.GLOBAL)
    );
    expect(specificityOf(CONSTRAINT_SCOPE_KIND.SURFACE)).toBeGreaterThan(
      specificityOf(CONSTRAINT_SCOPE_KIND.VENUE)
    );
    // date, division and venue are deliberately equal: none contains another.
    expect(CONSTRAINT_SCOPE_SPECIFICITY[CONSTRAINT_SCOPE_KIND.DATE]).toBe(
      CONSTRAINT_SCOPE_SPECIFICITY[CONSTRAINT_SCOPE_KIND.VENUE]
    );
    expect(() => specificityOf('galaxy')).toThrow(/no registered specificity/);
  });

  it('lets the Orchard Park venue rule beat the global floor (GAP-12)', () => {
    const resolved = resolvePolicy(seeded, 'turnover-minimum', {
      venueId: ORCHARD_PARK_VENUE_ID,
    });
    expect(resolved.meta.constraintsConsidered).toBe(3);
    expect(resolved.meta.constraintsApplicable).toBe(3);
    expect(resolved.effective?.id).toBe(SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK);
    expect(resolved.effective?.parameters.minimumGapMinutes).toBe(20);
    expect(resolved.byType[CONSTRAINT_TYPE.HARD]?.parameters.minimumGapMinutes).toBe(20);
    const provenance = resolved.findings.find(
      (f) => f.code === CONSTRAINT_REASON.CONSTRAINT_SCOPE_NARROWER_APPLIED
    );
    expect(provenance?.details.appliedConstraintId).toBe(
      SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK
    );
    expect(provenance?.details.supersededConstraintIds).toContain(
      SEASON_2026_CONSTRAINT_ID.TURNOVER_FLOOR_GLOBAL
    );
  });

  it('falls back to the global floor at any other venue', () => {
    const resolved = resolvePolicy(seeded, 'turnover-minimum', { venueId: 'alder-park' });
    expect(resolved.effective?.id).toBe(SEASON_2026_CONSTRAINT_ID.TURNOVER_FLOOR_GLOBAL);
    expect(resolved.effective?.parameters.minimumGapMinutes).toBe(10);
    expect(resolved.meta.constraintsOutOfScope).toBe(1);
    expect(
      resolved.findings.some((f) => f.code === CONSTRAINT_REASON.CONSTRAINT_SCOPE_NARROWER_APPLIED)
    ).toBe(false);
  });

  it('keeps the hard floor and the preferred target as separate answers', () => {
    const resolved = resolvePolicy(seeded, 'turnover-minimum', { venueId: 'alder-park' });
    expect(resolved.byType[CONSTRAINT_TYPE.HARD]?.parameters.minimumGapMinutes).toBe(10);
    expect(resolved.byType[CONSTRAINT_TYPE.PREFERENCE]?.parameters.minimumGapMinutes).toBe(20);
  });

  it('refuses to answer when the caller did not say where it is standing', () => {
    const resolved = resolvePolicy(seeded, 'turnover-minimum', {});
    expect(resolved.status).toBe(CONSTRAINT_STATUS.COMPROMISED);
    const finding = resolved.findings.find(
      (f) => f.code === CONSTRAINT_REASON.CONSTRAINT_SCOPE_UNJUDGED
    );
    expect(finding?.details.constraintId).toBe(SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK);
    expect(finding?.severity).toBe(CONSTRAINT_SEVERITY.COMPROMISE);
  });

  it('reports a tie between equally specific rivals instead of picking one silently', () => {
    const registry = registryOf(
      makeRecord({
        id: 'by-venue',
        parameters: { minimumGapMinutes: 20 },
        restrictiveDirection: 'higher',
        scope: { kind: CONSTRAINT_SCOPE_KIND.VENUE, venueId: 'orchard-park' },
      }),
      makeRecord({
        id: 'by-date',
        parameters: { minimumGapMinutes: 30 },
        restrictiveDirection: 'higher',
        scope: { kind: CONSTRAINT_SCOPE_KIND.DATE, date: '2026-08-22' },
      })
    );
    const resolved = resolvePolicy(registry, 'test-policy', {
      venueId: 'orchard-park',
      date: '2026-08-22',
    });
    const ambiguous = resolved.findings.find(
      (f) => f.code === CONSTRAINT_REASON.CONSTRAINT_PRECEDENCE_AMBIGUOUS
    );
    expect(ambiguous).toBeTruthy();
    expect(resolved.meta.ambiguitiesReported).toBe(1);
    // The more restrictive one is applied — never dropped, never guessed.
    expect(resolved.effective?.id).toBe('by-date');
  });

  it('does not call two records that agree an ambiguity', () => {
    const shared = { parameters: { minimumGapMinutes: 20 }, restrictiveDirection: 'higher' };
    const registry = registryOf(
      makeRecord({
        id: 'a',
        ...shared,
        scope: { kind: CONSTRAINT_SCOPE_KIND.VENUE, venueId: 'orchard-park' },
      }),
      makeRecord({
        id: 'b',
        ...shared,
        scope: { kind: CONSTRAINT_SCOPE_KIND.DATE, date: '2026-08-22' },
      })
    );
    const resolved = resolvePolicy(registry, 'test-policy', {
      venueId: 'orchard-park',
      date: '2026-08-22',
    });
    expect(resolved.meta.ambiguitiesReported).toBe(0);
    expect(resolved.effective?.id).toBe('a');
  });

  it('reads restrictiveness in the direction the record declares', () => {
    const registry = registryOf(
      makeRecord({
        id: 'gap-three-hours',
        parameters: { maximumGapMinutes: 180 },
        restrictiveDirection: 'lower',
        scope: { kind: CONSTRAINT_SCOPE_KIND.DATE, date: '2026-08-22' },
      }),
      makeRecord({
        id: 'gap-two-hours',
        parameters: { maximumGapMinutes: 120 },
        restrictiveDirection: 'lower',
        scope: { kind: CONSTRAINT_SCOPE_KIND.VENUE, venueId: 'orchard-park' },
      })
    );
    const resolved = resolvePolicy(registry, 'test-policy', {
      venueId: 'orchard-park',
      date: '2026-08-22',
    });
    // A *maximum* gets stricter as it falls, so 120 wins over 180.
    expect(resolved.effective?.id).toBe('gap-two-hours');
  });

  it('lets a rule about a parent surface govern its halves', () => {
    const registry = registryOf(
      makeRecord({
        id: 'pitch-one',
        scope: { kind: CONSTRAINT_SCOPE_KIND.SURFACE, surfaceId: 'alder-park/pitch-1' },
      })
    );
    const onHalf = resolvePolicy(registry, 'test-policy', {
      surfaceId: 'alder-park/pitch-1a',
      surfaceLineage: ['alder-park/pitch-1a', 'alder-park/pitch-1'],
    });
    expect(onHalf.effective?.id).toBe('pitch-one');
    const elsewhere = resolvePolicy(registry, 'test-policy', {
      surfaceId: 'alder-park/pitch-2',
      surfaceLineage: ['alder-park/pitch-2'],
    });
    expect(elsewhere.effective).toBeNull();
    expect(
      elsewhere.findings.some((f) => f.code === CONSTRAINT_REASON.CONSTRAINT_POLICY_UNGOVERNED)
    ).toBe(true);
  });

  it('says out loud that a division match is a label match (GAP-24)', () => {
    const registry = registryOf(
      makeRecord({
        id: 'u12b-only',
        scope: { kind: CONSTRAINT_SCOPE_KIND.DIVISION, divisionLabel: 'U12B' },
      })
    );
    const resolved = resolvePolicy(registry, 'test-policy', { divisionLabel: 'U12B' });
    expect(resolved.effective?.id).toBe('u12b-only');
    expect(
      resolved.findings.some((f) => f.code === CONSTRAINT_REASON.CONSTRAINT_DIVISION_LABEL_MATCH)
    ).toBe(true);
  });

  it('reports an ungoverned policy rather than implying permission', () => {
    const resolved = resolvePolicy(seeded, 'no-such-policy', { venueId: 'alder-park' });
    expect(resolved.effective).toBeNull();
    expect(resolved.status).toBe(CONSTRAINT_STATUS.COMPROMISED);
    expect(resolved.findings.map((f) => f.code)).toContain(
      CONSTRAINT_REASON.CONSTRAINT_POLICY_UNGOVERNED
    );
  });

  it('resolves every policy at once and counts what it looked at', () => {
    const all = resolveConstraints(seeded, {
      date: '2026-08-22',
      venueId: ORCHARD_PARK_VENUE_ID,
      surfaceId: 'orchard-park/field-1',
      surfaceLineage: ['orchard-park/field-1'],
    });
    expect(Object.keys(all.policies).length).toBe(seeded.stats.policyCount);
    expect(all.meta.policiesResolved).toBe(seeded.stats.policyCount);
    expect(all.meta.constraintsConsidered).toBe(seeded.stats.constraintCount);
    expect(all.policies['turnover-minimum'].effective?.parameters.minimumGapMinutes).toBe(20);
  });
});

/* -------------------------------------------------------------------------- */
/* Effective windows                                                           */
/* -------------------------------------------------------------------------- */

describe('effective windows and expiry', () => {
  const windowed = registryOf(
    makeRecord({
      id: 'seasonal',
      effectiveFrom: '2026-09-01',
      effectiveTo: '2026-09-30',
    })
  );

  it('reports a constraint outside its window as inactive, not absent', () => {
    const before = resolvePolicy(windowed, 'test-policy', { date: '2026-08-22' });
    expect(before.effective).toBeNull();
    expect(before.meta.constraintsInactive).toBe(1);
    expect(before.findings.map((f) => f.code)).toContain(
      CONSTRAINT_REASON.CONSTRAINT_NOT_YET_EFFECTIVE
    );

    const after = resolvePolicy(windowed, 'test-policy', { date: '2026-10-24' });
    expect(after.findings.map((f) => f.code)).toContain(CONSTRAINT_REASON.CONSTRAINT_EXPIRED);

    const during = resolvePolicy(windowed, 'test-policy', { date: '2026-09-12' });
    expect(during.effective?.id).toBe('seasonal');
    expect(during.meta.constraintsApplicable).toBe(1);
  });

  it('treats an unjudgeable window as a compromise, not a pass', () => {
    const undated = resolvePolicy(windowed, 'test-policy', {});
    expect(undated.status).toBe(CONSTRAINT_STATUS.COMPROMISED);
    expect(undated.findings.map((f) => f.code)).toContain(
      CONSTRAINT_REASON.CONSTRAINT_WINDOW_UNJUDGED
    );
  });

  it('lists the active and inactive constraints for a date', () => {
    const registry = buildConstraintRegistry({
      name: 'mixed',
      constraints: [
        makeRecord({ id: 'always' }),
        makeRecord({ id: 'expired', policy: 'p2', effectiveTo: '2026-08-01' }),
      ],
    });
    const answer = activeConstraintsOn(registry, '2026-08-22');
    expect(answer.active.map((r) => r.id)).toEqual(['always']);
    expect(answer.inactive).toEqual([
      { constraintId: 'expired', code: CONSTRAINT_REASON.CONSTRAINT_EXPIRED },
    ]);
    expect(answer.meta.constraintsConsidered).toBe(2);
  });

  it('answers the temporal question without scope noise it cannot answer', () => {
    // "Which constraints are live on this date?" names no venue, division or
    // team, and it is not asking about any: a `CONSTRAINT_SCOPE_UNJUDGED` per
    // scoped record is noise that makes a clean answer look compromised.
    // Meta-assertion first: the seeded set does hold scoped records, so a run
    // with none would make the absence below mean nothing.
    expect(seeded.stats.scopedCount).toBeGreaterThan(0);
    const answer = activeConstraintsOn(seeded, '2026-09-12');
    expect(answer.active.length + answer.inactive.length).toBe(seeded.constraintIds.length);
    expect(answer.meta.constraintsConsidered).toBe(seeded.constraintIds.length);
    expect(answer.findings.map((finding) => finding.code)).not.toContain(
      CONSTRAINT_REASON.CONSTRAINT_SCOPE_UNJUDGED
    );
    // …and the same registry, asked a scoped question, still reports it.
    expect(
      resolvePolicy(seeded, 'turnover-minimum', {}).findings.map((finding) => finding.code)
    ).toContain(CONSTRAINT_REASON.CONSTRAINT_SCOPE_UNJUDGED);
  });

  it('does not apply an expired constraint to the severity table', () => {
    const registry = registryOf(
      makeRecord({
        id: 'expired-adjacency',
        type: CONSTRAINT_TYPE.PREFERENCE,
        weight: 1,
        enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
        reasonCodes: [FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP],
        effectiveTo: '2026-08-01',
      })
    );
    const live = effectiveSeverityTable(registry, { date: '2026-07-01' });
    expect(live.severityByCode[FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP]).toBe(
      CONSTRAINT_SEVERITY.INFO
    );
    const dead = effectiveSeverityTable(registry, { date: '2026-08-22' });
    expect(dead.severityByCode[FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP]).toBeUndefined();
    expect(dead.meta.constraintsInactive).toBe(1);
    expect(dead.findings.map((f) => f.code)).toContain(CONSTRAINT_REASON.CONSTRAINT_EXPIRED);
  });
});

/* -------------------------------------------------------------------------- */
/* The severity seam                                                           */
/* -------------------------------------------------------------------------- */

describe('hardness as data', () => {
  const asPreference = retypeConstraint(seeded, ADJACENCY, {
    type: CONSTRAINT_TYPE.PREFERENCE,
    by: 'the test suite',
    at: '2026-08-22',
    note: 'demoted to prove the seam works',
    weight: 1,
  });

  it('changes a reason code’s severity without touching any Phase 1 module', () => {
    const before = effectiveSeverityTable(seeded, { date: '2026-08-22' });
    const after = effectiveSeverityTable(asPreference, { date: '2026-08-22' });
    expect(before.severityByCode[FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP]).toBe(
      CONSTRAINT_SEVERITY.BLOCKING
    );
    expect(after.severityByCode[FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP]).toBe(
      CONSTRAINT_SEVERITY.INFO
    );
    // The frozen table itself is untouched: this is an override, not a mutation.
    expect(BASE_REASON_SEVERITY[FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP]).toBe(
      CONSTRAINT_SEVERITY.BLOCKING
    );
    expect(after.meta.reasonCodesOverridden).toBeGreaterThan(0);
    expect(after.findings.map((f) => f.code)).toContain(
      CONSTRAINT_REASON.CONSTRAINT_SEVERITY_OVERRIDDEN
    );
  });

  it('leaves same-ground exclusivity alone when adjacency is demoted', () => {
    const after = effectiveSeverityTable(asPreference, { date: '2026-08-22' });
    expect(after.severityByCode[FACILITY_REASON.OCCUPIED_SAME_SURFACE]).toBe(
      CONSTRAINT_SEVERITY.BLOCKING
    );
    expect(after.severityByCode[FACILITY_REASON.OCCUPIED_PARENT_CHILD]).toBe(
      CONSTRAINT_SEVERITY.BLOCKING
    );
  });

  it('appends to the history and leaves the original registry untouched', () => {
    const record = requireConstraint(asPreference, ADJACENCY);
    expect(record.type).toBe(CONSTRAINT_TYPE.PREFERENCE);
    expect(record.history).toHaveLength(3);
    expect(record.history[2]).toMatchObject({
      from: CONSTRAINT_TYPE.HARD,
      to: CONSTRAINT_TYPE.PREFERENCE,
      by: 'the test suite',
    });
    expect(requireConstraint(seeded, ADJACENCY).type).toBe(CONSTRAINT_TYPE.HARD);
    expect(requireConstraint(seeded, ADJACENCY).history).toHaveLength(2);
  });

  it('refuses to invent a magnitude when softening a constraint', () => {
    expect(() =>
      retypeConstraint(seeded, ADJACENCY, {
        type: CONSTRAINT_TYPE.SOFT,
        by: 'the test suite',
        note: 'no weight supplied',
      })
    ).toThrow(/needs a weight/);
  });

  it('re-severities findings and keeps the provenance of the change', () => {
    const findings = [
      makeConstraintFinding(CONSTRAINT_REASON.CONSTRAINT_DECLARED_ONLY, 'noise'),
      {
        code: FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP,
        severity: CONSTRAINT_SEVERITY.BLOCKING,
        message: 'a clash on overlapping ground',
        details: { bookingAId: 'a', bookingBId: 'b' },
      },
    ];
    const table = effectiveSeverityTable(asPreference, { date: '2026-08-22' });
    const applied = applyRegistrySeverity(findings, table);

    expect(applied.meta.findingsExamined).toBe(2);
    expect(applied.meta.findingsReseverified).toBe(1);
    expect(applied.status).toBe(CONSTRAINT_STATUS.ALLOWED);
    const overlap = applied.findings.find(
      (f) => f.code === FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP
    );
    // Demoted, not deleted: the clash is still visible and still says why.
    expect(overlap?.severity).toBe(CONSTRAINT_SEVERITY.INFO);
    expect(overlap?.details.baseSeverity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(overlap?.details.severityBy).toBe(ADJACENCY);
    expect(overlap?.details.bookingAId).toBe('a');
  });

  it('reports a hardness disagreement over one code instead of picking silently', () => {
    const registry = registryOf(
      makeRecord({
        id: 'hard-claim',
        type: CONSTRAINT_TYPE.HARD,
        enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
        reasonCodes: [FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP],
      }),
      makeRecord({
        id: 'soft-claim',
        policy: 'other-policy',
        type: CONSTRAINT_TYPE.PREFERENCE,
        weight: 1,
        enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
        reasonCodes: [FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP],
      })
    );
    const table = effectiveSeverityTable(registry, { date: '2026-08-22' });
    expect(table.severityByCode[FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP]).toBe(
      CONSTRAINT_SEVERITY.BLOCKING
    );
    const ambiguous = table.findings.find(
      (f) => f.code === CONSTRAINT_REASON.CONSTRAINT_SEVERITY_AMBIGUOUS
    );
    expect(ambiguous?.details.ambiguousWith).toEqual(['soft-claim']);
  });

  it('lets a venue-scoped record beat a global one over the same code', () => {
    const registry = registryOf(
      makeRecord({
        id: 'global-hard',
        type: CONSTRAINT_TYPE.HARD,
        enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
        reasonCodes: [FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP],
      }),
      makeRecord({
        id: 'venue-preference',
        policy: 'other-policy',
        type: CONSTRAINT_TYPE.PREFERENCE,
        weight: 1,
        scope: { kind: CONSTRAINT_SCOPE_KIND.VENUE, venueId: 'alder-park' },
        enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
        reasonCodes: [FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP],
      })
    );
    const atVenue = effectiveSeverityTable(registry, {
      date: '2026-08-22',
      venueId: 'alder-park',
    });
    expect(atVenue.severityByCode[FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP]).toBe(
      CONSTRAINT_SEVERITY.INFO
    );
    const elsewhere = effectiveSeverityTable(registry, {
      date: '2026-08-22',
      venueId: 'summit-hs',
    });
    expect(elsewhere.severityByCode[FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP]).toBe(
      CONSTRAINT_SEVERITY.BLOCKING
    );
  });
});

/* -------------------------------------------------------------------------- */
/* "What would change if this went back to being a preference?"                */
/* -------------------------------------------------------------------------- */

describe('the what-if query', () => {
  it('answers the prompt’s question without performing the change', () => {
    const projection = whatIfConstraintType(seeded, ADJACENCY, CONSTRAINT_TYPE.PREFERENCE);
    expect(projection.changed).toBe(true);
    expect(projection.currentType).toBe(CONSTRAINT_TYPE.HARD);
    expect(projection.severityDeltas).toEqual([
      {
        code: FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP,
        from: CONSTRAINT_SEVERITY.BLOCKING,
        to: CONSTRAINT_SEVERITY.INFO,
      },
      {
        code: TIMING_REASON.WARMUP_OCCUPIED_SPATIAL_OVERLAP,
        from: CONSTRAINT_SEVERITY.BLOCKING,
        to: CONSTRAINT_SEVERITY.INFO,
      },
    ]);
    // The registry it was asked about is unchanged.
    expect(requireConstraint(seeded, ADJACENCY).type).toBe(CONSTRAINT_TYPE.HARD);
    // And the projected one is a real registry, ready to re-run a solve with.
    expect(projection.projectedRegistry.status).toBe(CONSTRAINT_STATUS.ALLOWED);
    expect(requireConstraint(projection.projectedRegistry, ADJACENCY).type).toBe(
      CONSTRAINT_TYPE.PREFERENCE
    );
  });

  it('says so when the projection is a no-op', () => {
    const projection = whatIfConstraintType(seeded, ADJACENCY, CONSTRAINT_TYPE.HARD);
    expect(projection.changed).toBe(false);
    expect(projection.severityDeltas).toEqual([]);
    expect(projection.findings.map((f) => f.code)).toContain(
      CONSTRAINT_REASON.CONSTRAINT_PROJECTION_NO_OP
    );
  });

  it('turns findings into per-subject verdict changes', () => {
    const evaluations = [
      {
        id: 'game-1',
        findings: [
          {
            code: FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP,
            severity: CONSTRAINT_SEVERITY.BLOCKING,
            message: 'clash',
            details: {},
          },
        ],
      },
      {
        id: 'game-2',
        findings: [
          {
            code: FACILITY_REASON.OCCUPIED_SAME_SURFACE,
            severity: CONSTRAINT_SEVERITY.BLOCKING,
            message: 'same ground',
            details: {},
          },
        ],
      },
    ];
    const projection = whatIfConstraintType(seeded, ADJACENCY, CONSTRAINT_TYPE.PREFERENCE, {
      evaluations,
    });
    expect(projection.meta.evaluationsExamined).toBe(2);
    expect(projection.meta.findingsExamined).toBe(2);
    expect(projection.statusDeltas).toEqual([
      {
        id: 'game-1',
        statusBefore: CONSTRAINT_STATUS.REJECTED,
        statusAfter: CONSTRAINT_STATUS.ALLOWED,
      },
    ]);
    const overlapDelta = projection.findingDeltas.find(
      (d) => d.code === FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP
    );
    expect(overlapDelta?.findingCount).toBe(1);
  });

  it('counts re-severitied findings, not the evaluations they came from', () => {
    // `findingsReseverified` is a meta-assertion counter: it exists so a caller
    // can prove the projection touched something. Counting evaluations made it
    // under-report every evaluation that carried more than one affected
    // finding, which is the case where the counter matters most.
    const evaluation = {
      id: 'game-1',
      findings: [
        {
          code: FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP,
          severity: CONSTRAINT_SEVERITY.BLOCKING,
          message: 'clash',
          details: {},
        },
        {
          code: TIMING_REASON.WARMUP_OCCUPIED_SPATIAL_OVERLAP,
          severity: CONSTRAINT_SEVERITY.BLOCKING,
          message: 'warm-up clash',
          details: {},
        },
        {
          code: AVAILABILITY_REASON.PERMIT_WEEKDAY_DEFAULT,
          severity: CONSTRAINT_SEVERITY.INFO,
          message: 'unrelated',
          details: {},
        },
      ],
    };
    const projection = whatIfConstraintType(seeded, ADJACENCY, CONSTRAINT_TYPE.PREFERENCE, {
      evaluations: [evaluation],
    });
    expect(projection.meta.evaluationsExamined).toBe(1);
    expect(projection.meta.findingsExamined).toBe(3);
    // Two of the three codes belong to the projected constraint.
    expect(projection.meta.findingsReseverified).toBe(2);
    // Both severity tables were consulted, so both are accounted for.
    const oneTable = effectiveSeverityTable(seeded, {}).meta;
    expect(projection.meta.constraintsConsidered).toBe(oneTable.constraintsConsidered * 2);
    expect(projection.meta.reasonCodesGoverned).toBe(oneTable.reasonCodesGoverned * 2);
  });

  it('refuses to report an empty delta as a clean answer (incident 4)', () => {
    const projection = whatIfConstraintType(seeded, ADJACENCY, CONSTRAINT_TYPE.PREFERENCE, {
      evaluations: [
        {
          id: 'game-1',
          findings: [
            {
              code: AVAILABILITY_REASON.PERMIT_WEEKDAY_DEFAULT,
              severity: CONSTRAINT_SEVERITY.INFO,
              message: 'unrelated',
              details: {},
            },
          ],
        },
      ],
    });
    expect(projection.statusDeltas).toEqual([]);
    expect(projection.status).toBe(CONSTRAINT_STATUS.COMPROMISED);
    expect(projection.findings.map((f) => f.code)).toContain(
      CONSTRAINT_REASON.CONSTRAINT_PROJECTION_VACUOUS
    );
  });

  it('lays out every hardness option for one constraint', () => {
    const matrix = severityMatrixFor(seeded, ADJACENCY);
    expect(matrix).toHaveLength(2);
    const overlap = matrix.find((row) => row.code === FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP);
    expect(overlap).toMatchObject({
      baseSeverity: CONSTRAINT_SEVERITY.BLOCKING,
      current: CONSTRAINT_SEVERITY.BLOCKING,
      hard: CONSTRAINT_SEVERITY.BLOCKING,
      soft: CONSTRAINT_SEVERITY.COMPROMISE,
      preference: CONSTRAINT_SEVERITY.INFO,
    });
  });
});

describe('the sunset margin is a compromise (owner, 2026-11-02)', () => {
  // The owner: "Yes to legal-with-a-warning for kickoffs after sunset, because some orgs have
  // portable lighting or other workarounds." The expected values below come from that decision and
  // from the other constraints of the same set, never from the sunset record or its code's severity.
  //
  // Plants (each red, then reverted): L-P1 `SUNSET_MARGIN_VIOLATED` back to `BLOCKING` in
  // `AVAILABILITY_REASON_SEVERITY`; L-P2 the `sunset-margin` record back to `hard` with no weight;
  // L-P3 `sunsetBlocks()` in `availability/kickoff.js` always true.
  const sunset = requireConstraint(seeded, SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN);

  it('L1: the record is soft, states a weight, is not waivable, and the retype is on record', () => {
    expect(sunset.type).toBe('soft');
    expect(sunset.weight).toBeGreaterThan(0);
    expect(sunset.waivable).toBe(false);
    expect(sunset.reasonCodes).toEqual([AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED]);
    expect(sunset.history).toHaveLength(1);
    expect(sunset.history[0]).toMatchObject({
      from: 'hard',
      to: 'soft',
      by: 'owner',
      at: '2026-11-02',
    });
    const said = seeded.findings.filter(
      (f) =>
        f.code === CONSTRAINT_REASON.CONSTRAINT_TYPE_CHANGED &&
        f.details.constraintId === SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN
    );
    expect(said).toHaveLength(1);
    expect(said[0].details).toMatchObject({ firstType: 'hard', lastChangeTo: 'soft' });
  });

  it('L2: the registry still overrides no severity, and the code is a compromise under it', () => {
    const table = effectiveSeverityTable(seeded, {});
    // A one-sided change (the record or the code's own severity alone) shows up here.
    expect(table.overrides.filter((override) => override.changed)).toEqual([]);
    expect(table.severityByCode[AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED]).toBe('compromise');
    // The permit close next to it is still a block: only the sunset margin moved.
    expect(table.severityByCode[AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED]).toBe('blocking');
  });

  it('L3: the soft constraints are the two coach-travel records and the sunset margin; it is not hard', () => {
    const idsOf = (type) =>
      Object.values(seeded.byId)
        .filter((record) => record.type === type)
        .map((record) => record.id)
        .sort();
    expect(idsOf('soft')).toEqual(
      [
        SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES,
        SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_WITHIN_VENUE,
        SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN,
      ].sort()
    );
    expect(idsOf('hard')).not.toContain(SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN);
    // The permit window is the hard bound beside it, and stays one.
    expect(idsOf('hard')).toContain(SEASON_2026_CONSTRAINT_ID.PERMIT_WINDOW);
    expect(seeded.stats.softCount).toBe(3);
  });
});
