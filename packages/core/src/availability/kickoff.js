/**
 * "How late can this game kick off here?" — and which of the four constraints
 * says so.
 *
 * Four things can stop a kickoff running later than it does:
 *
 * ```text
 * occupancy   something is already standing on conflicting ground
 * lighting    the floodlights go off (or there are none)
 * sunset      sunset less the club's safety margin, on unlit ground
 * permit      the venue's permit closes
 * ```
 *
 * Every one of them is evaluated, every one reports its own `limitMinutes` and
 * its own slack, and the list comes back **ordered by tightness**. The winner is
 * `binding`, but the ordering is the deliverable: Prompt 4.3's explain-why work
 * needs "sunset by 6 minutes, then the permit by 66" — not just "sunset".
 *
 * What this file does **not** contain: an overlap test, a duration constant, or
 * a permit parser. Concurrency is decided by `facility/occupancy.js`, occupancy
 * length comes from the Phase 1.2 format table (`11v11` is 90 minutes because
 * `game_formats.csv` says `85-90 (schedule as 90)`, not because a 90 is typed
 * in here), and the permit records come from the calendar. A second copy of any
 * of the three would be free to disagree with the first.
 *
 * @module availability/kickoff
 */

import { checkBooking } from '../facility/eligibility.js';
import { getSurface } from '../facility/facilityGraph.js';
import { surfacesConflict } from '../facility/occupancy.js';
import { FACILITY_REASON, makeFinding } from '../facility/reasonCodes.js';
import { formatTimingOrUnknown } from '../timing/formatTiming.js';
import {
  absorbFacilityMetaInto,
  createAvailabilityMeta,
  daylightLimitMinutes,
  mergeAvailabilityMeta,
  resolveLighting,
  resolvePermitWindow,
  sunsetOn,
} from './calendar.js';
import {
  AVAILABILITY_CONSTRAINT,
  AVAILABILITY_CONSTRAINT_ORDER,
  AVAILABILITY_REASON,
  AVAILABILITY_SEVERITY,
  availabilitySeverityOf,
  deriveAvailabilityStatus,
  makeAvailabilityFinding,
} from './reasonCodes.js';
import { KickoffAvailabilityQuerySchema, LatestKickoffQuerySchema } from './schemas.js';

/** Booking id used for the candidate this module invents while asking a question. */
const PROBE_BOOKING_ID = '__availability_probe__';

/**
 * Build one constraint record.
 *
 * `slackMinutes` is `limitMinutes - endMinutes`: how much room the kickoff being
 * judged has left against this bound. Negative means the bound is broken, which
 * a separate blocking finding will already have said.
 *
 * @param {string} kind
 * @param {{ applicable: boolean, limitMinutes?: number|null, occupancyMinutes?: number|null, endMinutes?: number|null, source?: string|null, detail?: Record<string, unknown> }} spec
 * @returns {import('./types.js').AvailabilityConstraint}
 */
function makeConstraint(kind, spec) {
  const limitMinutes = spec.limitMinutes ?? null;
  const occupancyMinutes = spec.occupancyMinutes ?? null;
  const endMinutes = spec.endMinutes ?? null;
  return {
    kind,
    applicable: spec.applicable,
    limitMinutes,
    latestKickoffMinutes:
      limitMinutes === null || occupancyMinutes === null ? null : limitMinutes - occupancyMinutes,
    slackMinutes: limitMinutes === null || endMinutes === null ? null : limitMinutes - endMinutes,
    binding: false,
    source: spec.source ?? null,
    detail: spec.detail ?? {},
  };
}

/**
 * Does running past the daylight limit block a kickoff? Read off the severity table, as every
 * finding's severity is, so the limit and the finding it raises cannot disagree.
 *
 * Since the owner's decision of 2026-11-02 ("Yes to legal-with-a-warning for kickoffs after sunset,
 * because some orgs have portable lighting or other workarounds.") `SUNSET_MARGIN_VIOLATED` is a
 * compromise: a kickoff past the limit is legal and carries the warning. The limit is still
 * evaluated, ordered and reported; it just no longer bounds the legal answer or counts as what
 * binds it (the clean bound in `feasibility/` is where it still stops anything). Permit close and
 * lights-off are blocking and stay in.
 *
 * The table is the default. A caller that judges findings under a constraint registry passes
 * `options.sunsetBlocks` with what that registry says for the place asked about, so a what-if that
 * retypes the sunset margin `hard` searches inside daylight and the answer cannot advertise a
 * kickoff its own sunset claim calls blocking (`attribution/explain.js` does).
 *
 * @param {boolean} [override] - the caller's resolved answer, when it has one
 * @returns {boolean}
 */
function sunsetBlocks(override) {
  return (
    override ??
    availabilitySeverityOf(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED) ===
      AVAILABILITY_SEVERITY.BLOCKING
  );
}

/**
 * Sort key for tightness. Smaller binds harder.
 *
 * A stated blackout is `-Infinity` (nothing is legal, so nothing binds harder);
 * an inapplicable constraint is `+Infinity` (it never bounds anything).
 *
 * @param {import('./types.js').AvailabilityConstraint} constraint
 * @returns {number}
 */
