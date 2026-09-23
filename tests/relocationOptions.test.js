/**
 * #53 — the relocation proposer and the games solver: relocation proposes,
 * `resolve/` decides.
 *
 * Three things are under test, each against the season corpus rather than a
 * rig, because every case below was measured there first:
 *
 * - **A machine-chosen slot goes through the rule gate.** Before #53 a
 *   proposal arrived as a change request and `change-request-apply` wrote it
 *   without asking anything (the gate lived only in `chooseSlot()`); 7 of the
 *   30 pass-2 games, handed to the proposer alone, got a slot that
 *   double-booked a coach, and all 7 stood.
 * - **One definition of "better".** Proposals and options are ranked clean
 *   first, then by `scoreObjective()`, then by `candidateSlotsFor()`'s
 *   tie-break.
 * - **Options, not moves, on the live path.** A game left TIME TBD or placed
 *   on a coach overlap is offered up to three cross-venue options; an approval
 *   is judged again when it is applied.
 *
 * Each `describe` names the fragility it guards (the #53 plan's list, 1-10).
 * Every one was broken on purpose and shown to go red before this file was
 * committed; the break is stated beside the test.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { buildAvailabilityCalendarFromSeason2026 } from '@squadlogic/core/availability/index.js';
import { buildSeason2026ConstraintRegistry } from '@squadlogic/core/constraints/index.js';
import {
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
import { buildFormatTimingTableFromSeason2026 } from '@squadlogic/core/timing/index.js';
import { toSeason2026Schedule } from '@squadlogic/core/ruleEngine/index.js';
import {
  CHANGE_ORIGIN,
  RESOLVE_OBJECTIVE_WEIGHTS,
  applyChangeRequest,
  changeCountsFor,
  createPlacementProbe,
  relocationOptionId,
  scoreObjective,
} from '@squadlogic/core/resolve/index.js';
import { freezeAllExcept } from '@squadlogic/core/freeze/index.js';
import {
  proposeRelocations,
  rankReplacementOptions,
  season2026RelocationPolicy,
} from '@squadlogic/core/scenario/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus and engines                                                          */
/* -------------------------------------------------------------------------- */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sunsets = loadSunsets();
const graph = buildFacilityGraphFromSeason2026(loadFacilityGeometry());
const timingTable = buildFormatTimingTableFromSeason2026(loadGameFormats());
const calendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: Number(sunsets[0].date.slice(0, 4)) }),
  sunsets
);
const venueComplexes = buildSeason2026VenueComplexMap();
const engines = {
  graph,
  table: timingTable,
  calendar,
  registry: buildSeason2026ConstraintRegistry(),
  resources: { graph, timingTable, calendar, venueComplexes },
};
const schedule = toSeason2026Schedule(loadSeason2026());
const byId = new Map(schedule.games.map((game) => [game.id, game]));

/** @param {{ date: string, surfaceId: string, startMinutes: number }} game */
const slotOf = (game) => ({
  date: game.date,
  surfaceId: game.surfaceId,
  startMinutes: game.startMinutes,
});
/** @param {{ date: string, surfaceId: string, startMinutes: number }} slot */
const keyOf = (slot) => `${slot.date}|${slot.surfaceId}|${slot.startMinutes}`;

/** One stated search per format the corpus plays, the scenario adapter's. */
const policies = Object.fromEntries(
  ['Minis', '4v4', '5v5', '7v7', '9v9', '11v11'].map((format) => [
    format,
    season2026RelocationPolicy({
      graph,
      table: timingTable,
      format,
      excludeVenueIds: [],
      games: schedule.games,
    }),
  ])
);

const noOp = schedule.games[0];
const baselineVerification = applyChangeRequest({
  schedule,
  changes: [{ gameId: noOp.id, ...slotOf(noOp), reason: 'the baseline verdict' }],
  engines,
  verify: true,
  onUnsatisfiable: 'report',
}).verification;

/**
 * The #59/#61 displacement workload: pin a same-format game from another
 * kickoff on `displacedId`'s slot, with the date thawed.
 *
 * @param {string} displacedId
 * @param {{ extra?: Object[], search?: Object|null }} [options]
 */
