/**
 * Tests for the practice layer of the facility graph (Phase 8.3):
 * `facility/adapters/season2026PracticeGeometry.js`, `facility/practiceSurfaces.js`.
 *
 * Every figure is derived from the corpus at test time. The subject sets are
 * enumerated from the side a break would leave intact — the declared layer,
 * the game geometry, the permits — and the practice grid is the thing being
 * checked, never the thing the check is derived from.
 *
 * Meta-assertion discipline as in `tests/facilityGraph.test.js`: each
 * behavioural check also proves it examined a non-zero number of records, and
 * each guard has a positive control that makes it fail.
 */

import { describe, it, expect } from 'vitest';

import {
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadPracticeFile,
  loadSeason2026,
  loadSeason2026Practice,
  loadSunsets,
  UNRESOLVED_VENUE_TOKEN,
} from '@squadlogic/core/fixtures/index.js';

import {
  AVAILABILITY_CONSTRAINT,
  AVAILABILITY_REASON,
  AVAILABILITY_SEVERITY,
  AVAILABILITY_STATUS,
  buildAvailabilityCalendarFromSeason2026,
  checkKickoffAvailability,
  latestLegalKickoff,
  resolveLighting,
  resolvePermitWindow,
} from '@squadlogic/core/availability/index.js';

import {
  buildFormatTimingTableFromSeason2026,
  requireFormatTiming,
} from '@squadlogic/core/timing/index.js';

import {
  replacementSurfacesFor,
  season2026CapacitySubjects,
  season2026RelocationPolicy,
} from '@squadlogic/core/scenario/index.js';

import { buildReserveCapacityReport } from '@squadlogic/core/reserve/index.js';

import { buildSeason2026ConstraintRegistry } from '@squadlogic/core/constraints/index.js';

import { RULE_ID, runRuleEngine, toSeason2026Schedule } from '@squadlogic/core/ruleEngine/index.js';

import {
  FACILITY_REASON,
  PRACTICE_SURFACE_RESOLUTION,
  SEASON_2026_PRACTICE_LAYER,
  buildFacilityGraph,
  buildFacilityGraphFromSeason2026,
  buildSeason2026PracticeFacilityGraph,
  buildSeason2026VenueComplexMap,
  cellsOf,
  extendFacilityGraphInputWithSeason2026PracticeLayer,
  findFacilityConflicts,
  lineageOf,
  practiceSurfaceName,
  resolvePracticeSurface,
  resolvePracticeVenue,
  season2026PracticeSurfaceId,
  season2026SurfaceId,
  season2026VenueId,
  surfacesConflict,
  toSeason2026FacilityGraphInput,
} from '@squadlogic/core/facility/index.js';

import { expectedReserveKickoffs } from './helpers/reserveOracle.js';

/* -------------------------------------------------------------------------- */
/* Corpus, loaded once                                                         */
/* -------------------------------------------------------------------------- */

const geometry = loadFacilityGeometry();
const season = loadSeason2026();
const practice = loadSeason2026Practice({ season });
const gameGraph = buildFacilityGraphFromSeason2026(geometry);
const graph = buildSeason2026PracticeFacilityGraph(geometry);
const complexes = buildSeason2026VenueComplexMap();

const ALDER = 'Alder Park';
const R = PRACTICE_SURFACE_RESOLUTION;

/** Opaque id of a game-layer surface. */
const sid = (venue, field) => season2026SurfaceId(venue, field);
/** Opaque id of a practice-layer node. */
const pid = (venue, field, subunit = null) => season2026PracticeSurfaceId(venue, field, subunit);

/** Ids the practice layer adds, derived from the declaration, not typed in. */
const layerSurfaceIds = SEASON_2026_PRACTICE_LAYER.surfaces.map((node) =>
  pid(node.venue, node.field, node.subunit)
);
const layerVenueIds = SEASON_2026_PRACTICE_LAYER.venues.map((venue) =>
  season2026VenueId(venue.name)
);

/** Resolve a grid row to ground, by structure. */
const resolveSlot = (slot) =>
  resolvePracticeSurface(graph, complexes, {
    venue: slot.venue,
    field: slot.field,
    subunit: slot.subunit,
  });

/**
 * A practice booking on a surface id at a weekly slot's time on a date.
 *
 * @param {string} id
 * @param {string} surfaceId
 * @param {string} date
 * @param {number} startMinutes
 * @param {number} endMinutes
 */
const booking = (id, surfaceId, date, startMinutes, endMinutes) => ({
  id,
  surfaceId,
  date,
  startMinutes,
  endMinutes,
  format: null,
  label: id,
});

/* -------------------------------------------------------------------------- */
/* Guard block                                                                 */
/* -------------------------------------------------------------------------- */