function tightnessKey(constraint) {
  if (!constraint.applicable) return Number.POSITIVE_INFINITY;
  if (constraint.limitMinutes === null) return Number.NEGATIVE_INFINITY;
  return /** @type {number} */ (constraint.latestKickoffMinutes ?? constraint.limitMinutes);
}

/**
 * Order the four constraints tightest-first and mark the binding one(s).
 *
 * Ties are broken by {@link AVAILABILITY_CONSTRAINT_ORDER} so two runs over the
 * same data produce the same ordering — and, because ties are real (a permit
 * that closes exactly at the daylight limit binds both), *every* constraint at
 * the tightest position is marked, not just the first.
 *
 * **Only a constraint that can block binds.** The ordering lists all four, but a
 * daylight limit whose breach is a compromise ({@link sunsetBlocks}) is reported
 * in its place and never marked `binding`: it bounds nothing that is legal.
 *
 * @param {import('./types.js').AvailabilityConstraint[]} constraints
 * @param {boolean} [sunsetBlocksOverride] - see {@link sunsetBlocks}
 * @returns {{ constraints: import('./types.js').AvailabilityConstraint[], binding: import('./types.js').AvailabilityConstraint|null, bindingKinds: string[] }}
 */
function orderByTightness(constraints, sunsetBlocksOverride) {
  const ordered = [...constraints].sort((a, b) => {
    const delta = tightnessKey(a) - tightnessKey(b);
    if (delta !== 0 && !Number.isNaN(delta)) return delta < 0 ? -1 : 1;
    return (
      AVAILABILITY_CONSTRAINT_ORDER.indexOf(a.kind) - AVAILABILITY_CONSTRAINT_ORDER.indexOf(b.kind)
    );
  });

  const blocksHere = sunsetBlocks(sunsetBlocksOverride);
  const applicable = ordered.filter(
    (constraint) =>
      constraint.applicable && (constraint.kind !== AVAILABILITY_CONSTRAINT.SUNSET || blocksHere)
  );
  if (applicable.length === 0) return { constraints: ordered, binding: null, bindingKinds: [] };

  const tightest = tightnessKey(applicable[0]);
  const bindingKinds = [];
  for (const constraint of applicable) {
    if (tightnessKey(constraint) !== tightest) continue;
    constraint.binding = true;
    bindingKinds.push(constraint.kind);
  }
  return { constraints: ordered, binding: applicable[0], bindingKinds };
}

/**
 * Bookings standing on ground that conflicts with a surface, on a date.
 *
 * The conflict decision itself is entirely `facility/occupancy.js`'s
 * `surfacesConflict()` — containment, spatial overlap and venue scoping all come
 * from the Phase 1.1 graph. This wrapper only filters by date, drops the
 * caller's own bookings and counts what it looked at.
 *
 * @param {import('../facility/types.js').FacilityGraph} graph
 * @param {string} surfaceId
 * @param {string} date
 * @param {ReadonlyArray<import('../facility/types.js').FacilityBooking>} existingBookings
 * @param {ReadonlyArray<string>} ignoreBookingIds
 * @param {import('./types.js').AvailabilityMeta} meta
 * @returns {import('../facility/types.js').FacilityBooking[]}
 */
function conflictingBookingsOn(graph, surfaceId, date, existingBookings, ignoreBookingIds, meta) {
  const ignored = new Set(ignoreBookingIds);
  const surfacesSeen = new Set([surfaceId]);
  /** @type {import('../facility/types.js').FacilityBooking[]} */
  const out = [];
  for (const booking of existingBookings) {
    if (ignored.has(booking.id)) continue;
    if (booking.date !== date) continue;
    if (!getSurface(graph, booking.surfaceId)) continue;
    meta.bookingPairsCompared += 1;
    surfacesSeen.add(booking.surfaceId);
    const verdict = surfacesConflict(graph, surfaceId, booking.surfaceId);
    meta.cellPairsCompared += verdict.meta.cellPairsCompared;
    meta.overlapPairsConsulted += verdict.meta.overlapPairsConsulted;
    if (verdict.conflict) out.push(booking);
  }
  meta.surfacesConsidered += surfacesSeen.size;
  return out;
}

/**
 * The permit constraint, plus every finding the permit position implies.
 *
 * @param {import('./types.js').AvailabilityCalendar} calendar
 * @param {import('./types.js').ResolvedPermit} resolved
 * @param {{ kickoffMinutes: number|null, endMinutes: number|null, occupancyMinutes: number|null, venueId: string|null, date: string }} ctx
 * @param {import('./types.js').AvailabilityFinding[]} findings
 * @returns {import('./types.js').AvailabilityConstraint}
 */