function displace(displacedId, { extra = [], search = { policies } } = {}) {
  const displaced = /** @type {any} */ (byId.get(displacedId));
  const requested = /** @type {any} */ (
    schedule.games.find(
      (game) =>
        game.id !== displaced.id &&
        game.date === displaced.date &&
        game.venueId === displaced.venueId &&
        game.format === displaced.format &&
        game.startMinutes !== displaced.startMinutes
    )
  );
  return /** @type {any} */ (
    applyChangeRequest({
      schedule,
      changes: [{ gameId: requested.id, ...slotOf(displaced), reason: 'displace' }, ...extra],
      engines,
      freeze: freezeAllExcept([{ date: displaced.date }]),
      holdChanges: true,
      verify: true,
      baselineVerification,
      onUnsatisfiable: 'report',
      ...(search === null ? {} : { relocationSearch: search }),
    })
  );
}

const whereIs = (run, gameId) => run.schedule.games.find((game) => game.id === gameId) ?? null;
const codesFor = (run, gameId) =>
  run.findings.filter((finding) => finding.details?.gameId === gameId).map((f) => f.code);
const entryFor = (run, gameId) => run.relocationOptions.find((entry) => entry.gameId === gameId);

// #7 displaced: the placer's pass 2 puts it on coach Gray's overlap (#61).
const G = 'combined_schedule.csv#7';
const runG = displace(G);
const entryG = entryFor(runG, G);
const topG = entryG.options[0];

/* -------------------------------------------------------------------------- */
/* The options surface                                                         */
/* -------------------------------------------------------------------------- */