describe('practice layer :: corpus guard', () => {
  it('composes over the game graph without changing it', () => {
    // The game layer is untouched: same counts a game-only build reports.
    expect(gameGraph.stats.overlapPairCount).toBe(2);
    expect(gameGraph.stats.containmentEdgeCount).toBe(4);
    expect(gameGraph.stats.surfaceCount).toBe(geometry.fields.length);
    expect(gameGraph.stats.venueCount).toBe(geometry.venues.length);

    // The practice graph is strictly the game graph plus the declared layer.
    expect(graph.stats.overlapPairCount).toBe(2);
    expect(graph.overlapPairs).toEqual(gameGraph.overlapPairs);
    expect(graph.stats.venueCount).toBe(geometry.venues.length + layerVenueIds.length);
    expect(graph.stats.surfaceCount).toBe(geometry.fields.length + layerSurfaceIds.length);
    expect(graph.stats.containmentEdgeCount).toBe(
      4 + SEASON_2026_PRACTICE_LAYER.surfaces.filter((n) => n.subunit !== null || n.parent).length
    );
    expect(layerSurfaceIds.length).toBeGreaterThan(20);
    expect(layerVenueIds.length).toBe(10);
    for (const id of gameGraph.surfaceIds) expect(graph.surfaces[id]).toBeDefined();
    for (const id of layerSurfaceIds) expect(graph.surfaces[id]).toBeDefined();
  });

  it('keeps every game-layer relation exactly as the game graph answers it', () => {
    // Enumerated from the game graph, so a practice node cannot mask a change.
    let compared = 0;
    for (const a of gameGraph.surfaceIds) {
      for (const b of gameGraph.surfaceIds) {
        const before = surfacesConflict(gameGraph, a, b);
        const after = surfacesConflict(graph, a, b);
        expect(after.conflict, `${a} vs ${b}`).toBe(before.conflict);
        expect(after.code, `${a} vs ${b}`).toBe(before.code);
        compared += 1;
      }
    }
    expect(compared).toBe(gameGraph.surfaceIds.length ** 2);
  });

  it('never mints a colon-bearing id and names every node uniquely within its venue', () => {
    const seen = new Set();
    for (const id of graph.surfaceIds) {
      expect(id).not.toContain(':');
      const key = `${graph.surfaces[id].venueId}\u0000${graph.surfaces[id].name}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(graph.surfaceIds.length);
  });

  it('declares no lighting for the venues no source states it for', () => {
    for (const id of layerVenueIds) expect(graph.venues[id].lit).toBeNull();
    // ... and leaves the game corpus's stated flags alone.
    for (const venue of geometry.venues) {
      expect(typeof venue.lit).toBe('boolean');
      expect(graph.venues[season2026VenueId(venue.name)].lit).toBe(venue.lit);
    }
    expect(geometry.venues.some((venue) => venue.lit === true)).toBe(true);
    // An omitted flag is undeclared everywhere, not only in the practice layer.
    const silent = buildFacilityGraph({
      venues: [{ id: 'v', name: 'V' }],
      surfaces: [{ id: 'v/f', venueId: 'v', name: 'F' }],
    });
    expect(silent.venues.v.lit).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Every declared node cites a row that exists                                 */
/* -------------------------------------------------------------------------- */

describe('practice layer :: every declared node cites a corpus row that exists', () => {
  /** Raw rows of every cited file, loaded through the corpus loader. */
  const rawRowsByFile = new Map();
  const rawRowsOf = (file) => {
    if (!rawRowsByFile.has(file)) {
      rawRowsByFile.set(
        file,
        loadPracticeFile(file, { seasonYear: season.seasonYear }).records.map((r) => r.raw)
      );
    }
    return rawRowsByFile.get(file);
  };
  const rowMatches = (row, where) =>
    Object.entries(where).every(([column, value]) => row[column] === value);
  const citationHolds = (source) =>
    rawRowsOf(source.file).some((row) => rowMatches(row, source.where));

  it('holds for every venue and every surface', () => {
    const nodes = [...SEASON_2026_PRACTICE_LAYER.venues, ...SEASON_2026_PRACTICE_LAYER.surfaces];
    let citations = 0;
    for (const node of nodes) {
      expect(node.sources.length, JSON.stringify(node)).toBeGreaterThan(0);
      for (const source of node.sources) {
        citations += 1;
        expect(citationHolds(source), `${JSON.stringify(source)} matches no row`).toBe(true);
        // Every cited column is a real column of that file.
        const [first] = rawRowsOf(source.file);
        for (const column of Object.keys(source.where)) expect(first).toHaveProperty(column);
      }
    }
    expect(citations).toBeGreaterThanOrEqual(nodes.length);
    expect(new Set(nodes.flatMap((n) => n.sources.map((s) => s.file))).size).toBeGreaterThan(3);
  });

  it('fails on a citation that names a row the corpus does not have (positive control)', () => {
    expect(
      citationHolds({ file: 'practice_grid.csv', where: { venue: ALDER, field: 'Pitch 9A' } })
    ).toBe(false);
    expect(
      citationHolds({
        file: 'practice_grid.csv',
        where: { venue: 'Maplewood', field: 'Field 1', subunit: 'C' },
      })
    ).toBe(false);
    // ... and holds for a row it does have, so the matcher is not vacuous.
    expect(
      citationHolds({ file: 'practice_grid.csv', where: { venue: ALDER, field: 'Pitch 2A' } })
    ).toBe(true);
  });

  it('declares only venues that host no game and only ground the game layer lacks', () => {
    const gameVenueNames = new Set(geometry.venues.map((venue) => venue.name));
    for (const venue of SEASON_2026_PRACTICE_LAYER.venues) {
      expect(gameVenueNames.has(venue.name), venue.name).toBe(false);
    }
    for (const id of layerSurfaceIds) expect(gameGraph.surfaces[id]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance: the property the tree must preserve                            */
/* -------------------------------------------------------------------------- */

describe('practice layer :: 2A and 2B do not conflict, and a game on Pitch 2 excludes both', () => {
  const pitch2 = sid(ALDER, 'Pitch 2');
  const pitch2a = pid(ALDER, 'Pitch 2A');
  const pitch2b = pid(ALDER, 'Pitch 2B');
  const pitch1 = sid(ALDER, 'Pitch 1');
  const pitch1a = sid(ALDER, 'Pitch 1A');
  const side1 = pid(ALDER, 'Pitch 1A', 'Side 1');

  it('models the halves as children of the whole pitch, three levels deep at Alder', () => {
    expect(lineageOf(graph, pitch2a)).toEqual([pitch2a, pitch2]);
    expect(cellsOf(graph, pitch2)).toEqual([pitch2a, pitch2b].sort());
    expect(lineageOf(graph, side1)).toEqual([side1, pitch1a, pitch1]);
    expect(graph.surfaces[side1].depth).toBe(2);
    expect(cellsOf(graph, pitch1)).toEqual([side1, pid(ALDER, 'Pitch 1B', 'Side 1')].sort());
    // Pitch 2 was a leaf in the game layer and is a parent here.
    expect(cellsOf(gameGraph, pitch2)).toEqual([pitch2]);
  });

  it('lets two practices run on 2A and 2B at once', () => {
    const verdict = surfacesConflict(graph, pitch2a, pitch2b);
    expect(verdict.conflict).toBe(false);
    expect(verdict.meta.overlapPairsConsulted).toBe(2);
    const scan = findFacilityConflicts(graph, [
      booking('a', pitch2a, '2026-09-15', 16 * 60, 17 * 60),
      booking('b', pitch2b, '2026-09-15', 16 * 60, 17 * 60),
    ]);
    expect(scan.conflicts).toEqual([]);
    expect(scan.meta.bookingPairsCompared).toBe(1);
  });

  it('rejects a game on Pitch 2 concurrent with a practice on either half', () => {
    for (const half of [pitch2a, pitch2b]) {
      const verdict = surfacesConflict(graph, pitch2, half);
      expect(verdict.conflict).toBe(true);
      expect(verdict.code).toBe(FACILITY_REASON.OCCUPIED_PARENT_CHILD);
    }
    const scan = findFacilityConflicts(graph, [
      booking('game', pitch2, '2026-09-19', 10 * 60, 11 * 60 + 30),
      booking('a', pitch2a, '2026-09-19', 10 * 60, 11 * 60),
      booking('b', pitch2b, '2026-09-19', 11 * 60, 12 * 60),
    ]);
    expect(scan.conflicts.map((f) => f.details.bookingBId).sort()).toEqual(['a', 'b']);
    expect(scan.meta.bookingPairsCompared).toBe(3);
  });

  it('carries the declared overlap down through the new levels without a new pair', () => {
    // Side 1 inside 1A overlaps 2B through {Pitch 1, Pitch 2}: bipartite, via lineage.
    const verdict = surfacesConflict(graph, side1, pitch2b);
    expect(verdict.conflict).toBe(true);
    expect(verdict.code).toBe(FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP);
    expect(verdict.meta.overlapPairsConsulted).toBeGreaterThan(0);
    // ... and 1A / Side 1 against 3A is fine, exactly as 1 against 3 is.
    expect(surfacesConflict(graph, side1, pid(ALDER, 'Pitch 3A')).conflict).toBe(false);
    expect(graph.stats.overlapPairCount).toBe(gameGraph.stats.overlapPairCount);
  });

  it('would notice the tree being flattened (positive control)', () => {
    // A flat layer: 2A and 2B as roots. The property fails on both halves.
    const flat = buildFacilityGraph(
      extendFacilityGraphInputWithSeason2026PracticeLayer(
        toSeason2026FacilityGraphInput(geometry),
        {
          venues: [],
          surfaces: [
            { venue: ALDER, field: 'Pitch 2A', subunit: null, parent: null, sources: [] },
            { venue: ALDER, field: 'Pitch 2B', subunit: null, parent: null, sources: [] },
          ],
        }
      )
    );
    expect(surfacesConflict(flat, pitch2, pitch2a).conflict).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Resolution by structure                                                    */
/* -------------------------------------------------------------------------- */

describe('practice layer :: names resolve to ground by graph structure alone', () => {
  it('resolves the practice spelling "Maplewood" to the declared complex, not a third name', () => {
    expect(resolvePracticeVenue(graph, complexes, 'Maplewood')).toEqual({
      venueIds: [season2026VenueId('Maplewood Back'), season2026VenueId('Maplewood Front')],
      venueSource: 'complex',
    });
    expect(resolvePracticeVenue(graph, complexes, 'Maplewood Back').venueSource).toBe('venue');
    expect(resolvePracticeVenue(graph, complexes, 'Rookerie Park')).toEqual({
      venueIds: [],
      venueSource: null,
    });
    expect(graph.venueIds.some((id) => graph.venues[id].name === 'Maplewood')).toBe(false);
  });

  it('carries every candidate when a field name exists on both halves of the complex', () => {
    const field1 = resolvePracticeSurface(graph, complexes, {
      venue: 'Maplewood',
      field: 'Field 1',
    });
    expect(field1.status).toBe(R.AMBIGUOUS);
    expect(field1.surfaceIds).toEqual([
      sid('Maplewood Back', 'Field 1'),
      sid('Maplewood Front', 'Field 1'),
    ]);
    // Field 2 exists on the back only, so it resolves; the sub-unit resolves Field 1.
    expect(
      resolvePracticeSurface(graph, complexes, { venue: 'Maplewood', field: 'Field 2' })
    ).toMatchObject({
      status: R.RESOLVED,
      surfaceIds: [sid('Maplewood Back', 'Field 2')],
    });
    expect(
      resolvePracticeSurface(graph, complexes, {
        venue: 'Maplewood',
        field: 'Field 1',
        subunit: 'A',
      })
    ).toMatchObject({ status: R.RESOLVED, surfaceIds: [pid('Maplewood Back', 'Field 1', 'A')] });
  });

  it('answers each kind of unknown by name rather than with an empty success', () => {
    expect(
      resolvePracticeSurface(graph, complexes, { venue: 'Nowhere Park', field: 'Field 1' }).status
    ).toBe(R.VENUE_UNKNOWN);
    expect(
      resolvePracticeSurface(graph, complexes, { venue: 'Larkfield Green', field: 'Field 2?' })
        .status
    ).toBe(R.SURFACE_UNKNOWN);
    expect(
      resolvePracticeSurface(graph, complexes, {
        venue: ALDER,
        field: 'Pitch 2A',
        subunit: 'Side 1',
      }).status
    ).toBe(R.SUBUNIT_UNKNOWN);
    expect(resolvePracticeSurface(graph, complexes, { venue: ALDER }).status).toBe(R.VENUE_ONLY);
    // The venue-half named as a field: no ring is consulted, so it is unknown ground.
    expect(
      resolvePracticeSurface(graph, complexes, { venue: 'Maplewood', field: 'Front', subunit: 'A' })
        .status
    ).toBe(R.SURFACE_UNKNOWN);
    expect(practiceSurfaceName('Field 1', 'A')).toBe('Field 1 A');
    expect(practiceSurfaceName('Field 1', null)).toBe('Field 1');
  });
});

/* -------------------------------------------------------------------------- */
/* The grid against the layer, both directions                                */
/* -------------------------------------------------------------------------- */

describe('practice layer :: the practice grid lands on declared ground', () => {
  const slots = practice.practiceSlots;
  const resolutions = slots.map((slot) => ({ slot, resolution: resolveSlot(slot) }));

  it('resolves every venue-resolved grid row uniquely, except the rows that name a venue half as a field', () => {
    expect(slots.length).toBe(457);
    const byStatus = new Map();
    for (const { slot, resolution } of resolutions) {
      const key = `${resolution.status}\u0000${slot.venue}\u0000${slot.field}\u0000${slot.subunit ?? ''}`;
      byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    }
    const unresolvedVenue = resolutions.filter((r) => r.slot.venue === UNRESOLVED_VENUE_TOKEN);
    expect(unresolvedVenue).toHaveLength(28);
    for (const { resolution } of unresolvedVenue) expect(resolution.status).toBe(R.VENUE_UNKNOWN);

    const resolved = resolutions.filter((r) => r.resolution.status === R.RESOLVED);
    const other = resolutions.filter(
      (r) => r.resolution.status !== R.RESOLVED && r.slot.venue !== UNRESOLVED_VENUE_TOKEN
    );
    // The only rows a structural read cannot place: `Maplewood / Front / A`.
    expect(other.map((r) => `${r.slot.venue}/${r.slot.field}/${r.slot.subunit}`)).toEqual(
      Array(4).fill('Maplewood/Front/A')
    );
    for (const { resolution } of other) expect(resolution.status).toBe(R.SURFACE_UNKNOWN);
    expect(resolved.length).toBe(457 - 28 - 4);
    expect(resolutions.some((r) => r.resolution.status === R.AMBIGUOUS)).toBe(false);
  });

  it('places every resolved row on a leaf, never on a parent that a sub-unit sits inside', () => {
    let examined = 0;
    for (const { resolution } of resolutions) {
      if (resolution.status !== R.RESOLVED) continue;
      examined += 1;
      const [id] = resolution.surfaceIds;
      expect(graph.surfaces[id].childIds, id).toEqual([]);
    }
    expect(examined).toBeGreaterThan(400);
  });

  it('uses every declared node somewhere: a grid row or a ring row resolves to it', () => {
    const usedByGrid = new Set(
      resolutions
        .filter((r) => r.resolution.status === R.RESOLVED)
        .flatMap((r) => r.resolution.surfaceIds)
    );
    const ringGround = new Set(
      practice.fieldAliases
        .filter((alias) => alias.venue !== null && alias.field !== null)
        .map((alias) => resolvePracticeSurface(graph, complexes, alias))
        .filter((res) => res.status === R.RESOLVED)
        .flatMap((res) => res.surfaceIds)
    );
    const codeNameGround = new Set(
      practice.fieldCodeNames
        .map((row) =>
          resolvePracticeSurface(graph, complexes, { venue: row.venue, field: row.remainder })
        )
        .filter((res) => res.status === R.RESOLVED)
        .flatMap((res) => res.surfaceIds)
    );
    const usedDirectly = (id) => usedByGrid.has(id) || ringGround.has(id) || codeNameGround.has(id);
    const usedThroughChildren = [];
    for (const node of SEASON_2026_PRACTICE_LAYER.surfaces) {
      const id = pid(node.venue, node.field, node.subunit);
      if (usedDirectly(id)) continue;
      // A parent whose children are used is used through them.
      const children = graph.surfaces[id].childIds;
      expect(
        children.length,
        `${id} is declared and nothing in the corpus uses it`
      ).toBeGreaterThan(0);
      expect(children.some(usedDirectly), `${id}: no child is used either`).toBe(true);
      usedThroughChildren.push(id);
    }
    expect(usedByGrid.size).toBeGreaterThan(20);
    expect(ringGround.size).toBeGreaterThan(0);
    expect(codeNameGround.size).toBeGreaterThan(0);
    // Brookside's Lower is booked only by halves; Rookery's turf only through
    // the practice ring's 2A/2B. Both are named so a third cannot slip in.
    expect(usedThroughChildren).toEqual([
      pid('Brookside Park', 'Lower'),
      pid('Rookery Park', 'Turf Field 2'),
    ]);
  });

  it('reports a practice on unresolved ground instead of dropping it', () => {
    const front = slots.find((slot) => slot.venue === 'Maplewood' && slot.field === 'Front');
    expect(front).toBeDefined();
    expect(resolveSlot(front).surfaceIds).toEqual([]);
    // What a name-keyed producer would mint for it is not a surface the graph holds.
    const minted = `${front.venue}/${front.field}/${front.subunit}`;
    const scan = findFacilityConflicts(graph, [
      booking(front.id, minted, '2026-09-15', front.startMinutes, front.endMinutes),
    ]);
    expect(scan.unknownSurface).toHaveLength(1);
    expect(scan.unknownSurface[0].code).toBe(FACILITY_REASON.SURFACE_UNKNOWN);
  });
});

/* -------------------------------------------------------------------------- */
/* The extension refuses malformed layers                                     */
/* -------------------------------------------------------------------------- */

describe('practice layer :: the extension refuses a layer that re-declares or dangles', () => {
  const base = () => toSeason2026FacilityGraphInput(geometry);
  const node = (overrides) => ({
    venue: ALDER,
    field: 'Pitch 2A',
    subunit: null,
    parent: 'Pitch 2',
    sources: [],
    ...overrides,
  });

  it('rejects a venue the game layer already has', () => {
    expect(() =>
      extendFacilityGraphInputWithSeason2026PracticeLayer(base(), {
        venues: [{ name: ALDER, lit: null, notes: null, sources: [] }],
        surfaces: [],
      })
    ).toThrow(/already in the game layer/);
  });

  it('rejects a surface at a venue neither layer declares', () => {
    expect(() =>
      extendFacilityGraphInputWithSeason2026PracticeLayer(base(), {
        venues: [],
        surfaces: [node({ venue: 'Nowhere Park', parent: null })],
      })
    ).toThrow(/names a venue neither layer declares/);
  });

  it('rejects a sub-unit that also names a parent: its parent is its field', () => {
    expect(() =>
      extendFacilityGraphInputWithSeason2026PracticeLayer(base(), {
        venues: [],
        surfaces: [node({ subunit: 'Side 1', parent: 'Pitch 9' })],
      })
    ).toThrow(/a sub-unit's parent is its field/);
    expect(() =>
      extendFacilityGraphInputWithSeason2026PracticeLayer(base(), {
        venues: [],
        surfaces: [node({ subunit: 'Side 1', parent: 'Pitch 2' })],
      })
    ).toThrow(/a sub-unit's parent is its field/);
  });

  it('rejects a parent no layer declares, and a sub-unit of an unknown field', () => {
    expect(() =>
      extendFacilityGraphInputWithSeason2026PracticeLayer(base(), {
        venues: [],
        surfaces: [node({ parent: 'Pitch 9' })],
      })
    ).toThrow(/names parent "Pitch 9"/);
    expect(() =>
      extendFacilityGraphInputWithSeason2026PracticeLayer(base(), {
        venues: [],
        surfaces: [node({ field: 'Pitch 9', subunit: 'Side 1', parent: null })],
      })
    ).toThrow(/names parent "Pitch 9"/);
  });

  it('rejects a surface declared twice, and one the game layer already holds', () => {
    expect(() =>
      extendFacilityGraphInputWithSeason2026PracticeLayer(base(), {
        venues: [],
        surfaces: [node(), node()],
      })
    ).toThrow(/declared twice/);
    expect(() =>
      extendFacilityGraphInputWithSeason2026PracticeLayer(base(), {
        venues: [],
        surfaces: [node({ field: 'Pitch 1A', parent: 'Pitch 1' })],
      })
    ).toThrow(/declared twice/);
  });

  it('does not mutate the game-layer input it composes over', () => {
    const input = base();
    const before = JSON.stringify(input);
    extendFacilityGraphInputWithSeason2026PracticeLayer(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(SEASON_2026_PRACTICE_LAYER)).toBe(true);
    expect(Object.isFrozen(SEASON_2026_PRACTICE_LAYER.surfaces[0].sources)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Lighting that nothing states                                               */
/* -------------------------------------------------------------------------- */

describe('practice layer :: lighting nobody has stated is reported, not read as unlit', () => {
  const table = buildFormatTimingTableFromSeason2026(loadGameFormats());
  const sunsets = loadSunsets();
  const calendar = buildAvailabilityCalendarFromSeason2026(
    loadFacilityPermits({ seasonYear: Number(sunsets[0].date.slice(0, 4)) }),
    sunsets
  );
  const cedarbrook = sid('Cedarbrook Park', 'Field 1');
  const query = (surfaceId) => ({
    surfaceId,
    date: sunsets[0].date,
    kickoffMinutes: 16 * 60,
    format: '7v7',
  });

  it('resolves a practice-only venue to null lighting from the venue, and says so', () => {
    const resolved = resolveLighting(graph, calendar, cedarbrook);
    expect(resolved).toMatchObject({ lit: null, source: 'venue', lightsOffMinutes: null });
    const result = checkKickoffAvailability(graph, table, calendar, query(cedarbrook));
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain(AVAILABILITY_REASON.LIGHTING_FROM_VENUE);
    expect(codes).toContain(AVAILABILITY_REASON.LIGHTING_UNDECLARED);
    expect(codes).not.toContain(AVAILABILITY_REASON.SUNSET_NOT_BINDING_WHEN_LIT);
    expect(result.lit).toBeNull();
    expect(result.status).not.toBe(AVAILABILITY_STATUS.ALLOWED);
    expect(
      result.findings.find((f) => f.code === AVAILABILITY_REASON.LIGHTING_UNDECLARED).severity
    ).toBe(AVAILABILITY_SEVERITY.COMPROMISE);
    // The sunset rule still carries the ground, conservatively.
    const sunset = result.constraints.find((c) => c.kind === AVAILABILITY_CONSTRAINT.SUNSET);
    expect(sunset.applicable).toBe(true);
    expect(result.meta.lightingRecordsConsulted).toBeGreaterThan(0);
  });

  it('stops reporting the gap the moment a venue states its lighting (positive control)', () => {
    for (const lit of [false, true]) {
      const stated = buildSeason2026PracticeFacilityGraph(geometry, {
        layer: {
          venues: SEASON_2026_PRACTICE_LAYER.venues.map((venue) =>
            venue.name === 'Cedarbrook Park' ? { ...venue, lit } : venue
          ),
          surfaces: SEASON_2026_PRACTICE_LAYER.surfaces,
        },
      });
      const result = checkKickoffAvailability(stated, table, calendar, query(cedarbrook));
      const codes = result.findings.map((f) => f.code);
      expect(codes).not.toContain(AVAILABILITY_REASON.LIGHTING_UNDECLARED);
      expect(result.lit).toBe(lit);
      expect(codes.includes(AVAILABILITY_REASON.SUNSET_NOT_BINDING_WHEN_LIT)).toBe(lit);
    }
    // ... and a game-corpus venue, whose flag is stated, never raises it.
    const alder = checkKickoffAvailability(graph, table, calendar, query(sid(ALDER, 'Pitch 2')));
    expect(alder.findings.map((f) => f.code)).not.toContain(
      AVAILABILITY_REASON.LIGHTING_UNDECLARED
    );
  });
});

describe('practice layer :: declaration order carries no meaning', () => {
  // Round 3, finding 6. Composition resolved each node's parent as it went, so
  // a child written above its parent threw `names parent "...", which no layer
  // declares` -- about a parent declared on the next line. Latent on today's
  // corpus and actively misleading to whoever hit it.
  const reversed = {
    ...SEASON_2026_PRACTICE_LAYER,
    surfaces: [...SEASON_2026_PRACTICE_LAYER.surfaces].reverse(),
  };

  /** The graph reduced to what composition decides, order stripped out. */
  const shapeOf = (subject) =>
    [...subject.surfaceIds].sort().map((id) => ({
      id,
      venueId: subject.surfaces[id].venueId,
      name: subject.surfaces[id].name,
      parentId: subject.surfaces[id].parentId,
      childIds: [...subject.surfaces[id].childIds].sort(),
    }));

  it('has a child declared after its parent to reorder (meta-assertion)', () => {
    // Non-vacuous: reversing really does put at least one child above its
    // parent, so the check below is about the case it claims to be about.
    const positionOf = new Map(
      reversed.surfaces.map((node, index) => [
        season2026PracticeSurfaceId(node.venue, node.field, node.subunit),
        index,
      ])
    );
    const inverted = reversed.surfaces.filter((node, index) => {
      const parentName = node.subunit === null ? node.parent : node.field;
      if (parentName === null) return false;
      const parentIndex = positionOf.get(season2026SurfaceId(node.venue, parentName));
      return parentIndex !== undefined && parentIndex > index;
    });
    expect(inverted.length).toBeGreaterThan(0);
    // ... and the single-pass rule, written out, refuses exactly those.
    const seen = new Set(toSeason2026FacilityGraphInput(geometry).surfaces.map((e) => e.id));
    const refused = [];
    for (const node of reversed.surfaces) {
      const parentName = node.subunit === null ? node.parent : node.field;
      const parentId = parentName === null ? null : season2026SurfaceId(node.venue, parentName);
      if (parentId !== null && !seen.has(parentId)) refused.push(parentId);
      seen.add(season2026PracticeSurfaceId(node.venue, node.field, node.subunit));
    }
    expect(refused.length).toBeGreaterThan(0);
    // Every parent it would have refused is one the layer does declare, which
    // is what made the message a lie.
    const declaredIds = new Set(
      reversed.surfaces.map((node) =>
        season2026PracticeSurfaceId(node.venue, node.field, node.subunit)
      )
    );
    for (const id of refused) expect(declaredIds.has(id), id).toBe(true);
  });

  it('builds the identical graph from a reversed declaration', () => {
    const base = buildFacilityGraph(
      extendFacilityGraphInputWithSeason2026PracticeLayer(toSeason2026FacilityGraphInput(geometry))
    );
    const flipped = buildFacilityGraph(
      extendFacilityGraphInputWithSeason2026PracticeLayer(
        toSeason2026FacilityGraphInput(geometry),
        reversed
      )
    );
    expect(shapeOf(flipped)).toEqual(shapeOf(base));
    expect(shapeOf(base).length).toBe(graph.surfaceIds.length);
    expect(flipped.stats).toEqual(base.stats);
  });

  it('still refuses a parent no layer declares, and says which (positive control)', () => {
    const orphan = {
      ...SEASON_2026_PRACTICE_LAYER,
      surfaces: [
        ...SEASON_2026_PRACTICE_LAYER.surfaces,
        { venue: ALDER, field: 'Pitch 9Z', subunit: null, parent: 'Pitch 9', sources: [] },
      ],
    };
    expect(() =>
      extendFacilityGraphInputWithSeason2026PracticeLayer(
        toSeason2026FacilityGraphInput(geometry),
        orphan
      )
    ).toThrow(/names parent "Pitch 9", which no layer declares/);
  });
});

/* -------------------------------------------------------------------------- */
/* The composed graph, seen by the modules that consume graphs                 */
/* -------------------------------------------------------------------------- */

describe('practice layer :: making Pitch 2 and Pitch 3 parents takes nothing from relocation', () => {
  const formats = ['11v11', '9v9', '7v7', '5v5', '4v4'];

  /**
   * What `replacementSurfacesFor()` offered on `origin/main` at `ba391a9`, on
   * the game graph, transcribed literally.
   *
   * **Not re-derived from the predicate under test.** A round-1 fix widened the
   * rule to "a leaf, or a surface that states sizes of its own" and that moved
   * the *game* graph's set too — Alder Pitch 1 and Pitch 4, 9v9 parents of two
   * 9v9 halves each, joined their own halves as candidates. Every check in this
   * file compared the composed graph against the game graph, and both had
   * moved, so the regression was invisible. The literal below is the fixed
   * point neither graph may drift from.
   */
  const MAIN_GAME_GRAPH_CANDIDATES = Object.freeze({
    '11v11': ['alder-park/pitch-2', 'alder-park/pitch-3', 'riverbend/turf', 'summit-hs/stadium'],
    '9v9': [
      'alder-park/pitch-1a',
      'alder-park/pitch-1b',
      'alder-park/pitch-2',
      'alder-park/pitch-3',
      'alder-park/pitch-4a',
      'alder-park/pitch-4b',
      'brookside-park/upper-1',
      'brookside-park/upper-2',
      'riverbend/turf',
      'summit-hs/stadium',
    ],
    '7v7': [
      'alder-park/pitch-1a',
      'alder-park/pitch-1b',
      'alder-park/pitch-4a',
      'alder-park/pitch-4b',
      'brookside-park/upper-1',
      'brookside-park/upper-2',
      'maplewood-front/field-1',
    ],
    '5v5': [
      'maplewood-back/field-1',
      'maplewood-back/field-2',
      'maplewood-back/field-3',
      'maplewood-back/field-4',
      'maplewood-back/field-5',
      'maplewood-back/field-6',
      'maplewood-back/field-7',
      'maplewood-front/field-1',
    ],
    '4v4': [
      'maplewood-back/field-1',
      'maplewood-back/field-2',
      'maplewood-back/field-3',
      'maplewood-back/field-4',
      'maplewood-back/field-5',
      'maplewood-back/field-6',
      'maplewood-back/field-7',
      'orchard-park/field-1',
      'orchard-park/field-2',
      'orchard-park/field-3',
      'orchard-park/field-4',
      'orchard-park/field-5',
      'orchard-park/field-6',
    ],
  });

  it("leaves the game graph's candidate set exactly where main had it", () => {
    // Control (a): the anchor. The practice layer may not move this set at all.
    let compared = 0;
    for (const format of formats) {
      const offered = replacementSurfacesFor(gameGraph, { format, maxGradesAbove: 1 });
      expect(offered, format).toEqual([...MAIN_GAME_GRAPH_CANDIDATES[format]]);
      compared += offered.length;
    }
    // Meta-assertion: the literal is not an empty table agreeing with an empty
    // answer, and every format contributed.
    expect(compared).toBe(
      formats.reduce((sum, format) => sum + MAIN_GAME_GRAPH_CANDIDATES[format].length, 0)
    );
    expect(compared).toBeGreaterThan(40);
    // The two 9v9 parents this is really about, named so a rule that offered
    // them again would fail here and not only in the totals.
    for (const parent of [sid(ALDER, 'Pitch 1'), sid(ALDER, 'Pitch 4')]) {
      expect(gameGraph.surfaces[parent].sizes).toEqual(['9v9']);
      expect(gameGraph.surfaces[parent].childIds.length).toBe(2);
      expect(MAIN_GAME_GRAPH_CANDIDATES['9v9']).not.toContain(parent);
      expect(replacementSurfacesFor(gameGraph, { format: '9v9', maxGradesAbove: 1 })).not.toContain(
        parent
      );
    }
  });

  it('offers the same replacement ground on the composed graph as on the game graph', () => {
    let compared = 0;
    for (const format of formats) {
      const before = replacementSurfacesFor(gameGraph, { format, maxGradesAbove: 1 });
      const after = replacementSurfacesFor(graph, { format, maxGradesAbove: 1 });
      expect(after, format).toEqual(before);
      // ... and both equal what main offered, so "they agree" cannot be two
      // sets that moved together.
      expect(after, format).toEqual([...MAIN_GAME_GRAPH_CANDIDATES[format]]);
      compared += before.length;
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('offers Pitch 2 and Pitch 3 whole for 11v11 and their halves for nothing', () => {
    // Control (c).
    const eleven = replacementSurfacesFor(graph, { format: '11v11', maxGradesAbove: 1 });
    expect(eleven).toContain(sid(ALDER, 'Pitch 2'));
    expect(eleven).toContain(sid(ALDER, 'Pitch 3'));
    const halves = [
      pid(ALDER, 'Pitch 2A'),
      pid(ALDER, 'Pitch 2B'),
      pid(ALDER, 'Pitch 3A'),
      pid(ALDER, 'Pitch 3B'),
    ];
    let checked = 0;
    for (const half of halves) {
      // The halves are in the graph, state no size, and are offered for no
      // format at all -- not merely absent from the 11v11 answer.
      expect(graph.surfaces[half], half).toBeTruthy();
      expect(graph.surfaces[half].sizes, half).toEqual([]);
      for (const format of formats) {
        expect(
          replacementSurfacesFor(graph, { format, maxGradesAbove: 1 }),
          `${half} ${format}`
        ).not.toContain(half);
        checked += 1;
      }
    }
    expect(checked).toBe(halves.length * formats.length);
  });

  it('never offers a surface and the ground standing on it at once', () => {
    // The invariant the rule exists for, stated over the whole corpus rather
    // than over the four surfaces that showed it.
    let pairsChecked = 0;
    for (const { name, subject } of [
      { name: 'game', subject: gameGraph },
      { name: 'composed', subject: graph },
    ]) {
      for (const format of formats) {
        const offered = replacementSurfacesFor(subject, { format, maxGradesAbove: 1 });
        const set = new Set(offered);
        for (const id of offered) {
          for (const ancestorId of lineageOf(subject, id)) {
            if (ancestorId === id) continue;
            pairsChecked += 1;
            expect(set.has(ancestorId), `${name}/${format}: ${id} under ${ancestorId}`).toBe(false);
          }
        }
      }
    }
    // Meta-assertion: the composed graph really does put offered ground under
    // ancestors, so the loop above tested something.
    expect(pairsChecked).toBeGreaterThan(0);
  });

  it('still drops a parent that states no size of its own (positive control)', () => {
    // Strip Pitch 2's sizes: a parent with children and nothing to rank.
    const input = extendFacilityGraphInputWithSeason2026PracticeLayer(
      toSeason2026FacilityGraphInput(geometry)
    );
    const pitch2 = sid(ALDER, 'Pitch 2');
    const sizeless = buildFacilityGraph({
      ...input,
      surfaces: input.surfaces.map((s) => (s.id === pitch2 ? { ...s, sizes: [], lined: [] } : s)),
    });
    expect(sizeless.surfaces[pitch2].childIds.length).toBeGreaterThan(0);
    expect(replacementSurfacesFor(sizeless, { format: '11v11', maxGradesAbove: 1 })).not.toContain(
      pitch2
    );
    expect(replacementSurfacesFor(graph, { format: '11v11', maxGradesAbove: 1 })).toContain(pitch2);
  });

  it('drops a parent again the moment one of its halves is given a size (positive control)', () => {
    // The other direction, and the one round 1 got wrong. Give Pitch 2A the
    // size its parent has and Pitch 2 stops being the bookable ground.
    const input = extendFacilityGraphInputWithSeason2026PracticeLayer(
      toSeason2026FacilityGraphInput(geometry)
    );
    const pitch2 = sid(ALDER, 'Pitch 2');
    const half = pid(ALDER, 'Pitch 2A');
    const sized = buildFacilityGraph({
      ...input,
      surfaces: input.surfaces.map((s) =>
        s.id === half ? { ...s, sizes: ['11v11'], lined: ['11v11'] } : s
      ),
    });
    const offered = replacementSurfacesFor(sized, { format: '11v11', maxGradesAbove: 1 });
    expect(offered).toContain(half);
    expect(offered).not.toContain(pitch2);
    // ... and the unmodified graph still offers the pitch, so the difference is
    // the half's size and nothing else.
    expect(replacementSurfacesFor(graph, { format: '11v11', maxGradesAbove: 1 })).toContain(pitch2);
  });

  it('drops a parent whose sized ground is a grandchild, not a child (positive control)', () => {
    // The forest is two deep at Alder (`Pitch 1A -> Pitch 1A Side 1`), so the
    // rule walks the subtree. A rule reading only the immediate children would
    // offer Pitch 1A here *and* its sized Side 1, which is the same
    // double-count one level down.
    const input = extendFacilityGraphInputWithSeason2026PracticeLayer(
      toSeason2026FacilityGraphInput(geometry)
    );
    const parent = sid(ALDER, 'Pitch 1A');
    const grandchild = pid(ALDER, 'Pitch 1A', 'Side 1');
    expect(input.surfaces.find((s) => s.id === grandchild)).toBeTruthy();
    const deep = buildFacilityGraph({
      ...input,
      surfaces: input.surfaces.map((s) =>
        s.id === grandchild ? { ...s, sizes: ['9v9'], lined: ['9v9'] } : s
      ),
    });
    expect(deep.surfaces[parent].childIds).toContain(grandchild);
    const offered = replacementSurfacesFor(deep, { format: '9v9', maxGradesAbove: 1 });
    expect(offered).toContain(grandchild);
    expect(offered).not.toContain(parent);
    expect(replacementSurfacesFor(graph, { format: '9v9', maxGradesAbove: 1 })).toContain(parent);
  });

  it('counts Pitch 1 family capacity once per patch of ground, not once per level', () => {
    // Control (b): the consequence the candidate set has downstream.
    // `reserve/conditions.js` omits OCCUPIED_PARENT_CHILD from its slot
    // conditions because the ground it is handed is leaf ground; offer a parent
    // beside its halves and the same seven kickoffs are counted three times.
    const timingTable = buildFormatTimingTableFromSeason2026(loadGameFormats());
    const seasonSunsets = loadSunsets();
    const seasonCalendar = buildAvailabilityCalendarFromSeason2026(
      loadFacilityPermits({ seasonYear: Number(seasonSunsets[0].date.slice(0, 4)) }),
      seasonSunsets
    );
    const schedule = toSeason2026Schedule(season);
    const DATE = '2026-09-19';
    const familyOf = (report) =>
      report.dates[0].bySurface.filter((row) => row.surfaceId.startsWith(sid(ALDER, 'Pitch 1')));
    const subjectOver = (surfaceIds) =>
      season2026CapacitySubjects({
        graph: gameGraph,
        table: timingTable,
        format: '9v9',
        dates: [DATE],
        surfaceIds,
        requirement: { slots: 1, label: 'round-2 control', source: 'tests' },
        games: schedule.games,
      })[0];
    const reportOver = (surfaceIds) =>
      buildReserveCapacityReport(
        { graph: gameGraph, table: timingTable, calendar: seasonCalendar },
        subjectOver(surfaceIds)
      );
    // What one half holds on that date, derived from the permit rows and the 9v9 timing alone
    // (since the owner's decision of 2026-11-02 sunset only warns, so the permit is what stops
    // the day), not read from either report.
    const { cadenceMinutes, earliestKickoffMinutes } = subjectOver([pid(ALDER, 'Pitch 1A')]);
    const perHalf = expectedReserveKickoffs({
      graph: gameGraph,
      calendar: seasonCalendar,
      surfaceId: pid(ALDER, 'Pitch 1A'),
      date: DATE,
      occupancyMinutes: requireFormatTiming(timingTable, '9v9').occupancyMinutes.scheduled,
      earliestKickoffMinutes,
      cadenceMinutes,
    });
    expect(perHalf.length).toBeGreaterThan(0);

    const policy = season2026RelocationPolicy({
      graph: gameGraph,
      table: timingTable,
      format: '9v9',
      excludeVenueIds: [],
      games: schedule.games,
    });
    expect(policy.surfaceIds).toEqual([...MAIN_GAME_GRAPH_CANDIDATES['9v9']]);

    const honest = familyOf(reportOver(policy.surfaceIds));
    expect(honest.map((row) => row.surfaceId)).toEqual([
      pid(ALDER, 'Pitch 1A'),
      pid(ALDER, 'Pitch 1B'),
    ]);
    const free = honest.reduce((sum, row) => sum + row.slots, 0);
    expect(free).toBe(2 * perHalf.length);

    // The wrong implementation, written out: the round-1 rule offered the
    // sized parent too. Same report, three rows, twenty-one slots -- and the
    // rows carry the *same* kickoff minutes, so it is one hour counted thrice
    // rather than new ground found.
    const triple = familyOf(reportOver([...policy.surfaceIds, sid(ALDER, 'Pitch 1')].sort()));
    expect(triple.map((row) => row.surfaceId)).toEqual([
      sid(ALDER, 'Pitch 1'),
      pid(ALDER, 'Pitch 1A'),
      pid(ALDER, 'Pitch 1B'),
    ]);
    expect(triple.reduce((sum, row) => sum + row.slots, 0)).toBe(3 * perHalf.length);
    const kickoffs = triple.map((row) => JSON.stringify(row.kickoffMinutes));
    expect(new Set(kickoffs).size).toBe(1);
    expect(JSON.parse(kickoffs[0])).toEqual(perHalf);
    // ... and the parent really does exclude its halves, so the extra seven are
    // not free ground by any reading.
    expect(
      surfacesConflict(gameGraph, sid(ALDER, 'Pitch 1'), pid(ALDER, 'Pitch 1A')).conflict
    ).toBe(true);
  });
});

describe('practice layer :: the sunset rule claims LIGHTING_UNDECLARED, so the engine keeps it', () => {
  const table = buildFormatTimingTableFromSeason2026(loadGameFormats());
  const sunsets = loadSunsets();
  const calendar = buildAvailabilityCalendarFromSeason2026(
    loadFacilityPermits({ seasonYear: Number(sunsets[0].date.slice(0, 4)) }),
    sunsets
  );
  const registry = buildSeason2026ConstraintRegistry();
  const base = toSeason2026Schedule(season);
  const cedarbrook = sid('Cedarbrook Park', 'Field 1');
  // One published game moved onto ground nobody has declared lit or unlit.
  const moved = base.games[0];
  const schedule = {
    ...base,
    name: 'season-2026 with one game on undeclared-lighting ground',
    games: base.games.map((game) => (game === moved ? { ...game, surfaceId: cedarbrook } : game)),
    surfaceUniverse: [...new Set([...base.surfaceUniverse, cedarbrook])].sort(),
    venueUniverse: [
      ...new Set([...base.venueUniverse, season2026VenueId('Cedarbrook Park')]),
    ].sort(),
  };
  const resources = { graph, timingTable: table, calendar, venueComplexes: complexes };
  const run = runRuleEngine(schedule, { registry, resources });
  const sunset = run.byRuleId[RULE_ID.SUNSET_MARGIN];

  it('reports the undeclared lighting on the moved game in the rule-engine report', () => {
    expect(sunset.ran).toBe(true);
    expect(sunset.exercise.counters.lightingUndeclaredGamesExamined).toBe(1);
    expect(
      sunset.exercise.counters.unlitGamesExamined + sunset.exercise.counters.litGamesExamined
    ).toBe(schedule.games.length - 1);
    const mine = sunset.subjects.filter((subject) =>
      subject.findings.some((f) => f.code === AVAILABILITY_REASON.LIGHTING_UNDECLARED)
    );
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine[0].context ?? mine[0])).toContain(moved.id);
  });

  it('would lose the finding without the claim: unclaimed codes from the same check are gone', () => {
    // checkKickoffAvailability() emits LIGHTING_FROM_VENUE for every game;
    // the rule does not claim it, so the engine discards it. The claim is
    // what keeps LIGHTING_UNDECLARED, and the test above would fail if the
    // claim were removed from SUNSET_CODES.
    const kept = new Set(sunset.subjects.flatMap((s) => s.findings.map((f) => f.code)));
    expect(kept.has(AVAILABILITY_REASON.LIGHTING_UNDECLARED)).toBe(true);
    expect(kept.has(AVAILABILITY_REASON.LIGHTING_FROM_VENUE)).toBe(false);
    // ... and on the unmodified schedule, over the game graph, it never fires.
    const clean = runRuleEngine(base, {
      registry,
      resources: { ...resources, graph: gameGraph },
    }).byRuleId[RULE_ID.SUNSET_MARGIN];
    expect(clean.exercise.counters.lightingUndeclaredGamesExamined).toBe(0);
    expect(
      clean.subjects.some((s) =>
        s.findings.some((f) => f.code === AVAILABILITY_REASON.LIGHTING_UNDECLARED)
      )
    ).toBe(false);
  });

  it('answers lit: null for ground the graph does not hold, and counts it nowhere', () => {
    // Round 2, finding 4. The early-return template shipped `lit: false`, so a
    // kickoff on a surface the graph has never heard of reported the ground
    // unlit -- an absence wearing a fact's clothes -- and `scanKickoffs()`
    // counted it toward `unlitGamesExamined`, the sunset rule's own exercise
    // minimum. A schedule whose only "unlit" games stood on unknown ground
    // would clear that floor having examined none.
    const nowhere = 'no-such-venue/no-such-field';
    expect(graph.surfaces[nowhere]).toBeUndefined();
    const answer = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: nowhere,
      date: base.games[0].date,
      kickoffMinutes: 600,
      format: base.games[0].format,
    });
    expect(answer.lit).toBeNull();
    expect(answer.lighting).toBeNull();
    expect(answer.findings.map((f) => f.code)).toContain(FACILITY_REASON.SURFACE_UNKNOWN);
    // The sibling answers the same way on the same query.
    const latest = latestLegalKickoff(graph, table, calendar, {
      surfaceId: nowhere,
      date: base.games[0].date,
      format: base.games[0].format,
      notAfterMinutes: 1200,
    });
    expect(latest.lit).toBeNull();

    // The other half of the contract: on ground that *is* in the graph but has
    // no lighting flag, `latestLegalKickoff()` reads `lit` with `=== true` /
    // `!== true`, as its sibling `lightingConstraint()` does, so the daylight
    // limit applies exactly as it does to declared-unlit ground.
    // A format with a timing row, so the search runs rather than returning on
    // FORMAT_TIMING_UNDEFINED.
    const timed = base.games.find((game) => table.formats?.[game.format]);
    expect(timed).toBeTruthy();
    const ceilingOn = (surfaceId) =>
      latestLegalKickoff(graph, table, calendar, {
        surfaceId,
        date: timed.date,
        format: timed.format,
        notAfterMinutes: 22 * 60,
      });
    const undeclared = ceilingOn(cedarbrook);
    const unlit = ceilingOn(sid(ALDER, 'Pitch 2'));
    expect(undeclared.lit).toBeNull();
    expect(unlit.lit).toBe(false);
    const dusk = (undeclared.sunsetMinutes ?? 0) - calendar.sunsetMarginMinutes;
    // Non-vacuous: dusk is well inside the caller's own ceiling.
    expect(dusk).toBeLessThan(22 * 60);
    // Since the owner's decision of 2026-11-02 ("Yes to legal-with-a-warning for kickoffs after
    // sunset, because some orgs have portable lighting or other workarounds.") the daylight limit
    // does not bound the search: each ground's ceiling is its own permit close less the occupancy,
    // derived from the permit rows, and dusk is not in it.
    for (const { answer, surfaceId } of [
      { answer: undeclared, surfaceId: cedarbrook },
      { answer: unlit, surfaceId: sid(ALDER, 'Pitch 2') },
    ]) {
      // Ground with no permit row (Cedarbrook has none) is bounded by nothing but the caller.
      const close =
        resolvePermitWindow(calendar, {
          venueId: graph.surfaces[surfaceId].venueId,
          date: timed.date,
        }).window?.closeMinutes ?? null;
      expect(answer.searchedToMinutes).toBe(
        close === null ? 22 * 60 : Math.min(close - (answer.occupancyMinutes ?? 0), 22 * 60)
      );
      expect(answer.searchedToMinutes).toBeGreaterThan(dusk - (answer.occupancyMinutes ?? 0));
    }
    // Undeclared ground is still treated as unlit, and that is now visible as the warning: the
    // minute after the clean bound carries SUNSET_MARGIN_VIOLATED on undeclared and declared-unlit
    // ground alike, the minute before it does not, and lit ground never does.
    const cleanLatest = dusk - (undeclared.occupancyMinutes ?? 0);
    const sunsetWarning = (surfaceId, kickoffMinutes) =>
      checkKickoffAvailability(graph, table, calendar, {
        surfaceId,
        date: timed.date,
        kickoffMinutes,
        format: timed.format,
      })
        .findings.map((f) => f.code)
        .includes(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
    for (const surfaceId of [cedarbrook, sid(ALDER, 'Pitch 2')]) {
      expect(sunsetWarning(surfaceId, cleanLatest), surfaceId).toBe(false);
      expect(sunsetWarning(surfaceId, cleanLatest + 1), surfaceId).toBe(true);
    }
    expect(sunsetWarning(sid('Summit HS', 'Stadium'), cleanLatest + 1)).toBe(false);

    // ... and the rule engine's counters move accordingly: one more game on
    // unknown ground is one more *undeclared*, not one more unlit.
    // A game the graph calls *unlit*, so the bucket it leaves is a stated one
    // and "moved out of unlit" is a fact rather than an assumption.
    const lost = base.games.find((game) => litOf(game, table, calendar) === false);
    expect(lost).toBeTruthy();
    const strayed = {
      ...base,
      name: 'season-2026 with one game on ground the graph does not hold',
      games: base.games.map((game) => (game === lost ? { ...game, surfaceId: nowhere } : game)),
      surfaceUniverse: [...new Set([...base.surfaceUniverse, nowhere])].sort(),
    };
    const before = runRuleEngine(base, { registry, resources }).byRuleId[RULE_ID.SUNSET_MARGIN];
    const after = runRuleEngine(strayed, { registry, resources }).byRuleId[RULE_ID.SUNSET_MARGIN];
    // Meta-assertion: the baseline really does count unlit games, so "did not
    // move" is a fact about this game rather than about an empty counter.
    expect(before.exercise.counters.unlitGamesExamined).toBeGreaterThan(0);
    expect(after.exercise.counters.unlitGamesExamined).toBe(
      before.exercise.counters.unlitGamesExamined - 1
    );
    // A game whose lighting was never consulted lands in its **own** bucket:
    // not "unlit", and not "declared absent" either. Round 3, finding 3 -- the
    // counter used to be a catch-all `else` and claimed exercise it had not
    // done.
    expect(after.exercise.counters.lightingUndeclaredGamesExamined).toBe(
      before.exercise.counters.lightingUndeclaredGamesExamined
    );
    expect(after.exercise.counters.lightingNotConsultedGamesExamined).toBe(
      before.exercise.counters.lightingNotConsultedGamesExamined + 1
    );
    const sumOf = (run) =>
      run.exercise.counters.litGamesExamined +
      run.exercise.counters.unlitGamesExamined +
      run.exercise.counters.lightingUndeclaredGamesExamined +
      run.exercise.counters.lightingNotConsultedGamesExamined;
    // The four buckets sum to the schedule, on both runs.
    expect(sumOf(before)).toBe(base.games.length);
    expect(sumOf(after)).toBe(strayed.games.length);
    // ... and the declared-absent bucket is the one the Cedarbrook run moves,
    // so the two are told apart by a case each and not by argument.
    expect(sunset.exercise.counters.lightingUndeclaredGamesExamined).toBe(1);
    expect(sunset.exercise.counters.lightingNotConsultedGamesExamined).toBe(0);
  });

  /** What the graph says about the ground one game stands on, before it strays. */
  function litOf(game, timingTable, seasonCalendar) {
    return checkKickoffAvailability(graph, timingTable, seasonCalendar, {
      surfaceId: game.surfaceId,
      date: game.date,
      kickoffMinutes: game.startMinutes,
      format: game.format,
    }).lit;
  }
});