function permitConstraint(calendar, resolved, ctx, findings) {
  const base = { venueId: ctx.venueId, date: ctx.date };

  if (resolved.window === null) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.PERMIT_UNDECLARED,
        `no permit record covers ${ctx.venueId ?? 'this venue'} on ${ctx.date}, so its opening hours are unknown`,
        base
      )
    );
    return makeConstraint(AVAILABILITY_CONSTRAINT.PERMIT, {
      applicable: false,
      detail: { ...base, reason: 'no permit record' },
    });
  }

  const window = resolved.window;
  findings.push(
    makeAvailabilityFinding(
      resolved.scopeKind === 'date-exception'
        ? AVAILABILITY_REASON.PERMIT_DATE_EXCEPTION
        : AVAILABILITY_REASON.PERMIT_WEEKDAY_DEFAULT,
      resolved.scopeKind === 'date-exception'
        ? `${ctx.date} is governed by a date-scoped permit exception, not by the weekday default`
        : `${ctx.date} is governed by the venue's ${window.weekday} default permit`,
      { ...base, permitId: window.id, scopeKind: window.scopeKind, note: window.note }
    )
  );

  if (resolved.ambiguous) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.PERMIT_PRECEDENCE_AMBIGUOUS,
        `${resolved.candidates.length} permit records apply equally to ${ctx.date}; the most restrictive one (${window.id}) is applied`,
        { ...base, appliedPermitId: window.id, permitIds: resolved.candidates.map((c) => c.id) }
      )
    );
  }

  if (!window.hasPermit) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.PERMIT_BLACKOUT,
        `no permit for ${ctx.venueId ?? 'this venue'} on ${ctx.date}: the site is not available at all${
          window.note ? ` (${window.note})` : ''
        }`,
        { ...base, permitId: window.id, note: window.note }
      )
    );
    return makeConstraint(AVAILABILITY_CONSTRAINT.PERMIT, {
      applicable: true,
      limitMinutes: null,
      source: window.id,
      detail: { ...base, permitId: window.id, blackout: true },
    });
  }

  const openMinutes = /** @type {number} */ (window.openMinutes);
  const closeMinutes = /** @type {number} */ (window.closeMinutes);

  if (ctx.kickoffMinutes !== null && ctx.kickoffMinutes < openMinutes) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.PERMIT_OPEN_PRECEDED,
        `a kickoff at minute ${ctx.kickoffMinutes} precedes the permit open at minute ${openMinutes}`,
        { ...base, permitId: window.id, kickoffMinutes: ctx.kickoffMinutes, openMinutes }
      )
    );
  }

  if (ctx.endMinutes !== null) {
    const slack = closeMinutes - ctx.endMinutes;
    if (slack < 0) {
      findings.push(
        makeAvailabilityFinding(
          AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED,
          `worst-case occupancy ends at minute ${ctx.endMinutes}, ${-slack} min past the permit close at minute ${closeMinutes}`,
          {
            ...base,
            permitId: window.id,
            endMinutes: ctx.endMinutes,
            closeMinutes,
            overrunMinutes: -slack,
          }
        )
      );
    } else if (slack < calendar.permitMarginMinutes) {
      findings.push(
        makeAvailabilityFinding(
          AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT,
          `worst-case occupancy ends at minute ${ctx.endMinutes}, leaving ${slack} min against the permit close at minute ${closeMinutes} — under the ${calendar.permitMarginMinutes} min margin`,
          {
            ...base,
            permitId: window.id,
            endMinutes: ctx.endMinutes,
            closeMinutes,
            marginMinutes: slack,
            requiredMarginMinutes: calendar.permitMarginMinutes,
          }
        )
      );
    }
  }

  return makeConstraint(AVAILABILITY_CONSTRAINT.PERMIT, {
    applicable: true,
    limitMinutes: closeMinutes,
    occupancyMinutes: ctx.occupancyMinutes,
    endMinutes: ctx.endMinutes,
    source: window.id,
    detail: {
      ...base,
      permitId: window.id,
      scopeKind: window.scopeKind,
      openMinutes,
      closeMinutes,
      note: window.note,
    },
  });
}

/**
 * The lighting constraint, plus the provenance of the lighting answer itself.
 *
 * @param {import('./types.js').ResolvedLighting} lighting
 * @param {import('./types.js').PermitWindow|null} permit
 * @param {{ surfaceId: string, endMinutes: number|null, occupancyMinutes: number|null, date: string }} ctx
 * @param {import('./types.js').AvailabilityFinding[]} findings
 * @returns {import('./types.js').AvailabilityConstraint}
 */