describe('cross-venue options are offered, never applied', () => {
  it('offers a pass-2 game up to three options away from its own venue', () => {
    expect(entryG.trigger).toBe('coach-overlap');
    expect(entryG.candidatesConsidered).toBeGreaterThan(0);
    expect(entryG.options.length).toBeGreaterThanOrEqual(1);
    expect(entryG.options.length).toBeLessThanOrEqual(3);
    for (const option of entryG.options) {
      expect(option.toVenueId).not.toBe(byId.get(G)?.venueId);
      expect(option.clearsRuleGate).toBe(true);
      expect(option.travelImpact).toBeNull();
      expect(option.travelImpactKnown).toBe(false);
      expect(option.applyAs.origin).toBe(CHANGE_ORIGIN.APPROVED_OPTION);
      expect(option.optionId).toBe(relocationOptionId(G, option.to));
    }
    expect(codesFor(runG, G)).toContain('RESOLVE_RELOCATION_OPTIONS_OFFERED');
  });

  it('leaves the schedule exactly as the run without the opt-in left it', () => {
    const without = displace(G, { search: null });
    expect(without.relocationOptions).toBeUndefined();
    expect(Object.hasOwn(without, 'relocationOptions')).toBe(false);
    expect(runG.schedule).toEqual(without.schedule);
    expect(whereIs(runG, G)).toEqual(whereIs(without, G));
  });

  it('applies an approved option where it was offered, and pins it there', () => {
    const run = displace(G, { extra: [topG.applyAs], search: null });
    expect(slotOf(/** @type {any} */ (whereIs(run, G)))).toEqual(topG.to);
    expect(codesFor(run, G)).toContain('RESOLVE_CHANGE_APPLIED');
    expect(codesFor(run, G)).not.toContain('RESOLVE_OPTION_STALE');
  });

  it('refuses an approval whose id does not name the slot it moves the game to', () => {
    expect(() =>
      displace(G, {
        extra: [
          { ...topG.applyAs, optionId: relocationOptionId(G, { ...topG.to, startMinutes: 1 }) },
        ],
        search: null,
      })
    ).toThrow(/approved option's id/);
  });
});

/* -------------------------------------------------------------------------- */
/* Fragility 1 and 2: the gate, and who is exempt from it                       */
/* -------------------------------------------------------------------------- */

describe('fragility 1: a machine-chosen slot is gated in change-request-apply', () => {
  // Measured before #53: the proposer, handed #65 displaced, chose
  // brookside-park/upper-1 at 09:00, which double-books a coach; applied as a
  // change request it stood, pinned, with only a warning.
  // Break: delete the origin check in `change-request-apply` -> red.
  const H = 'combined_schedule.csv#65';
  const machineSlot = {
    date: '2026-08-22',
    surfaceId: 'brookside-park/upper-1',
    startMinutes: 540,
  };
  const change = { gameId: H, ...machineSlot, reason: 'a machine chose this slot' };

  it('exercises a slot the gate refuses (meta)', () => {
    const probe = createPlacementProbe({ schedule, engines });
    const judged = probe.evaluate(H, machineSlot);
    expect(judged.overlapsAdded).toBeGreaterThan(0);
    expect(judged.cleared).toBe(false);
  });

  it('refuses it from the proposer, and the game does not stand there', () => {
    const run = displace(H, {
      extra: [{ ...change, origin: CHANGE_ORIGIN.PROPOSER }],
      search: null,
    });
    expect(codesFor(run, H)).toContain('RESOLVE_CHANGE_REFUSED_BY_RULES');
    expect(codesFor(run, H)).not.toContain('RESOLVE_CHANGE_APPLIED');
    const at = whereIs(run, H);
    expect(at === null ? null : keyOf(at)).not.toBe(keyOf(machineSlot));
  });

  it('still applies it from an operator, with the #61 warning (#436 exemption kept)', () => {
    // The stripped-marker control: the same change with no origin is an
    // operator's, and stands.
    const run = displace(H, { extra: [change], search: null });
    expect(codesFor(run, H)).toContain('RESOLVE_CHANGE_APPLIED');
    expect(codesFor(run, H)).toContain('RESOLVE_COACH_OVERLAP_CARRIED');
    expect(keyOf(/** @type {any} */ (whereIs(run, H)))).toBe(keyOf(machineSlot));
  });
});

describe('fragility 2: every change core itself builds states its origin', () => {
  // `origin` is optional and absent reads as `operator`: ~90 test call sites
  // were over the ruling's limit for making it required. So every production
  // site that builds a change must say who chose it.
  // Break: delete `origin: CHANGE_ORIGIN.PROPOSER` from `scenario/run.js` -> red.
  const coreRoot = path.join(ROOT, 'packages/core/src');
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : [];
    });
  const callers = walk(coreRoot).filter((file) => {
    if (file.includes(`${path.sep}resolve${path.sep}`)) return false;
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    return /applyChangeRequest\(\{/.test(code);
  });

  it('finds the production callers (meta)', () => {
    expect(callers.map((file) => path.relative(coreRoot, file))).toEqual(['scenario/run.js']);
  });

  it('marks the scenario proposer’s changes as the proposer’s', () => {
    for (const file of callers) {
      expect(readFileSync(file, 'utf8')).toContain('origin: CHANGE_ORIGIN.PROPOSER');
    }
  });

  it('marks the external-fixture changes (incident 3) as the operator’s', () => {
    const adapter = readFileSync(
      path.join(coreRoot, 'resolve/adapters/season2026ChangeRequest.js'),
      'utf8'
    );
    expect(adapter).toContain('origin: CHANGE_ORIGIN.OPERATOR');
  });
});

/* -------------------------------------------------------------------------- */
/* Fragility 3, 4 and 5: approvals are judged again                              */
/* -------------------------------------------------------------------------- */

// A second game that could stand on #7's top option on its own.
const sharedProbe = createPlacementProbe({ schedule, engines });
const other = /** @type {any} */ (
  schedule.games.find(
    (game) =>
      game.date === topG.to.date &&
      game.venueId !== byId.get(G)?.venueId &&
      game.venueId !== topG.toVenueId &&
      sharedProbe.evaluate(game.id, topG.to).cleared
  )
);
const otherApproval = {
  gameId: other.id,
  ...topG.to,
  reason: 'approved on the same slot',
  origin: CHANGE_ORIGIN.APPROVED_OPTION,
  optionId: relocationOptionId(other.id, topG.to),
  compromiseCodes: sharedProbe.evaluate(other.id, topG.to).compromiseCodes,
};

describe('fragility 3: two approvals of one slot', () => {
  // Break: skip the re-judgement for `approved-option` -> both are applied and
  // `dislodge` lifts one of them.
  const run = displace(G, { extra: [topG.applyAs, otherApproval], search: null });

  it('applies the first and refuses the second as stale', () => {
    expect(codesFor(run, G)).toContain('RESOLVE_CHANGE_APPLIED');
    expect(codesFor(run, other.id)).toContain('RESOLVE_OPTION_STALE');
  });

  it('never double-books the slot and never dislodges either game', () => {
    const onSlot = run.schedule.games.filter((game) => keyOf(game) === keyOf(topG.to));
    expect(onSlot.map((game) => game.id)).toEqual([G]);
    expect(codesFor(run, G)).not.toContain('RESOLVE_GAME_DISLODGED');
    expect(codesFor(run, other.id)).not.toContain('RESOLVE_GAME_DISLODGED');
  });
});

describe('fragility 4: an approval of a slot that has changed since it was offered', () => {
  // Break: drop the compromise-code comparison -> the approval is applied.
  it('is refused when the slot now carries codes the operator was not shown', () => {
    const run = displace(G, {
      extra: [{ ...topG.applyAs, compromiseCodes: ['LINING_MISMATCH'] }],
      search: null,
    });
    expect(codesFor(run, G)).toContain('RESOLVE_OPTION_STALE');
    expect(keyOf(/** @type {any} */ (whereIs(run, G)))).not.toBe(keyOf(topG.to));
  });
});

describe('fragility 5: a refused approval is re-placed from its own ground', () => {
  // `other` takes the slot first, so #7's approval is stale. #7 must then be
  // placed exactly as it is with no approval at all — from its own venue.
  // Break: set `requestedSlots`/`anchors` before the judgement -> the placer
  // searches the refused slot's venue and #7 lands somewhere else.
  it('ends where the run with no approval put it', () => {
    const run = displace(G, { extra: [otherApproval, topG.applyAs], search: null });
    expect(codesFor(run, G)).toContain('RESOLVE_OPTION_STALE');
    const alone = displace(G, { search: null });
    expect(whereIs(run, G)).toEqual(whereIs(alone, G));
    expect(whereIs(run, G)?.venueId).toBe(byId.get(G)?.venueId);
  });
});

/* -------------------------------------------------------------------------- */
/* Fragility 6-10: the options themselves                                       */
/* -------------------------------------------------------------------------- */

describe('fragility 6: the 2-before-3 order is by construction, not by score', () => {
  // #18 displaced: the objective scores its best cross-venue option *worse*
  // than the overlap it was placed on (one of 8 such of the 30).
  // Break: offer only options scoring below where the game stands -> red.
  const id = 'combined_schedule.csv#18';
  const run = displace(id);
  const entry = entryFor(run, id);

  it('is a game the objective would leave on its overlap (meta)', () => {
    const at = /** @type {any} */ (whereIs(run, id));
    const warnings = run.findings.filter(
      (finding) => finding.code === 'RESOLVE_COACH_OVERLAP_CARRIED' && finding.details.gameId === id
    ).length;
    expect(warnings).toBeGreaterThan(0);
    const standing = scoreObjective(
      {
        ...changeCountsFor(slotOf(/** @type {any} */ (byId.get(id))), slotOf(at)),
        compromiseViolation: warnings,
      },
      RESOLVE_OBJECTIVE_WEIGHTS
    ).total;
    expect(entry.options[0].objective.total).toBeGreaterThan(standing);
  });

  it('still offers it options', () => {
    expect(entry.trigger).toBe('coach-overlap');
    expect(entry.options.length).toBeGreaterThan(0);
  });
});

describe('fragility 7: a search that looked at nothing is loud', () => {
  // Break: drop the zero-candidates branch -> "no options", silently.
  it('says so when no search is stated for the format', () => {
    const run = displace(G, { search: { policies: {} } });
    expect(codesFor(run, G)).toContain('RESOLVE_RELOCATION_SEARCH_VACUOUS');
    expect(run.status).toBe('rejected');
    expect(entryFor(run, G).searched).toBe(false);
  });

  it('says so when the stated ground is all at the game’s own venue', () => {
    const format = /** @type {string} */ (byId.get(G)?.format);
    const own = Object.values(graph.surfaces)
      .filter((surface) => surface.venueId === byId.get(G)?.venueId)
      .map((surface) => surface.id);
    const run = displace(G, {
      search: { policies: { [format]: { ...policies[format], surfaceIds: own } } },
    });
    expect(entryFor(run, G).candidatesConsidered).toBe(0);
    expect(codesFor(run, G)).toContain('RESOLVE_RELOCATION_SEARCH_VACUOUS');
  });

  it('tells "looked and found nothing" apart from it', () => {
    const format = /** @type {string} */ (byId.get(G)?.format);
    const run = displace(G, {
      search: {
        policies: { [format]: { ...policies[format], surfaceIds: ['summit-hs/stadium'] } },
      },
    });
    expect(entryFor(run, G).candidatesConsidered).toBeGreaterThan(0);
    expect(codesFor(run, G)).toContain('RESOLVE_RELOCATION_OPTIONS_NONE');
    expect(codesFor(run, G)).not.toContain('RESOLVE_RELOCATION_SEARCH_VACUOUS');
  });
});

describe('fragility 8: a journey too short between venues is shown, not hidden', () => {
  // #7's third option leaves a coach too little time from another venue.
  // Break: stop collecting travel codes in `ruleGateInstances()` -> red.
  it('labels the option and ranks it after every clean one', () => {
    const coded = entryG.options.filter((option) =>
      option.compromiseCodes.includes('TRAVEL_BETWEEN_VENUES_TOO_SHORT')
    );
    expect(coded.length).toBeGreaterThan(0);
    const firstCoded = entryG.options.findIndex((option) => option.compromiseCodes.length > 0);
    expect(entryG.options.slice(firstCoded).every((o) => o.compromiseCodes.length > 0)).toBe(true);
  });
});

describe('fragility 9: clean first, then options labelled by their compromise', () => {
  // Break: rank by score alone -> the cheaper coded option comes first.
  it('puts a clean option ahead of a cheaper one carrying a code', () => {
    const clean = { compromiseCodes: [], score: 1300, startMinutes: 600, surfaceId: 'b' };
    const coded = {
      compromiseCodes: ['LINING_MISMATCH'],
      score: 1100,
      startMinutes: 540,
      surfaceId: 'a',
    };
    expect(rankReplacementOptions([coded, clean])).toEqual([clean, coded]);
  });

  it('fills with LINING_MISMATCH options when no clean one exists (corpus)', () => {
    // #51 displaced (5v5): every cross-venue slot for it is on ground lined
    // for another format — one of 9 of the 30 with no clean option.
    const id = 'combined_schedule.csv#51';
    const entry = entryFor(displace(id), id);
    expect(entry.options.length).toBeGreaterThan(0);
    expect(entry.options.every((o) => o.compromiseCodes.includes('LINING_MISMATCH'))).toBe(true);
  });
});

describe('fragility 10: ties are broken by candidateSlotsFor()’s contract', () => {
  // #65's top two options tie on the objective and differ only by surface.
  // Break: drop the surface-id tie-break -> reversing the stated ground
  // reverses them.
  const id = 'combined_schedule.csv#65';
  const format = /** @type {string} */ (byId.get(id)?.format);
  const forward = entryFor(displace(id), id);

  it('has a tie to break (meta)', () => {
    expect(forward.options[0].objective.total).toBe(forward.options[1].objective.total);
  });

  it('gives the same options whatever order the ground is stated in', () => {
    const reversed = {
      policies: {
        ...policies,
        [format]: { ...policies[format], surfaceIds: [...policies[format].surfaceIds].reverse() },
      },
    };
    expect(entryFor(displace(id, { search: reversed }), id).options).toEqual(forward.options);
  });
});

/* -------------------------------------------------------------------------- */
/* The proposer                                                                 */
/* -------------------------------------------------------------------------- */

describe('proposeRelocations() takes resolve/’s judgement or none', () => {
  it('refuses to run without a probe', () => {
    expect(() =>
      proposeRelocations(
        engines,
        /** @type {any} */ ({
          displaced: [],
          survivors: [],
          gamesById: {},
          policy: policies['7v7'],
          requirement: { slots: 1, label: 'x', source: 'x' },
        })
      )
    ).toThrow(/needs a probe from resolve/);
  });

  it('refuses a policy that still names an ordering of its own', () => {
    expect(() =>
      proposeRelocations(engines, {
        displaced: [],
        survivors: [],
        gamesById: {},
        policy: { ...policies['7v7'], policy: 'prefer-clean' },
        requirement: { slots: 1, label: 'x', source: 'x' },
        probe: createPlacementProbe({ schedule, engines }),
      })
    ).toThrow();
  });
});