function lightingConstraint(lighting, permit, ctx, findings) {
  const base = { surfaceId: ctx.surfaceId, date: ctx.date, lit: lighting.lit };
  const litWord = lighting.lit === null ? 'undeclared' : lighting.lit ? 'lit' : 'unlit';

  const provenance = {
    surface: AVAILABILITY_REASON.LIGHTING_FROM_SURFACE,
    'ancestor-surface': AVAILABILITY_REASON.LIGHTING_FROM_ANCESTOR,
    venue: AVAILABILITY_REASON.LIGHTING_FROM_VENUE,
  }[lighting.source];
  findings.push(
    makeAvailabilityFinding(
      provenance,
      lighting.source === 'venue'
        ? `lighting for this field is taken from its venue's flag (${litWord}); the corpus records no per-field lighting`
        : `lighting for this field is taken from a record on ${lighting.recordId} (${litWord})`,
      { ...base, source: lighting.source, recordId: lighting.recordId }
    )
  );

  if (lighting.lit === null) {
    // Nothing in the graph states it. Reported, and then carried by the
    // sunset rule exactly as unlit ground is: the conservative bound, with the
    // gap visible. The permit paperwork's own claim, when it makes one, is
    // named here rather than applied: it is a claim about the venue, kept
    // beside the graph's for cross-check and not merged into it.
    const permitClaim = permit && permit.lit !== null ? permit.lit : null;
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.LIGHTING_UNDECLARED,
        permitClaim === null
          ? 'no record and no venue flag states whether this field is lit; the sunset rule is applied as for unlit ground'
          : `no record and no venue flag states whether this field is lit; the permit record says ${permitClaim ? 'lit' : 'unlit'} and is not applied; the sunset rule is applied as for unlit ground`,
        {
          ...base,
          source: lighting.source,
          recordId: lighting.recordId,
          permitId: permit?.id ?? null,
          permitLit: permitClaim,
        }
      )
    );
  }

  if (permit && permit.lit !== null && lighting.lit !== null && permit.lit !== lighting.lit) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.LIGHTING_SOURCE_DISAGREES,
        `the permit record says the venue is ${permit.lit ? 'lit' : 'unlit'} while the facility graph says the field is ${lighting.lit ? 'lit' : 'unlit'}; the field record is applied`,
        { ...base, permitId: permit.id, permitLit: permit.lit }
      )
    );
  }

  if (lighting.lit !== true) {
    return makeConstraint(AVAILABILITY_CONSTRAINT.LIGHTING, {
      applicable: false,
      detail: {
        ...base,
        reason:
          lighting.lit === null
            ? 'lighting is undeclared, so no lights-off time exists; the sunset rule carries it'
            : 'unlit ground has no lights-off time; the sunset rule carries it',
      },
    });
  }

  if (lighting.lightsOffMinutes === null) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.LIGHTS_OFF_UNDECLARED,
        'this field is lit but no lights-off time is recorded, so lighting imposes no bound of its own',
        { ...base, recordId: lighting.recordId }
      )
    );
    return makeConstraint(AVAILABILITY_CONSTRAINT.LIGHTING, {
      applicable: false,
      detail: { ...base, reason: 'no lights-off time recorded' },
    });
  }

  const lightsOff = lighting.lightsOffMinutes;
  if (ctx.endMinutes !== null && ctx.endMinutes > lightsOff) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.LIGHTS_OFF_EXCEEDED,
        `worst-case occupancy ends at minute ${ctx.endMinutes}, past the lights-off time at minute ${lightsOff}`,
        { ...base, endMinutes: ctx.endMinutes, lightsOffMinutes: lightsOff }
      )
    );
  }

  return makeConstraint(AVAILABILITY_CONSTRAINT.LIGHTING, {
    applicable: true,
    limitMinutes: lightsOff,
    occupancyMinutes: ctx.occupancyMinutes,
    endMinutes: ctx.endMinutes,
    source: lighting.recordId,
    detail: { ...base, lightsOffMinutes: lightsOff },
  });
}

/**
 * The sunset constraint: daylight less the club's safety margin, on unlit ground.
 *
 * @param {import('./types.js').AvailabilityCalendar} calendar
 * @param {import('./types.js').ResolvedLighting} lighting
 * @param {{ surfaceId: string, date: string, endMinutes: number|null, occupancyMinutes: number|null }} ctx
 * @param {import('./types.js').AvailabilityFinding[]} findings
 * @returns {import('./types.js').AvailabilityConstraint}
 */
function sunsetConstraint(calendar, lighting, ctx, findings) {
  const base = { surfaceId: ctx.surfaceId, date: ctx.date };
  const record = sunsetOn(calendar, ctx.date);

  if (lighting.lit === true) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.SUNSET_NOT_BINDING_WHEN_LIT,
        `this field is lit, so sunset${record ? ` (minute ${record.sunsetMinutes})` : ''} does not bound it`,
        { ...base, sunsetMinutes: record?.sunsetMinutes ?? null }
      )
    );
    return makeConstraint(AVAILABILITY_CONSTRAINT.SUNSET, {
      applicable: false,
      detail: { ...base, reason: 'the field is lit', sunsetMinutes: record?.sunsetMinutes ?? null },
    });
  }

  if (record === null) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.SUNSET_UNKNOWN,
        `no sunset is recorded for ${ctx.date}, so the daylight rule cannot be applied to unlit ground`,
        base
      )
    );
    return makeConstraint(AVAILABILITY_CONSTRAINT.SUNSET, {
      applicable: false,
      detail: { ...base, reason: 'no sunset record' },
    });
  }

  const limit = /** @type {number} */ (daylightLimitMinutes(calendar, ctx.date));
  if (ctx.endMinutes !== null && ctx.endMinutes > limit) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED,
        `worst-case occupancy ends at minute ${ctx.endMinutes}, past the daylight limit of minute ${limit} (sunset ${record.sunsetMinutes} less a ${calendar.sunsetMarginMinutes} min margin) on unlit ground`,
        {
          ...base,
          endMinutes: ctx.endMinutes,
          limitMinutes: limit,
          sunsetMinutes: record.sunsetMinutes,
          sunsetMarginMinutes: calendar.sunsetMarginMinutes,
        }
      )
    );
  }

  return makeConstraint(AVAILABILITY_CONSTRAINT.SUNSET, {
    applicable: true,
    limitMinutes: limit,
    occupancyMinutes: ctx.occupancyMinutes,
    endMinutes: ctx.endMinutes,
    source: ctx.date,
    detail: {
      ...base,
      sunsetMinutes: record.sunsetMinutes,
      sunsetMarginMinutes: calendar.sunsetMarginMinutes,
      limitMinutes: limit,
    },
  });
}

/**
 * The occupancy constraint: the next thing already standing on conflicting
 * ground.
 *
 * Only bookings that start at or after the kickoff bound the *end* of this game.
 * One that starts earlier and runs into it is a collision, which
 * `facility/occupancy.js` reports in its own words rather than as a bound.
 *
 * @param {import('../facility/types.js').FacilityGraph} graph
 * @param {ReadonlyArray<import('../facility/types.js').FacilityBooking>} conflicting
 * @param {{ surfaceId: string, date: string, kickoffMinutes: number, endMinutes: number|null, occupancyMinutes: number|null }} ctx
 * @param {import('./types.js').AvailabilityFinding[]} findings
 * @returns {import('./types.js').AvailabilityConstraint}
 */
function occupancyConstraint(graph, conflicting, ctx, findings) {
  const base = { surfaceId: ctx.surfaceId, date: ctx.date };
  const after = conflicting.filter((booking) => booking.startMinutes >= ctx.kickoffMinutes);

  if (after.length === 0) {
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.OCCUPANCY_UNBOUNDED,
        `nothing already booked on conflicting ground starts after minute ${ctx.kickoffMinutes}`,
        { ...base, kickoffMinutes: ctx.kickoffMinutes }
      )
    );
    return makeConstraint(AVAILABILITY_CONSTRAINT.OCCUPANCY, {
      applicable: false,
      detail: { ...base, reason: 'nothing is booked after this kickoff' },
    });
  }

  const limit = Math.min(...after.map((booking) => booking.startMinutes));
  const binding = after
    .filter((booking) => booking.startMinutes === limit)
    .sort((a, b) => a.id.localeCompare(b.id));
  const first = binding[0];

  findings.push(
    makeAvailabilityFinding(
      AVAILABILITY_REASON.OCCUPANCY_BOUND_BY_BOOKING,
      `the next booking on conflicting ground (${binding
        .map((booking) => booking.label ?? booking.id)
        .join(', ')}) starts at minute ${limit}`,
      {
        ...base,
        limitMinutes: limit,
        boundByBookingIds: binding.map((booking) => booking.id),
        boundBySurfaceIds: [...new Set(binding.map((booking) => booking.surfaceId))].sort(),
        boundBySameSurface: binding.every((booking) => booking.surfaceId === ctx.surfaceId),
      }
    )
  );

  return makeConstraint(AVAILABILITY_CONSTRAINT.OCCUPANCY, {
    applicable: true,
    limitMinutes: limit,
    occupancyMinutes: ctx.occupancyMinutes,
    endMinutes: ctx.endMinutes,
    source: first.id,
    detail: {
      ...base,
      limitMinutes: limit,
      boundByBookingIds: binding.map((booking) => booking.id),
      boundBySurfaceIds: [...new Set(binding.map((booking) => booking.surfaceId))].sort(),
      boundBySurfaceNames: [
        ...new Set(binding.map((booking) => getSurface(graph, booking.surfaceId)?.name ?? null)),
      ],
    },
  });
}

/**
 * Is this kickoff legal on this ground on this date — and how close to each of
 * the four edges is it?
 *
 * Returns **all** findings, never the first hit: a booking can be permit-tight
 * *and* lining-compromised at once, and an operator who sees only the first
 * fixes the wrong thing.
 *
 * @param {import('../facility/types.js').FacilityGraph} graph
 * @param {import('../timing/types.js').FormatTimingTable} table
 * @param {import('./types.js').AvailabilityCalendar} calendar
 * @param {Object} rawQuery - see `KickoffAvailabilityQuerySchema`
 * @param {{ existingBookings?: ReadonlyArray<import('../facility/types.js').FacilityBooking>, sizePolicy?: string, sizeRank?: Record<string, number>, sunsetBlocks?: boolean }} [options]
 * @returns {import('./types.js').KickoffAvailabilityResult}
 */
export function checkKickoffAvailability(graph, table, calendar, rawQuery, options = {}) {
  const query = KickoffAvailabilityQuerySchema.parse(rawQuery);
  const meta = createAvailabilityMeta();
  /** @type {import('./types.js').AvailabilityFinding[]} */
  const findings = [];
  const ignored = new Set(query.ignoreBookingIds);
  const existingBookings = (options.existingBookings ?? []).filter(
    (booking) => !ignored.has(booking.id)
  );

  /** @type {import('./types.js').KickoffAvailabilityResult} */
  const answer = {
    status: '',
    findings,
    meta,
    surfaceId: query.surfaceId,
    venueId: null,
    date: query.date,
    format: query.format,
    kickoffMinutes: query.kickoffMinutes,
    occupancyMinutes: null,
    endMinutes: null,
    // Tri-state (GAP-05), and `null` is the honest start. This template is what
    // an early return ships, and in this function that is the unknown-surface
    // return and only that one: a format with no timing row carries on and its
    // lighting *is* read. (The sibling `latestLegalKickoff()` does return early
    // on unknown timing, which is why its template carries `null` too rather
    // than a guess.) Such an answer has consulted no lighting at all. Shipping
    // `false` made
    // "nobody looked" read as "the ground is unlit", which `scanKickoffs()`
    // then counted toward the sunset rule's `unlitGamesExamined` minimum: a
    // schedule whose only unlit games stood on ground the graph does not hold
    // would satisfy the rule's exercise floor on games it never examined.
    lit: null,
    lighting: null,
    permit: null,
    sunsetMinutes: null,
    sunsetMarginMinutes: calendar.sunsetMarginMinutes,
    permitMarginMinutes: calendar.permitMarginMinutes,
    constraints: [],
    binding: null,
    bindingKinds: [],
  };

  const surface = getSurface(graph, query.surfaceId);
  if (!surface) {
    findings.push(
      /** @type {import('./types.js').AvailabilityFinding} */ (
        makeFinding(
          FACILITY_REASON.SURFACE_UNKNOWN,
          `availability was asked about surface "${query.surfaceId}", which is not in the graph`,
          { surfaceId: query.surfaceId, date: query.date }
        )
      )
    );
    return { ...answer, status: deriveAvailabilityStatus(findings) };
  }
  answer.venueId = surface.venueId;
  meta.surfacesConsidered += 1;

  // GAP-14: the corpus's `Scrimmage` rows have no timing row, so their end
  // minute is genuinely unknown and every check that needs one is skipped. The
  // checks that do *not* need one still run: a permit blackout closes a site
  // whatever is being played on it, and answering "we could not tell" for an
  // untimed booking on a blacked-out date would be a false all-clear.
  //
  // Everything blocking or compromising the format table said is carried
  // whether or not the occupancy is known, exactly as `timing/windows.js`
  // carries it: a format whose declared occupancy disagrees with its own
  // arithmetic must never reach an `accepted` verdict here — that is incident 7
  // wearing a different hat. Informational table provenance stays on the table,
  // where it belongs, rather than repeating on every kickoff.
  const timing = formatTimingOrUnknown(table, query.format);
  const timingFindings = /** @type {import('./types.js').AvailabilityFinding[]} */ (
    timing.findings.filter((finding) => finding.severity !== AVAILABILITY_SEVERITY.INFO)
  );
  findings.push(...timingFindings);
  const occupancyMinutes = timing.occupancyMinutes?.scheduled ?? null;
  const endMinutes = occupancyMinutes === null ? null : query.kickoffMinutes + occupancyMinutes;
  answer.occupancyMinutes = occupancyMinutes;
  answer.endMinutes = endMinutes;

  // Phase 1.1 answers "may this booking stand here at all?" - surface, size,
  // lining, equipment and concurrency. None of it is re-implemented here.
  const facilityResult = checkBooking(
    graph,
    {
      id: PROBE_BOOKING_ID,
      surfaceId: query.surfaceId,
      date: query.date,
      startMinutes: query.kickoffMinutes,
      endMinutes,
      format: query.format,
      label: null,
    },
    { existingBookings, sizePolicy: options.sizePolicy, sizeRank: options.sizeRank }
  );
  findings.push(
    .../** @type {import('./types.js').AvailabilityFinding[]} */ (facilityResult.findings)
  );
  absorbFacilityMetaInto(meta, facilityResult.meta);

  const resolvedPermit = resolvePermitWindow(calendar, {
    venueId: surface.venueId,
    date: query.date,
  });
  meta.permitWindowsConsulted += resolvedPermit.consulted;
  answer.permit = {
    window: resolvedPermit.window,
    scopeKind: resolvedPermit.scopeKind,
    ambiguous: resolvedPermit.ambiguous,
    candidates: resolvedPermit.candidates,
  };

  const lighting = resolveLighting(graph, calendar, query.surfaceId);
  meta.lightingRecordsConsulted += lighting.consulted;
  answer.lit = lighting.lit;
  answer.lighting = {
    lit: lighting.lit,
    lightsOffMinutes: lighting.lightsOffMinutes,
    source: lighting.source,
    recordId: lighting.recordId,
  };

  const sunsetRecord = sunsetOn(calendar, query.date);
  if (sunsetRecord) meta.sunsetRecordsConsulted += 1;
  answer.sunsetMinutes = sunsetRecord?.sunsetMinutes ?? null;

  const conflicting = conflictingBookingsOn(
    graph,
    query.surfaceId,
    query.date,
    existingBookings,
    query.ignoreBookingIds,
    meta
  );

  const ctx = {
    surfaceId: query.surfaceId,
    venueId: surface.venueId,
    date: query.date,
    kickoffMinutes: query.kickoffMinutes,
    endMinutes,
    occupancyMinutes,
  };

  const constraints = [
    occupancyConstraint(graph, conflicting, ctx, findings),
    lightingConstraint(lighting, resolvedPermit.window, ctx, findings),
    sunsetConstraint(calendar, lighting, ctx, findings),
    permitConstraint(calendar, resolvedPermit, ctx, findings),
  ];
  meta.constraintsEvaluated += constraints.length;

  const ordered = orderByTightness(constraints, options.sunsetBlocks);
  answer.constraints = ordered.constraints;
  answer.binding = ordered.binding;
  answer.bindingKinds = ordered.bindingKinds;

  return { ...answer, status: deriveAvailabilityStatus(findings) };
}

/**
 * The derived question: **how late can this format kick off here on this date?**
 *
 * The answer accounts for all four constraints and says which of them is
 * binding. The search is exact rather than a scan: the only kickoffs worth
 * testing are the hard ceiling (permit close, lights-off or the daylight limit,
 * whichever is tightest, less the format's occupancy) and, for each booking
 * already standing on conflicting ground, the kickoff that would finish exactly
 * as that booking starts. Every other minute is either dominated by one of those
 * or illegal for the same reason.
 *
 * `kickoffMinutes` is `null` when nothing is legal — never a fabricated answer.
 * The search runs from the permit open (or the caller's `notBeforeMinutes`) to
 * the end of the day (or `notAfterMinutes`). When *no* constraint applies — an
 * unrecorded permit on lit ground with nothing booked — the answer is the top of
 * that searched range and `bindingKinds` is empty, which is the honest reading
 * of "nothing we hold bounds this"; the accompanying `PERMIT_UNDECLARED` finding
 * is what tells the caller not to trust it.
 *
 * @param {import('../facility/types.js').FacilityGraph} graph
 * @param {import('../timing/types.js').FormatTimingTable} table
 * @param {import('./types.js').AvailabilityCalendar} calendar
 * @param {Object} rawQuery - see `LatestKickoffQuerySchema`
 * @param {{ existingBookings?: ReadonlyArray<import('../facility/types.js').FacilityBooking>, sizePolicy?: string, sizeRank?: Record<string, number>, sunsetBlocks?: boolean }} [options]
 * @returns {import('./types.js').LatestKickoffResult}
 */
export function latestLegalKickoff(graph, table, calendar, rawQuery, options = {}) {
  const query = LatestKickoffQuerySchema.parse(rawQuery);
  const meta = createAvailabilityMeta();
  /** @type {import('./types.js').AvailabilityFinding[]} */
  const findings = [];
  const ignored = new Set(query.ignoreBookingIds);
  const existingBookings = (options.existingBookings ?? []).filter(
    (booking) => !ignored.has(booking.id)
  );

  /** @type {import('./types.js').LatestKickoffResult} */
  const noAnswer = {
    status: '',
    findings,
    meta,
    surfaceId: query.surfaceId,
    venueId: null,
    date: query.date,
    format: query.format,
    kickoffMinutes: null,
    occupancyMinutes: null,
    endMinutes: null,
    /** Tri-state, and `null` until something states it; see the template in `checkKickoffAvailability()`. */
    lit: null,
    lighting: null,
    permit: null,
    sunsetMinutes: null,
    sunsetMarginMinutes: calendar.sunsetMarginMinutes,
    permitMarginMinutes: calendar.permitMarginMinutes,
    constraints: [],
    binding: null,
    bindingKinds: [],
    searchedFromMinutes: 0,
    searchedToMinutes: query.notAfterMinutes,
    candidatesTested: 0,
  };

  const surface = getSurface(graph, query.surfaceId);
  if (!surface) {
    findings.push(
      /** @type {import('./types.js').AvailabilityFinding} */ (
        makeFinding(
          FACILITY_REASON.SURFACE_UNKNOWN,
          `availability was asked about surface "${query.surfaceId}", which is not in the graph`,
          { surfaceId: query.surfaceId, date: query.date }
        )
      )
    );
    return { ...noAnswer, status: deriveAvailabilityStatus(findings) };
  }
  noAnswer.venueId = surface.venueId;
  meta.surfacesConsidered += 1;

  const timing = formatTimingOrUnknown(table, query.format);
  if (timing.occupancyMinutes === null) {
    const timingFindings = /** @type {import('./types.js').AvailabilityFinding[]} */ (
      timing.findings
    );
    findings.push(...timingFindings);
    return { ...noAnswer, status: deriveAvailabilityStatus(findings) };
  }
  const occupancyMinutes = timing.occupancyMinutes.scheduled;
  noAnswer.occupancyMinutes = occupancyMinutes;

  const resolvedPermit = resolvePermitWindow(calendar, {
    venueId: surface.venueId,
    date: query.date,
  });
  meta.permitWindowsConsulted += resolvedPermit.consulted;
  const lighting = resolveLighting(graph, calendar, query.surfaceId);
  meta.lightingRecordsConsulted += lighting.consulted;

  // A stated blackout short-circuits: there is no window to search inside, and
  // reporting "no legal kickoff" without naming the permit would lose the only
  // fact an operator can act on.
  if (resolvedPermit.window && !resolvedPermit.window.hasPermit) {
    const constraint = permitConstraint(
      calendar,
      resolvedPermit,
      {
        kickoffMinutes: null,
        endMinutes: null,
        occupancyMinutes,
        venueId: surface.venueId,
        date: query.date,
      },
      findings
    );
    const ordered = orderByTightness([constraint], options.sunsetBlocks);
    meta.constraintsEvaluated += 1;
    return {
      ...noAnswer,
      status: deriveAvailabilityStatus(findings),
      lit: lighting.lit,
      lighting: {
        lit: lighting.lit,
        lightsOffMinutes: lighting.lightsOffMinutes,
        source: lighting.source,
        recordId: lighting.recordId,
      },
      permit: {
        window: resolvedPermit.window,
        scopeKind: resolvedPermit.scopeKind,
        ambiguous: resolvedPermit.ambiguous,
        candidates: resolvedPermit.candidates,
      },
      sunsetMinutes: sunsetOn(calendar, query.date)?.sunsetMinutes ?? null,
      constraints: ordered.constraints,
      binding: ordered.binding,
      bindingKinds: ordered.bindingKinds,
    };
  }

  /** @type {number[]} */
  const hardLimits = [];
  if (resolvedPermit.window !== null && resolvedPermit.window.closeMinutes !== null) {
    hardLimits.push(resolvedPermit.window.closeMinutes);
  }
  // `=== true` / `!== true`, the contract its sibling `lightingConstraint()`
  // moved to: undeclared ground takes the daylight limit as unlit ground does,
  // and reading it by truthiness would be folding "unknown" into "false" one
  // more time.
  if (lighting.lit === true && lighting.lightsOffMinutes !== null) {
    hardLimits.push(lighting.lightsOffMinutes);
  }
  if (lighting.lit !== true) {
    const daylight = daylightLimitMinutes(calendar, query.date);
    // The daylight limit bounds this search only while running past it blocks ({@link sunsetBlocks}):
    // otherwise the answer would name a "latest legal kickoff" bound by nothing. Permit close and
    // lights-off are blocking and stay in.
    if (daylight !== null && sunsetBlocks(options.sunsetBlocks)) hardLimits.push(daylight);
  }

  const floorMinutes = query.notBeforeMinutes ?? resolvedPermit.window?.openMinutes ?? 0;
  const ceilingFromLimits =
    hardLimits.length === 0
      ? query.notAfterMinutes
      : Math.min(...hardLimits.map((limit) => limit - occupancyMinutes));
  const ceilingMinutes = Math.min(ceilingFromLimits, query.notAfterMinutes);
  noAnswer.searchedFromMinutes = floorMinutes;
  noAnswer.searchedToMinutes = ceilingMinutes;

  const conflicting = conflictingBookingsOn(
    graph,
    query.surfaceId,
    query.date,
    existingBookings,
    query.ignoreBookingIds,
    meta
  );

  const candidates = [
    ceilingMinutes,
    ...conflicting.map((booking) => booking.startMinutes - occupancyMinutes),
  ]
    .filter((minute) => minute >= floorMinutes && minute <= ceilingMinutes)
    .sort((a, b) => b - a);

  const seen = new Set();
  for (const kickoffMinutes of candidates) {
    if (seen.has(kickoffMinutes)) continue;
    seen.add(kickoffMinutes);
    meta.candidateKickoffsTested += 1;

    const attempt = checkKickoffAvailability(
      graph,
      table,
      calendar,
      {
        surfaceId: query.surfaceId,
        date: query.date,
        kickoffMinutes,
        format: query.format,
        ignoreBookingIds: query.ignoreBookingIds,
      },
      options
    );
    const blocked = attempt.findings.some(
      (finding) => finding.severity === AVAILABILITY_SEVERITY.BLOCKING
    );
    if (blocked) continue;

    findings.push(...attempt.findings);
    // `checkKickoffAvailability()` never tests a candidate of its own, so this
    // cannot double-count the counter the loop above maintains.
    mergeAvailabilityMeta(meta, attempt.meta);

    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.LATEST_KICKOFF_BOUND,
        `the latest legal kickoff is minute ${kickoffMinutes} (ending ${attempt.endMinutes}), bound by ${
          attempt.bindingKinds.join(' and ') || 'nothing'
        }`,
        {
          surfaceId: query.surfaceId,
          date: query.date,
          format: query.format,
          kickoffMinutes,
          endMinutes: attempt.endMinutes,
          bindingKinds: attempt.bindingKinds,
          constraintOrder: attempt.constraints.map((constraint) => constraint.kind),
        }
      )
    );

    return {
      ...attempt,
      status: deriveAvailabilityStatus(findings),
      findings,
      meta,
      searchedFromMinutes: floorMinutes,
      searchedToMinutes: ceilingMinutes,
      candidatesTested: meta.candidateKickoffsTested,
    };
  }

  findings.push(
    makeAvailabilityFinding(
      AVAILABILITY_REASON.NO_LEGAL_KICKOFF,
      `no legal kickoff for ${query.format ?? '(no format)'} exists on ${query.date} between minutes ${floorMinutes} and ${ceilingMinutes}`,
      {
        surfaceId: query.surfaceId,
        date: query.date,
        format: query.format,
        occupancyMinutes,
        searchedFromMinutes: floorMinutes,
        searchedToMinutes: ceilingMinutes,
        candidatesTested: meta.candidateKickoffsTested,
      }
    )
  );

  return {
    ...noAnswer,
    status: deriveAvailabilityStatus(findings),
    lit: lighting.lit,
    lighting: {
      lit: lighting.lit,
      lightsOffMinutes: lighting.lightsOffMinutes,
      source: lighting.source,
      recordId: lighting.recordId,
    },
    permit: {
      window: resolvedPermit.window,
      scopeKind: resolvedPermit.scopeKind,
      ambiguous: resolvedPermit.ambiguous,
      candidates: resolvedPermit.candidates,
    },
    sunsetMinutes: sunsetOn(calendar, query.date)?.sunsetMinutes ?? null,
    candidatesTested: meta.candidateKickoffsTested,
  };
}
