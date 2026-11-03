/**
 * Tests for the facility availability model (`packages/core/src/availability/`).
 *
 * The corpus is loaded once at module scope and **every expected minute is
 * derived from the fixture files at test time** — sunsets from `sunsets.csv`,
 * permit windows from `facility_permits.csv`, occupancy from `game_formats.csv`
 * via the Phase 1.2 timing table, geometry from `facility_geometry.json`. The
 * clock times the acceptance criteria name (4:24 PM, 9:00 PM, 7:20 PM) are
 * computed and then cross-checked against the criterion, never typed in as the
 * expectation: a hard-coded copy of a derived number is a copy that drifts.
 *
 * Meta-assertion discipline (incident 4 in `fixtures/season-2026/README.md`):
 * every behavioural check also asserts it examined a non-zero number of
 * records. `meta.permitWindowsConsulted > 0` matters most here — the whole
 * point of this module is that the exceptions are what bite, and a calendar
 * that had quietly lost its date-scoped rows would make "the exception beats
 * the default" pass for the wrong reason.
 *
 * The gaps under test:
 *   GAP-05 venue/field lighting · GAP-06 sunset per date · GAP-07 permit
 *   windows · GAP-08 per-date exceptions and blackouts · GAP-30 wall-clock time
 *   with no `Date` construction.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  formatClockMinutes,
  indexFormats,
  loadCombinedSchedule,
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSunsets,
  weekdayCode,
} from '@squadlogic/core/fixtures/index.js';

import {
  FACILITY_REASON,
  buildFacilityGraphFromSeason2026,
  season2026SurfaceId,
  season2026VenueId,
} from '@squadlogic/core/facility/index.js';

import {
  TIMING_REASON,
  buildFormatTimingTable,
  buildFormatTimingTableFromSeason2026,
  requireFormatTiming,
  toFormatTimingInput,
} from '@squadlogic/core/timing/index.js';

import {
  AVAILABILITY_CONSTRAINT,
  AVAILABILITY_CONSTRAINT_ORDER,
  AVAILABILITY_REASON,
  AVAILABILITY_REASON_SEVERITY,
  AVAILABILITY_SEVERITY,
  AVAILABILITY_STATUS,
  AvailabilityCalendarInputSchema,
  PermitWindowSchema,
  SEASON_2026_PERMIT_MARGIN_MINUTES,
  SEASON_2026_SUNSET_MARGIN_MINUTES,
  availabilitySeverityOf,
  buildAvailabilityCalendar,
  buildAvailabilityCalendarFromSeason2026,
  checkKickoffAvailability,
  daylightLimitMinutes,
  deriveAvailabilityStatus,
  latestLegalKickoff,
  makeAvailabilityFinding,
  resolveLighting,
  resolvePermitWindow,
  sunsetOn,
  toAvailabilityCalendarInput,
  venueIdOfSurface,
  weekdayCodeOf,
} from '@squadlogic/core/availability/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus, loaded once                                                         */
/* -------------------------------------------------------------------------- */

const geometry = loadFacilityGeometry();
const graph = buildFacilityGraphFromSeason2026(geometry);
const rawFormats = loadGameFormats();
const formatsByName = indexFormats(rawFormats);
const table = buildFormatTimingTableFromSeason2026(rawFormats);
const combinedGames = loadCombinedSchedule({ formatsByName });

const sunsets = loadSunsets();
/** Derived from the corpus rather than typed in, so a re-dated fixture moves it. */
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const permits = loadFacilityPermits({ seasonYear: SEASON_YEAR });
const calendar = buildAvailabilityCalendarFromSeason2026(permits, sunsets);

/** Shorthand for the opaque surface id of a corpus venue/field pair. */
const sid = (venueName, fieldName) => season2026SurfaceId(venueName, fieldName);

const LIT_VENUE = 'Summit HS';
const LIT_FIELD = 'Stadium';
const UNLIT_VENUE = 'Alder Park';
const UNLIT_FIELD = 'Pitch 2';
const ELEVEN = '11v11';

const LIT = sid(LIT_VENUE, LIT_FIELD);
const UNLIT = sid(UNLIT_VENUE, UNLIT_FIELD);

/**
 * The two dates the acceptance criteria name, taken from the fixture rather
 * than asserted into existence: `find` fails loudly if the corpus stops
 * containing them.
 */
const ACCEPTANCE_DATE = sunsets.find((entry) => entry.date.endsWith('-10-24')).date;
const BLACKOUT_DATE = sunsets.find((entry) => entry.date.endsWith('-09-19')).date;
const EARLY_OPEN_DATE = sunsets.find((entry) => entry.date.endsWith('-09-12')).date;

/** The 11v11 scheduled occupancy — 90 minutes, because `game_formats.csv` says so. */
const OCCUPANCY = requireFormatTiming(table, ELEVEN).occupancyMinutes.scheduled;

/** Sunset on the acceptance date, in minutes past midnight. */
const ACCEPTANCE_SUNSET = sunsetOn(calendar, ACCEPTANCE_DATE).sunsetMinutes;

/**
 * **Sunset warns; the permit bounds.** Owner, 2026-11-02: "Yes to legal-with-a-warning for
 * kickoffs after sunset, because some orgs have portable lighting or other workarounds." A
 * kickoff that ends inside the sunset margin is legal and carries `SUNSET_MARGIN_VIOLATED` as a
 * compromise. So on the unlit pitch the latest LEGAL kickoff is the permit close less the
 * occupancy, and the latest kickoff WITHOUT a warning is sunset less the margin less the
 * occupancy (the original criterion's 4:24 PM). Both are derived from the fixture rows.
 */
const UNLIT_PERMIT_CLOSE = resolvePermitWindow(calendar, {
  venueId: season2026VenueId(UNLIT_VENUE),
  date: ACCEPTANCE_DATE,
}).window.closeMinutes;
const UNLIT_LEGAL_LATEST = UNLIT_PERMIT_CLOSE - OCCUPANCY;
const UNLIT_CLEAN_LATEST = ACCEPTANCE_SUNSET - calendar.sunsetMarginMinutes - OCCUPANCY;

const codesOf = (result) => result.findings.map((finding) => finding.code);
const blockingOf = (result) =>
  result.findings.filter((finding) => finding.severity === AVAILABILITY_SEVERITY.BLOCKING);
const constraintOf = (result, kind) =>
  result.constraints.find((constraint) => constraint.kind === kind);

/** Rebuild the calendar with one thing changed, so the corpus is never edited. */
const calendarWith = (overrides) =>
  buildAvailabilityCalendarFromSeason2026(permits, sunsets, overrides);

/* -------------------------------------------------------------------------- */
/* Guard block - runs before anything behavioural                              */
/* -------------------------------------------------------------------------- */

describe('facility availability :: corpus guard', () => {
  it('is built from the real permit and sunset files, not an empty shell', () => {
    // Without these, "the exception beats the default" would pass on a calendar
    // that contained no exceptions at all.
    expect(calendar.stats.permitWindowCount).toBe(permits.length);
    expect(calendar.stats.permitWindowCount).toBeGreaterThan(0);
    expect(calendar.stats.weekdayDefaultCount).toBeGreaterThan(0);
    expect(calendar.stats.dateExceptionCount).toBeGreaterThan(0);
    // GAP-08's third state: exactly one stated blackout in this corpus.
    expect(calendar.stats.blackoutCount).toBe(1);
    expect(calendar.stats.sunsetCount).toBe(sunsets.length);
    expect(calendar.stats.venueCount).toBeGreaterThan(1);
    expect(calendar.meta.permitWindowsConsulted).toBe(permits.length);
    expect(calendar.meta.sunsetRecordsConsulted).toBe(sunsets.length);
    expect(calendar.status).toBe(AVAILABILITY_STATUS.ALLOWED);
    expect(calendar.findings).toEqual([]);
  });

  it('defaults both margins to the club policy, in one place', () => {
    expect(calendar.sunsetMarginMinutes).toBe(SEASON_2026_SUNSET_MARGIN_MINUTES);
    expect(calendar.permitMarginMinutes).toBe(SEASON_2026_PERMIT_MARGIN_MINUTES);
    // The README's stated policy: "Unlit games must end 15 min before sunset."
    expect(SEASON_2026_SUNSET_MARGIN_MINUTES).toBe(15);
  });

  it('pins the acceptance scenario to real fixture rows', () => {
    expect(formatClockMinutes(ACCEPTANCE_SUNSET)).toBe('18:09'); // the criterion's 6:09 PM
    expect(OCCUPANCY).toBe(90); // the criterion's "90-minute game", from game_formats.csv
    expect(graph.venues[season2026VenueId(LIT_VENUE)].lit).toBe(true);
    expect(graph.venues[season2026VenueId(UNLIT_VENUE)].lit).toBe(false);
    expect(graph.surfaces[LIT].sizes).toContain(ELEVEN);
    expect(graph.surfaces[UNLIT].sizes).toContain(ELEVEN);
    expect(weekdayCodeOf(ACCEPTANCE_DATE)).toBe('SAT');
  });

  it('agrees with the corpus loader about every weekday, without building a Date', () => {
    // GAP-30: `weekdayCodeOf()` is pure civil-date arithmetic. This proves it
    // matches the loader's `Date.UTC` implementation across the whole season.
    const dates = [...new Set(combinedGames.map((game) => game.date))];
    expect(dates.length).toBeGreaterThan(10);
    for (const date of dates) {
      expect(weekdayCodeOf(date), date).toBe(weekdayCode(date));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance test 1 - sunset binds an unlit field                             */
/* -------------------------------------------------------------------------- */

describe('facility availability :: acceptance 1 - an unlit kickoff past sunset is legal, with a warning', () => {
  it('answers the permit close less the occupancy as the latest LEGAL kickoff, carrying the sunset warning', () => {
    const result = latestLegalKickoff(graph, table, calendar, {
      surfaceId: UNLIT,
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });

    expect(result.kickoffMinutes).toBe(UNLIT_LEGAL_LATEST);
    expect(result.kickoffMinutes).toBeGreaterThan(UNLIT_CLEAN_LATEST);
    expect(result.endMinutes).toBe(UNLIT_PERMIT_CLOSE);
    expect(result.occupancyMinutes).toBe(OCCUPANCY);
    expect(blockingOf(result)).toEqual([]);
    expect(result.status).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);

    // The deliverable: which of the four is binding. Sunset is not: it is evaluated and
    // reported, broken by the derived amount, and bounds nothing that is legal.
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
    expect(result.binding.kind).toBe(AVAILABILITY_CONSTRAINT.PERMIT);
    expect(result.binding.slackMinutes).toBe(0);
    const sunset = constraintOf(result, AVAILABILITY_CONSTRAINT.SUNSET);
    expect(sunset.applicable).toBe(true);
    expect(sunset.binding).toBe(false);
    expect(sunset.slackMinutes).toBe(
      ACCEPTANCE_SUNSET - calendar.sunsetMarginMinutes - UNLIT_PERMIT_CLOSE
    );
    expect(sunset.slackMinutes).toBeLessThan(0);

    // Meta-assertions: real records consulted, real constraints evaluated.
    expect(result.meta.permitWindowsConsulted).toBeGreaterThan(0);
    expect(result.meta.sunsetRecordsConsulted).toBeGreaterThan(0);
    expect(result.meta.constraintsEvaluated).toBe(AVAILABILITY_CONSTRAINT_ORDER.length);
    expect(result.candidatesTested).toBeGreaterThan(0);
  });

  it('reports every constraint ordered by tightness, not just the winner', () => {
    // Prompt 4.3 needs the ordering, so it is asserted as a contract here. The order is the
    // order of the limits, whether or not a limit blocks.
    const result = latestLegalKickoff(graph, table, calendar, {
      surfaceId: UNLIT,
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });

    expect(result.constraints).toHaveLength(AVAILABILITY_CONSTRAINT_ORDER.length);
    expect(result.constraints.map((constraint) => constraint.kind).slice(0, 2)).toEqual([
      AVAILABILITY_CONSTRAINT.SUNSET,
      AVAILABILITY_CONSTRAINT.PERMIT,
    ]);

    const applicable = result.constraints.filter((constraint) => constraint.applicable);
    expect(applicable.length).toBe(2);
    for (let index = 1; index < applicable.length; index += 1) {
      expect(applicable[index].latestKickoffMinutes).toBeGreaterThanOrEqual(
        applicable[index - 1].latestKickoffMinutes
      );
      expect(applicable[index].slackMinutes).toBeGreaterThanOrEqual(
        applicable[index - 1].slackMinutes
      );
    }

    // The permit is the looser limit, and the one that binds: the answer ends exactly at it.
    const permit = constraintOf(result, AVAILABILITY_CONSTRAINT.PERMIT);
    const permitWindow = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(UNLIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window;
    expect(permit.limitMinutes).toBe(permitWindow.closeMinutes);
    expect(permit.slackMinutes).toBe(permitWindow.closeMinutes - result.endMinutes);
    expect(permit.slackMinutes).toBe(0);
    expect(permit.binding).toBe(true);
    // The sunset limit is the tighter one, and does not bind.
    const sunset = constraintOf(result, AVAILABILITY_CONSTRAINT.SUNSET);
    expect(sunset.latestKickoffMinutes).toBeLessThan(permit.latestKickoffMinutes);
    expect(sunset.binding).toBe(false);
  });

  it('answers 4:24 PM as the last kickoff without a warning, and warns about the same game one minute later', () => {
    expect(formatClockMinutes(UNLIT_CLEAN_LATEST)).toBe('16:24'); // the criterion's own words

    const atEdge = (kickoffMinutes) =>
      checkKickoffAvailability(graph, table, calendar, {
        surfaceId: UNLIT,
        date: ACCEPTANCE_DATE,
        kickoffMinutes,
        format: ELEVEN,
      });
    const clean = atEdge(UNLIT_CLEAN_LATEST);
    expect(clean.status).toBe(AVAILABILITY_STATUS.ALLOWED);
    expect(codesOf(clean)).not.toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
    expect(clean.endMinutes).toBe(ACCEPTANCE_SUNSET - calendar.sunsetMarginMinutes);
    expect(constraintOf(clean, AVAILABILITY_CONSTRAINT.SUNSET).slackMinutes).toBe(0);

    // The negative control, one minute later. Without it, "no warning" proves nothing: the same
    // game is now allowed to stand, compromised, naming the sunset margin.
    const result = atEdge(UNLIT_CLEAN_LATEST + 1);
    expect(result.status).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(blockingOf(result)).toEqual([]);
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
    const finding = result.findings.find(
      (entry) => entry.code === AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED
    );
    expect(finding.severity).toBe(AVAILABILITY_SEVERITY.COMPROMISE);
    expect(finding.details.sunsetMinutes).toBe(ACCEPTANCE_SUNSET);
    expect(finding.details.sunsetMarginMinutes).toBe(calendar.sunsetMarginMinutes);
    expect(finding.details.limitMinutes).toBe(ACCEPTANCE_SUNSET - calendar.sunsetMarginMinutes);
  });

  it('moves with the margin, which is configurable and never hard-coded', () => {
    for (const margin of [0, 30]) {
      const tuned = calendarWith({ sunsetMarginMinutes: margin });
      expect(tuned.sunsetMarginMinutes).toBe(margin);
      // The margin moves where the warning starts...
      const cleanLatest = ACCEPTANCE_SUNSET - margin - OCCUPANCY;
      const at = (kickoffMinutes) =>
        checkKickoffAvailability(graph, table, tuned, {
          surfaceId: UNLIT,
          date: ACCEPTANCE_DATE,
          kickoffMinutes,
          format: ELEVEN,
        });
      expect(codesOf(at(cleanLatest))).not.toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
      expect(codesOf(at(cleanLatest + 1))).toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
      // ...and not the latest legal kickoff, which only the permit bounds.
      const result = latestLegalKickoff(graph, table, tuned, {
        surfaceId: UNLIT,
        date: ACCEPTANCE_DATE,
        format: ELEVEN,
      });
      expect(result.kickoffMinutes).toBe(UNLIT_LEGAL_LATEST);
      expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
    }
  });

  it('moves with the date, because sunset is per date', () => {
    // GAP-06 in one assertion: the date the warning starts on moves with the file; the latest
    // legal kickoff is the permit's, date by date.
    const seen = new Set();
    for (const record of sunsets) {
      const permitWindow = resolvePermitWindow(calendar, {
        venueId: season2026VenueId(UNLIT_VENUE),
        date: record.date,
      }).window;
      if (!permitWindow) continue;
      const result = latestLegalKickoff(graph, table, calendar, {
        surfaceId: UNLIT,
        date: record.date,
        format: ELEVEN,
      });
      expect(result.kickoffMinutes, record.date).toBe(permitWindow.closeMinutes - OCCUPANCY);

      const daylight = record.sunsetMinutes - calendar.sunsetMarginMinutes;
      const cleanLatest = Math.min(daylight, permitWindow.closeMinutes) - OCCUPANCY;
      const warnsAt = (kickoffMinutes) =>
        codesOf(
          checkKickoffAvailability(graph, table, calendar, {
            surfaceId: UNLIT,
            date: record.date,
            kickoffMinutes,
            format: ELEVEN,
          })
        ).includes(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
      expect(warnsAt(cleanLatest), record.date).toBe(false);
      expect(warnsAt(cleanLatest + 1), record.date).toBe(daylight < permitWindow.closeMinutes);
      seen.add(cleanLatest);
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance test 2 - the permit close binds the lit stadium                   */
/* -------------------------------------------------------------------------- */

describe('facility availability :: acceptance 2 - the lit stadium is bound by the permit close', () => {
  it('is bounded by the 9:00 PM permit close, not by sunset', () => {
    const permit = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(LIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window;
    expect(formatClockMinutes(permit.closeMinutes)).toBe('21:00'); // the criterion's 9:00 PM

    const result = latestLegalKickoff(graph, table, calendar, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });

    expect(result.kickoffMinutes).toBe(permit.closeMinutes - OCCUPANCY);
    expect(result.endMinutes).toBe(permit.closeMinutes);
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
    expect(result.binding.slackMinutes).toBe(0);
    expect(result.binding.source).toBe(permit.id);

    // Sunset is *evaluated and reported*, and found not to apply - which is the
    // difference between "lighting was considered" and "lighting was ignored".
    const sunsetConstraint = constraintOf(result, AVAILABILITY_CONSTRAINT.SUNSET);
    expect(sunsetConstraint.applicable).toBe(false);
    expect(sunsetConstraint.detail.reason).toBe('the field is lit');
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.SUNSET_NOT_BINDING_WHEN_LIT);

    // And the answer is far later than the unlit answer on the same date, which
    // is the whole reason the club floodlit a pitch.
    const unlitAnswer = ACCEPTANCE_SUNSET - calendar.sunsetMarginMinutes - OCCUPANCY;
    expect(result.kickoffMinutes).toBeGreaterThan(unlitAnswer);
    expect(result.lit).toBe(true);
    expect(result.meta.permitWindowsConsulted).toBeGreaterThan(0);
  });

  it('is legal but has zero permit margin, and says so rather than hiding it', () => {
    // The latest legal kickoff finishes exactly at the close. That is legal and
    // it is also the tightest a booking can be, so the same rule that flags the
    // 7:20 PM game flags this one. Consistency beats a special case.
    const result = latestLegalKickoff(graph, table, calendar, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });
    expect(blockingOf(result)).toEqual([]);
    expect(result.status).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT);
  });

  it('carries the sunset warning the moment the same field is recorded unlit', () => {
    // The lighting control: nothing about the date, the format or the permit
    // changes, only the light. GAP-05 per *field*, overriding the venue.
    const tuned = calendarWith({
      lighting: [{ surfaceId: LIT, lit: false, note: 'floodlights out of service' }],
    });

    // Derived: the earliest corpus date on which an unlit game would still fit
    // between this venue's late permit open and the daylight limit. On the
    // acceptance date it would not fit at all - the stadium opens at 5:00 PM and
    // the light goes at 5:54 - which is itself the point of floodlighting it.
    const feasible = sunsets.find((record) => {
      const permit = resolvePermitWindow(tuned, {
        venueId: season2026VenueId(LIT_VENUE),
        date: record.date,
      }).window;
      if (!permit || !permit.hasPermit) return false;
      return record.sunsetMinutes - tuned.sunsetMarginMinutes - OCCUPANCY >= permit.openMinutes;
    });
    expect(feasible).toBeDefined();
    const permit = resolvePermitWindow(tuned, {
      venueId: season2026VenueId(LIT_VENUE),
      date: feasible.date,
    }).window;

    const result = latestLegalKickoff(graph, table, tuned, {
      surfaceId: LIT,
      date: feasible.date,
      format: ELEVEN,
    });

    expect(result.lit).toBe(false);
    expect(result.lighting.source).toBe('surface');
    // The permit close bounds it, as it bounds the lit stadium; sunset does not.
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
    expect(result.kickoffMinutes).toBe(permit.closeMinutes - OCCUPANCY);
    // What the lights change is the warning: unlit, that kickoff ends past the daylight limit.
    expect(permit.closeMinutes).toBeGreaterThan(feasible.sunsetMinutes - tuned.sunsetMarginMinutes);
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
    // The permit paperwork still claims the venue is lit; the disagreement is
    // reported rather than reconciled silently.
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.LIGHTING_SOURCE_DISAGREES);

    // Lit, the same date and the same permit reach the same minute with no sunset warning at all.
    const withLights = latestLegalKickoff(graph, table, calendar, {
      surfaceId: LIT,
      date: feasible.date,
      format: ELEVEN,
    });
    expect(withLights.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
    expect(withLights.kickoffMinutes).toBe(result.kickoffMinutes);
    expect(codesOf(withLights)).not.toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
  });

  it('can fit an unlit game there on the acceptance date, with a warning', () => {
    // The stadium opens at 5:00 PM and the daylight limit that day is 5:54 PM, so without
    // floodlights no game can finish inside daylight. It used to mean no legal kickoff; since the
    // owner's decision of 2026-11-02 it means a legal one that carries the sunset warning.
    const tuned = calendarWith({
      lighting: [{ surfaceId: LIT, lit: false, note: 'floodlights out of service' }],
    });
    const permit = resolvePermitWindow(tuned, {
      venueId: season2026VenueId(LIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window;
    // Why this case exists: nothing fits inside daylight.
    expect(ACCEPTANCE_SUNSET - tuned.sunsetMarginMinutes - OCCUPANCY).toBeLessThan(
      permit.openMinutes
    );

    const result = latestLegalKickoff(graph, table, tuned, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });
    expect(result.kickoffMinutes).toBe(permit.closeMinutes - OCCUPANCY);
    expect(result.kickoffMinutes).toBeGreaterThanOrEqual(permit.openMinutes);
    expect(codesOf(result)).not.toContain(AVAILABILITY_REASON.NO_LEGAL_KICKOFF);
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
    expect(blockingOf(result)).toEqual([]);
    expect(result.status).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(result.searchedFromMinutes).toBeLessThanOrEqual(result.searchedToMinutes);
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance test 3 - the blackout date                                       */
/* -------------------------------------------------------------------------- */

describe('facility availability :: acceptance 3 - no permit at all on the blackout date', () => {
  it('rejects any booking on the lit stadium that day, with "no permit"', () => {
    const window = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(LIT_VENUE),
      date: BLACKOUT_DATE,
    });
    expect(window.window.hasPermit).toBe(false);
    expect(window.scopeKind).toBe('date-exception');

    // Every hour of the day, not one convenient one.
    for (let kickoffMinutes = 0; kickoffMinutes < 24 * 60; kickoffMinutes += 60) {
      const result = checkKickoffAvailability(graph, table, calendar, {
        surfaceId: LIT,
        date: BLACKOUT_DATE,
        kickoffMinutes,
        format: ELEVEN,
      });
      expect(result.status, String(kickoffMinutes)).toBe(AVAILABILITY_STATUS.REJECTED);
      expect(codesOf(result)).toContain(AVAILABILITY_REASON.PERMIT_BLACKOUT);
      expect(
        result.findings.find((entry) => entry.code === AVAILABILITY_REASON.PERMIT_BLACKOUT).message
      ).toContain('no permit');
    }
  });

  it('answers "no legal kickoff" for the derived query on that date', () => {
    const result = latestLegalKickoff(graph, table, calendar, {
      surfaceId: LIT,
      date: BLACKOUT_DATE,
      format: ELEVEN,
    });
    expect(result.kickoffMinutes).toBeNull();
    expect(result.status).toBe(AVAILABILITY_STATUS.REJECTED);
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.PERMIT_BLACKOUT);
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
    expect(result.binding.limitMinutes).toBeNull();
    expect(result.binding.detail.blackout).toBe(true);
  });

  it('leaves the very same venue bookable on its other Saturdays', () => {
    // The date control. A blackout that blacked out every date would pass the
    // test above and be catastrophically wrong.
    const result = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: resolvePermitWindow(calendar, {
        venueId: season2026VenueId(LIT_VENUE),
        date: ACCEPTANCE_DATE,
      }).window.openMinutes,
      format: ELEVEN,
    });
    expect(blockingOf(result)).toEqual([]);
    expect(codesOf(result)).not.toContain(AVAILABILITY_REASON.PERMIT_BLACKOUT);
  });

  it('and the corpus schedules nothing there that day', () => {
    // The fixture's own witness for the rule: GAP-08 says the corpus schedules
    // zero games at this venue on this date.
    const scheduled = combinedGames.filter(
      (game) => game.venue === LIT_VENUE && game.date === BLACKOUT_DATE
    );
    expect(scheduled).toHaveLength(0);
    expect(combinedGames.filter((game) => game.venue === LIT_VENUE).length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance test 4 - legal, but tight against the permit                     */
/* -------------------------------------------------------------------------- */

describe('facility availability :: acceptance 4 - a legal kickoff with under 15 minutes of margin', () => {
  const kickoffMinutes = 19 * 60 + 20; // 7:20 PM, the criterion's own number

  it('allows the 7:20 PM kickoff and flags the tight permit margin', () => {
    const permit = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(LIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window;

    const result = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes,
      format: ELEVEN,
    });

    // It ends at 8:50 PM - derived from the format table, not typed in.
    expect(result.endMinutes).toBe(kickoffMinutes + OCCUPANCY);
    expect(formatClockMinutes(result.endMinutes)).toBe('20:50');

    // Legal...
    expect(blockingOf(result)).toEqual([]);
    // ...but compromised, which is the same third state Phase 1.1 gave lining.
    expect(result.status).toBe(AVAILABILITY_STATUS.COMPROMISED);

    const finding = result.findings.find(
      (entry) => entry.code === AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe(AVAILABILITY_SEVERITY.COMPROMISE);
    expect(finding.details.marginMinutes).toBe(permit.closeMinutes - result.endMinutes);
    expect(finding.details.marginMinutes).toBeLessThan(calendar.permitMarginMinutes);
    expect(finding.details.requiredMarginMinutes).toBe(calendar.permitMarginMinutes);

    // The binding constraint is still reported for a kickoff nobody derived.
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
    expect(constraintOf(result, AVAILABILITY_CONSTRAINT.PERMIT).slackMinutes).toBe(
      permit.closeMinutes - result.endMinutes
    );
  });

  it('is not flagged when the margin policy is relaxed, and is when it is raised', () => {
    // Proves the flag comes from the configured margin rather than from a 15
    // baked into the check.
    const relaxed = calendarWith({ permitMarginMinutes: 5 });
    const relaxedResult = checkKickoffAvailability(graph, table, relaxed, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes,
      format: ELEVEN,
    });
    expect(relaxedResult.status).toBe(AVAILABILITY_STATUS.ALLOWED);
    expect(codesOf(relaxedResult)).not.toContain(AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT);

    const strict = calendarWith({ permitMarginMinutes: 45 });
    const strictResult = checkKickoffAvailability(graph, table, strict, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes,
      format: ELEVEN,
    });
    expect(strictResult.status).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(codesOf(strictResult)).toContain(AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT);
  });

  it('rejects, rather than flags, a kickoff that actually runs past the close', () => {
    const permit = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(LIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window;
    const result = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: permit.closeMinutes - OCCUPANCY + 1,
      format: ELEVEN,
    });
    expect(result.status).toBe(AVAILABILITY_STATUS.REJECTED);
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED);
    expect(
      result.findings.find((entry) => entry.code === AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED)
        .details.overrunMinutes
    ).toBe(1);
  });

  it('rejects a kickoff before the permit opens', () => {
    const permit = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(LIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window;
    const result = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: permit.openMinutes - 1,
      format: ELEVEN,
    });
    expect(result.status).toBe(AVAILABILITY_STATUS.REJECTED);
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.PERMIT_OPEN_PRECEDED);
  });
});

/* -------------------------------------------------------------------------- */
/* Per-venue-per-date exceptions (GAP-08)                                      */
/* -------------------------------------------------------------------------- */

describe('facility availability :: a date-scoped exception beats the weekday default', () => {
  it('opens the stadium at 2:00 PM on the early-open date and at 5:00 PM otherwise', () => {
    const early = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(LIT_VENUE),
      date: EARLY_OPEN_DATE,
    });
    const usual = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(LIT_VENUE),
      date: ACCEPTANCE_DATE,
    });

    expect(early.window.openMinutes).toBeLessThan(usual.window.openMinutes);
    expect(formatClockMinutes(early.window.openMinutes)).toBe('14:00');
    expect(formatClockMinutes(usual.window.openMinutes)).toBe('17:00');
    expect(early.window.note).toContain('early open');

    // Behavioural, not just structural: the same kickoff is legal on one date
    // and illegal on the other, and nothing but the date changed.
    const kickoffMinutes = early.window.openMinutes;
    const onEarly = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: LIT,
      date: EARLY_OPEN_DATE,
      kickoffMinutes,
      format: ELEVEN,
    });
    const onUsual = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes,
      format: ELEVEN,
    });
    expect(blockingOf(onEarly)).toEqual([]);
    expect(codesOf(onUsual)).toContain(AVAILABILITY_REASON.PERMIT_OPEN_PRECEDED);
  });

  it('uses the weekday default where no exception applies, and says which it used', () => {
    const result = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: UNLIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: 10 * 60,
      format: ELEVEN,
    });
    expect(result.permit.scopeKind).toBe('weekday-default');
    expect(result.permit.window.weekday).toBe(weekdayCodeOf(ACCEPTANCE_DATE));
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.PERMIT_WEEKDAY_DEFAULT);
    expect(codesOf(result)).not.toContain(AVAILABILITY_REASON.PERMIT_DATE_EXCEPTION);
  });

  it('honours a one-off Sunday exception, and knows nothing about other Sundays', () => {
    // The corpus's `SUN 08/23 only` row. The distinction this proves is GAP-08's
    // real payload: a stated blackout blocks, an absent record only compromises.
    const sundayException = permits.find((permit) => permit.weekday === 'SUN');
    expect(sundayException).toBeDefined();
    const venueId = season2026VenueId(sundayException.venue);

    const covered = resolvePermitWindow(calendar, { venueId, date: sundayException.date });
    expect(covered.scopeKind).toBe('date-exception');
    expect(covered.window.hasPermit).toBe(true);

    // Another Sunday, seven days later, with no record at all.
    const otherSunday = `${sundayException.date.slice(0, 8)}${String(
      Number(sundayException.date.slice(8, 10)) + 7
    ).padStart(2, '0')}`;
    expect(weekdayCodeOf(otherSunday)).toBe('SUN');

    const uncovered = resolvePermitWindow(calendar, { venueId, date: otherSunday });
    expect(uncovered.window).toBeNull();
    expect(uncovered.scopeKind).toBe('none');

    const result = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: sid(sundayException.venue, UNLIT_FIELD),
      date: otherSunday,
      kickoffMinutes: 10 * 60,
      format: ELEVEN,
    });
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.PERMIT_UNDECLARED);
    expect(codesOf(result)).not.toContain(AVAILABILITY_REASON.PERMIT_BLACKOUT);
    expect(result.status).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(constraintOf(result, AVAILABILITY_CONSTRAINT.PERMIT).applicable).toBe(false);
  });

  it('applies the more restrictive record when two of equal specificity disagree', () => {
    // Never a silent winner: the same contract `EQUIPMENT_PRECEDENCE_AMBIGUOUS`
    // keeps in Phase 1.1.
    const venueId = season2026VenueId(UNLIT_VENUE);
    const input = toAvailabilityCalendarInput(permits, sunsets);
    const rival = {
      id: 'rival-exception',
      venueId,
      scopeKind: 'date-exception',
      weekday: null,
      date: ACCEPTANCE_DATE,
      hasPermit: true,
      openMinutes: 8 * 60,
      closeMinutes: 17 * 60,
      lit: null,
      lightsOffMinutes: null,
      note: 'rival record',
      source: 'test',
    };
    const twin = { ...rival, id: 'rival-exception-2', closeMinutes: 19 * 60 };
    const rivalled = buildAvailabilityCalendar({
      ...input,
      permitWindows: [...input.permitWindows, rival, twin],
    });

    const resolved = resolvePermitWindow(rivalled, { venueId, date: ACCEPTANCE_DATE });
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.window.id).toBe(rival.id); // the earlier close wins
    expect(resolved.candidates.length).toBe(2);

    const result = checkKickoffAvailability(graph, table, rivalled, {
      surfaceId: UNLIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: 10 * 60,
      format: ELEVEN,
    });
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.PERMIT_PRECEDENCE_AMBIGUOUS);
  });

  it('resolves two equally restrictive records the same way whichever order they arrive in', () => {
    // Two blackouts are equally restrictive, so the documented id tie-break is
    // the only thing left to decide between them. A resolver that answers
    // "aaa" or "zzz" depending on the order the records were loaded in is the
    // non-determinism "report the tie, never silently pick" exists to prevent.
    const venueId = season2026VenueId(UNLIT_VENUE);
    const input = toAvailabilityCalendarInput(permits, sunsets);
    const blackout = (id) => ({
      id,
      venueId,
      scopeKind: 'date-exception',
      weekday: null,
      date: ACCEPTANCE_DATE,
      hasPermit: false,
      openMinutes: null,
      closeMinutes: null,
      lit: null,
      lightsOffMinutes: null,
      note: 'field closed',
      source: 'test',
    });
    const first = blackout('aaa-blackout');
    const second = blackout('zzz-blackout');
    const resolveWith = (windows) =>
      resolvePermitWindow(
        buildAvailabilityCalendar({
          ...input,
          permitWindows: [...input.permitWindows, ...windows],
        }),
        { venueId, date: ACCEPTANCE_DATE }
      );

    const forwards = resolveWith([first, second]);
    const backwards = resolveWith([second, first]);

    // Meta-assertion: both records really did survive to the tie-break.
    expect(forwards.candidates).toHaveLength(2);
    expect(backwards.candidates).toHaveLength(2);

    expect(forwards.window.id).toBe(backwards.window.id);
    expect(forwards.window.id).toBe(first.id);
    expect(forwards.candidates.map((window) => window.id)).toEqual(
      backwards.candidates.map((window) => window.id)
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Lighting is per field (GAP-05)                                              */
/* -------------------------------------------------------------------------- */

describe('facility availability :: lighting is a property of the field', () => {
  it('falls back to the venue flag for this corpus, and says that it did', () => {
    // Honest about the fixture: `facility_geometry.json` carries `lit` at venue
    // level only, so every corpus field resolves this way.
    const resolved = resolveLighting(graph, calendar, UNLIT);
    expect(resolved.lit).toBe(false);
    expect(resolved.source).toBe('venue');
    expect(resolved.recordId).toBe(season2026VenueId(UNLIT_VENUE));
    expect(calendar.stats.lightingRecordCount).toBe(0);

    const result = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: UNLIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: 10 * 60,
      format: ELEVEN,
    });
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.LIGHTING_FROM_VENUE);
  });

  it('lets one field of an unlit venue be lit without lighting its neighbours', () => {
    const tuned = calendarWith({
      lighting: [{ surfaceId: UNLIT, lit: true, note: 'new floodlights on Pitch 2 only' }],
    });
    expect(tuned.stats.lightingRecordCount).toBe(1);

    const lit = latestLegalKickoff(graph, table, tuned, {
      surfaceId: UNLIT,
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });
    const neighbour = latestLegalKickoff(graph, table, tuned, {
      surfaceId: sid(UNLIT_VENUE, 'Pitch 3'),
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });

    const permitClose = resolvePermitWindow(tuned, {
      venueId: season2026VenueId(UNLIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window.closeMinutes;

    expect(lit.lit).toBe(true);
    expect(lit.lighting.source).toBe('surface');
    expect(lit.kickoffMinutes).toBe(permitClose - OCCUPANCY);
    expect(lit.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);

    // The pitch next to it is untouched: still dark, so the same minute carries the sunset
    // warning that the lit pitch does not.
    expect(neighbour.lit).toBe(false);
    expect(neighbour.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
    expect(neighbour.kickoffMinutes).toBe(permitClose - OCCUPANCY);
    expect(codesOf(neighbour)).toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
    expect(codesOf(lit)).not.toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
  });

  it('inherits a lighting record from a parent surface down to its halves', () => {
    const parent = sid(UNLIT_VENUE, 'Pitch 1');
    const half = sid(UNLIT_VENUE, 'Pitch 1A');
    expect(graph.surfaces[half].parentId).toBe(parent);

    const tuned = calendarWith({ lighting: [{ surfaceId: parent, lit: true }] });
    const resolved = resolveLighting(graph, tuned, half);
    expect(resolved.lit).toBe(true);
    expect(resolved.source).toBe('ancestor-surface');
    expect(resolved.recordId).toBe(parent);

    const result = checkKickoffAvailability(graph, table, tuned, {
      surfaceId: half,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: 10 * 60,
      format: '9v9',
    });
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.LIGHTING_FROM_ANCESTOR);
  });

  it('reports two lighting records for one field instead of silently overwriting', () => {
    // The permit and sunset paths both report a duplicate and apply the more
    // restrictive record; lighting must not be the one place a second record
    // wins by arriving last.
    const lit = { surfaceId: UNLIT, lit: true, lightsOffMinutes: 22 * 60, note: 'floodlights' };
    const dark = { surfaceId: UNLIT, lit: false, note: 'floodlights taken out of service' };

    const forwards = calendarWith({ lighting: [lit, dark] });
    const backwards = calendarWith({ lighting: [dark, lit] });

    for (const tuned of [forwards, backwards]) {
      expect(codesOf(tuned)).toContain(AVAILABILITY_REASON.LIGHTING_PRECEDENCE_AMBIGUOUS);
      // Meta-assertion: both records were read, and one field is resolved.
      expect(tuned.meta.lightingRecordsConsulted).toBe(2);
      expect(tuned.stats.lightingRecordCount).toBe(1);
      // The more restrictive record is applied, whichever order they arrive in.
      expect(resolveLighting(graph, tuned, UNLIT).lit).toBe(false);
    }

    // Reported, not refused: an ambiguity is informational in all three paths.
    expect(deriveAvailabilityStatus(forwards.findings)).toBe(AVAILABILITY_STATUS.ALLOWED);
  });

  it('bounds a lit field by its lights-off time when one is recorded', () => {
    // The fourth constraint with something to say. `facility_permits.csv` has no
    // lights-off column, so the corpus never exercises this - and the model says
    // so out loud rather than pretending the permit close is a lights-off time.
    const bare = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: 18 * 60,
      format: ELEVEN,
    });
    expect(codesOf(bare)).toContain(AVAILABILITY_REASON.LIGHTS_OFF_UNDECLARED);
    expect(constraintOf(bare, AVAILABILITY_CONSTRAINT.LIGHTING).applicable).toBe(false);

    const permitClose = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(LIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window.closeMinutes;
    const lightsOffMinutes = permitClose - 30;
    const tuned = calendarWith({
      lighting: [{ surfaceId: LIT, lit: true, lightsOffMinutes, note: 'curfew' }],
    });

    const result = latestLegalKickoff(graph, table, tuned, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });
    expect(result.kickoffMinutes).toBe(lightsOffMinutes - OCCUPANCY);
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.LIGHTING]);
    expect(constraintOf(result, AVAILABILITY_CONSTRAINT.LIGHTING).limitMinutes).toBe(
      lightsOffMinutes
    );
    // The permit is still evaluated and still looser.
    expect(constraintOf(result, AVAILABILITY_CONSTRAINT.PERMIT).slackMinutes).toBe(30);

    const late = checkKickoffAvailability(graph, table, tuned, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: lightsOffMinutes - OCCUPANCY + 1,
      format: ELEVEN,
    });
    expect(late.status).toBe(AVAILABILITY_STATUS.REJECTED);
    expect(codesOf(late)).toContain(AVAILABILITY_REASON.LIGHTS_OFF_EXCEEDED);
  });
});

/* -------------------------------------------------------------------------- */
/* Occupancy is one of the four                                                */
/* -------------------------------------------------------------------------- */

describe('facility availability :: occupancy bounds the answer through the facility graph', () => {
  /** A blocker derived from the permit-bound answer, on the *overlapping* pitch. */
  const permitBoundKickoff = UNLIT_LEGAL_LATEST;
  const blockerStart = permitBoundKickoff + 30;
  const blocker = {
    id: 'blocker',
    surfaceId: sid(UNLIT_VENUE, 'Pitch 1A'),
    date: ACCEPTANCE_DATE,
    startMinutes: blockerStart,
    endMinutes: blockerStart + 65,
    format: '9v9',
    label: 'a 9v9 on the overlapping half',
  };

  it('is pushed earlier by a booking on ground that only *overlaps* this pitch', () => {
    // Incident 3's geometry doing real work: nothing is booked on Pitch 2 at
    // all, and the answer still moves.
    const result = latestLegalKickoff(
      graph,
      table,
      calendar,
      { surfaceId: UNLIT, date: ACCEPTANCE_DATE, format: ELEVEN },
      { existingBookings: [blocker] }
    );

    expect(result.kickoffMinutes).toBe(blockerStart - OCCUPANCY);
    expect(result.kickoffMinutes).toBeLessThan(permitBoundKickoff);
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.OCCUPANCY]);

    const occupancy = constraintOf(result, AVAILABILITY_CONSTRAINT.OCCUPANCY);
    expect(occupancy.limitMinutes).toBe(blockerStart);
    expect(occupancy.slackMinutes).toBe(0);
    expect(occupancy.detail.boundByBookingIds).toEqual([blocker.id]);
    expect(occupancy.detail.boundBySurfaceIds).toEqual([blocker.surfaceId]);

    // ...and the other three are still reported, in the order of their limits (derived here from
    // the raw numbers, not read back), whether or not each one blocks.
    const expectedOrder = [
      { kind: AVAILABILITY_CONSTRAINT.OCCUPANCY, latest: blockerStart - OCCUPANCY },
      { kind: AVAILABILITY_CONSTRAINT.SUNSET, latest: UNLIT_CLEAN_LATEST },
      { kind: AVAILABILITY_CONSTRAINT.PERMIT, latest: UNLIT_LEGAL_LATEST },
    ]
      .sort((a, b) => a.latest - b.latest)
      .map((entry) => entry.kind);
    expect(result.constraints.map((constraint) => constraint.kind).slice(0, 3)).toEqual(
      expectedOrder
    );
    expect(constraintOf(result, AVAILABILITY_CONSTRAINT.SUNSET).slackMinutes).toBe(
      ACCEPTANCE_SUNSET - calendar.sunsetMarginMinutes - result.endMinutes
    );

    // Meta-assertions: the overlap relation was actually consulted.
    expect(result.meta.overlapPairsConsulted).toBeGreaterThan(0);
    expect(result.meta.bookingPairsCompared).toBeGreaterThan(0);
  });

  it('is unmoved by a booking on ground that does not conflict', () => {
    // The spatial control: Pitch 3 overlaps Pitch 4, not Pitch 2 (or Pitch 1).
    const elsewhere = { ...blocker, id: 'elsewhere', surfaceId: sid(UNLIT_VENUE, 'Pitch 4A') };
    const result = latestLegalKickoff(
      graph,
      table,
      calendar,
      { surfaceId: UNLIT, date: ACCEPTANCE_DATE, format: ELEVEN },
      { existingBookings: [elsewhere] }
    );
    expect(result.kickoffMinutes).toBe(permitBoundKickoff);
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
    expect(result.meta.overlapPairsConsulted).toBeGreaterThan(0);
  });

  it('is unmoved by a conflicting booking on a different date', () => {
    // The date control.
    const otherDay = { ...blocker, id: 'other-day', date: EARLY_OPEN_DATE };
    const result = latestLegalKickoff(
      graph,
      table,
      calendar,
      { surfaceId: UNLIT, date: ACCEPTANCE_DATE, format: ELEVEN },
      { existingBookings: [otherDay] }
    );
    expect(result.kickoffMinutes).toBe(permitBoundKickoff);
  });

  it('ignores the fixture being re-timed, so a game does not block itself', () => {
    const self = { ...blocker, id: 'self', surfaceId: UNLIT };
    const result = latestLegalKickoff(
      graph,
      table,
      calendar,
      {
        surfaceId: UNLIT,
        date: ACCEPTANCE_DATE,
        format: ELEVEN,
        ignoreBookingIds: [self.id],
      },
      { existingBookings: [self] }
    );
    expect(result.kickoffMinutes).toBe(permitBoundKickoff);
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
  });

  it('finds the earlier gap when the window right below the limit is occupied', () => {
    // A booking spanning the permit-bound slot: the answer must fall back to the
    // latest kickoff that finishes as that booking starts, not give up.
    const wall = {
      ...blocker,
      id: 'wall',
      startMinutes: permitBoundKickoff - 10,
      endMinutes: permitBoundKickoff + OCCUPANCY,
    };
    const result = latestLegalKickoff(
      graph,
      table,
      calendar,
      { surfaceId: UNLIT, date: ACCEPTANCE_DATE, format: ELEVEN },
      { existingBookings: [wall] }
    );
    expect(result.kickoffMinutes).toBe(wall.startMinutes - OCCUPANCY);
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.OCCUPANCY]);
    expect(blockingOf(result)).toEqual([]);
    expect(result.candidatesTested).toBeGreaterThan(1);
  });

  it('answers "no legal kickoff" when the whole permitted window is occupied', () => {
    const permitWindow = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(UNLIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window;
    const wall = {
      ...blocker,
      id: 'all-day',
      startMinutes: permitWindow.openMinutes,
      endMinutes: permitWindow.closeMinutes,
    };
    const result = latestLegalKickoff(
      graph,
      table,
      calendar,
      { surfaceId: UNLIT, date: ACCEPTANCE_DATE, format: ELEVEN },
      { existingBookings: [wall] }
    );
    expect(result.kickoffMinutes).toBeNull();
    expect(result.status).toBe(AVAILABILITY_STATUS.REJECTED);
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.NO_LEGAL_KICKOFF);
    expect(result.candidatesTested).toBeGreaterThan(0);
  });

  it('marks both constraints when two blocking constraints bind equally hard; a sunset limit never binds', () => {
    // Ties are real: a permit that closes exactly at the lights-off time binds
    // with the lighting rule, and an explanation that named only one would be
    // half a truth. Ordered by the declared tie-break, not by chance.
    const permitClose = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(LIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window.closeMinutes;
    const tiedLights = calendarWith({
      lighting: [
        { surfaceId: LIT, lit: true, lightsOffMinutes: permitClose, note: 'curfew = close' },
      ],
    });
    const lights = latestLegalKickoff(graph, table, tiedLights, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });
    expect(lights.bindingKinds).toEqual([
      AVAILABILITY_CONSTRAINT.LIGHTING,
      AVAILABILITY_CONSTRAINT.PERMIT,
    ]);
    expect(constraintOf(lights, AVAILABILITY_CONSTRAINT.LIGHTING).binding).toBe(true);
    expect(constraintOf(lights, AVAILABILITY_CONSTRAINT.PERMIT).binding).toBe(true);

    // The same tie with the daylight limit: a permit that closes exactly at the limit ties with
    // the sunset rule on the numbers (both have no room left) but only the permit BINDS, because
    // running past the daylight limit is a warning (owner, 2026-11-02), not a bound.
    const venueId = season2026VenueId(UNLIT_VENUE);
    const input = toAvailabilityCalendarInput(permits, sunsets);
    const tied = buildAvailabilityCalendar({
      ...input,
      permitWindows: [
        ...input.permitWindows,
        {
          id: 'tied-close',
          venueId,
          scopeKind: 'date-exception',
          weekday: null,
          date: ACCEPTANCE_DATE,
          hasPermit: true,
          openMinutes: 7 * 60,
          closeMinutes: ACCEPTANCE_SUNSET - input.sunsetMarginMinutes,
          lit: false,
          lightsOffMinutes: null,
          note: 'closes exactly at the daylight limit',
          source: 'test',
        },
      ],
    });

    const result = latestLegalKickoff(graph, table, tied, {
      surfaceId: UNLIT,
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });
    expect(result.kickoffMinutes).toBe(UNLIT_CLEAN_LATEST);
    expect(result.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.PERMIT]);
    expect(constraintOf(result, AVAILABILITY_CONSTRAINT.SUNSET).binding).toBe(false);
    expect(constraintOf(result, AVAILABILITY_CONSTRAINT.SUNSET).slackMinutes).toBe(0);
    expect(constraintOf(result, AVAILABILITY_CONSTRAINT.PERMIT).binding).toBe(true);
    expect(constraintOf(result, AVAILABILITY_CONSTRAINT.PERMIT).slackMinutes).toBe(0);
    // And nothing is past the limit at that minute, so no warning either.
    expect(codesOf(result)).not.toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
  });
});

/* -------------------------------------------------------------------------- */
/* Full-corpus replay                                                          */
/* -------------------------------------------------------------------------- */

describe('facility availability :: full-corpus replay', () => {
  const replay = (replayCalendar = calendar) => {
    const summary = {
      checked: 0,
      availabilityBreaches: [],
      // Every SUNSET_MARGIN_VIOLATED, at any severity. Since the owner's decision of 2026-11-02 it
      // is a compromise, so `availabilityBreaches` (blocking only) no longer sees it: a replay
      // that kept looking only at blockers would call a season that ends in the dark clean.
      daylightWarnings: [],
      otherBlocking: [],
      compromised: 0,
      unlitChecked: 0,
      litChecked: 0,
      dateExceptionRows: 0,
      weekdayDefaultRows: 0,
      unknownFootprint: 0,
      meta: { permitWindowsConsulted: 0, sunsetRecordsConsulted: 0, constraintsEvaluated: 0 },
    };
    for (const game of combinedGames) {
      const surfaceId = sid(game.venue, game.field);
      const result = checkKickoffAvailability(graph, table, replayCalendar, {
        surfaceId,
        date: game.date,
        kickoffMinutes: game.kickoffMinutes,
        format: game.format,
      });
      summary.checked += 1;
      const codes = codesOf(result);
      if (codes.includes(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED)) {
        summary.daylightWarnings.push({ game: game.id, date: game.date });
      }
      for (const finding of blockingOf(result)) {
        const bucket = Object.values(AVAILABILITY_REASON).includes(finding.code)
          ? summary.availabilityBreaches
          : summary.otherBlocking;
        bucket.push({ game: game.id, code: finding.code, format: game.format });
      }
      if (result.status === AVAILABILITY_STATUS.COMPROMISED) summary.compromised += 1;
      if (codes.includes(TIMING_REASON.FORMAT_TIMING_UNDEFINED)) summary.unknownFootprint += 1;
      if (codes.includes(AVAILABILITY_REASON.PERMIT_DATE_EXCEPTION)) summary.dateExceptionRows += 1;
      if (codes.includes(AVAILABILITY_REASON.PERMIT_WEEKDAY_DEFAULT))
        summary.weekdayDefaultRows += 1;
      if (result.endMinutes !== null) {
        if (result.lit) summary.litChecked += 1;
        else summary.unlitChecked += 1;
      }
      for (const key of Object.keys(summary.meta)) summary.meta[key] += result.meta[key];
    }
    return summary;
  };

  it('finds no permit breach and no daylight breach anywhere in the published season', () => {
    // The strongest single regression in this file. The corpus's own invariant
    // (README: "no unlit game ends within 15 min of sunset; no game sits outside
    // its venue permit") replayed through the model that now owns the rule.
    const summary = replay();
    // Not one permit breach and not one daylight breach in 679 published rows: blocking ones
    // (the permit) and warnings (the daylight margin) alike.
    expect(summary.availabilityBreaches).toEqual([]);
    expect(summary.daylightWarnings).toEqual([]);
    expect(summary.checked).toBe(combinedGames.length);
    expect(summary.checked).toBe(679);

    // The only blocking verdicts anywhere in the replay come from Phase 1.1 and
    // belong to the four untimed `Scrimmage` rows, whose format cannot be ranked
    // for size either (GAP-14). Reported rather than swallowed - and asserted
    // here so this replay can never quietly start tolerating a new one.
    expect(summary.otherBlocking.map((entry) => entry.code)).toEqual(
      Array(4).fill(FACILITY_REASON.SIZE_UNKNOWN_FORMAT)
    );
    for (const entry of summary.otherBlocking) {
      expect(formatsByName[entry.format]).toBeUndefined();
    }

    // Meta-assertions: a replay that matched nothing would report a perfect
    // score (incident 4).
    expect(summary.unlitChecked).toBeGreaterThan(600);
    expect(summary.litChecked).toBeGreaterThan(0);
    expect(summary.dateExceptionRows).toBeGreaterThan(0);
    expect(summary.weekdayDefaultRows).toBeGreaterThan(0);
    expect(summary.meta.permitWindowsConsulted).toBeGreaterThan(0);
    expect(summary.meta.sunsetRecordsConsulted).toBeGreaterThan(0);
    expect(summary.meta.constraintsEvaluated).toBeGreaterThan(0);
    // GAP-14: the four untimed Scrimmage rows, reported rather than dropped.
    expect(summary.unknownFootprint).toBe(4);
  });

  it('catches an injected breach of each rule in the same replay', () => {
    // Negative control for the replay above: a replay that cannot fail proves
    // nothing. One game per rule, moved by the smallest illegal amount.
    const unlitGame = combinedGames.find(
      (game) =>
        game.venue === UNLIT_VENUE && game.endMinutes !== null && sunsetOn(calendar, game.date)
    );
    expect(unlitGame).toBeDefined();
    const daylight = daylightLimitMinutes(calendar, unlitGame.date);
    const pastSunset = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: sid(unlitGame.venue, unlitGame.field),
      date: unlitGame.date,
      kickoffMinutes: daylight - (unlitGame.endMinutes - unlitGame.kickoffMinutes) + 1,
      format: unlitGame.format,
    });
    // Past sunset is a warning (owner, 2026-11-02): allowed to stand, never silent.
    expect(pastSunset.status).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(blockingOf(pastSunset)).toEqual([]);
    expect(codesOf(pastSunset)).toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);

    // ...and the replay sees it: the same published season on a calendar whose every sunset is
    // two hours earlier has games that end in the dark, none of them a blocker.
    const earlier = buildAvailabilityCalendarFromSeason2026(
      permits,
      sunsets.map((record) => ({ ...record, sunsetMinutes: record.sunsetMinutes - 120 }))
    );
    const dark = replay(earlier);
    expect(dark.daylightWarnings.length).toBeGreaterThan(0);
    expect(dark.availabilityBreaches).toEqual([]);

    const litGame = combinedGames.find(
      (game) => game.venue === LIT_VENUE && formatsByName[game.format]
    );
    expect(litGame).toBeDefined();
    const onBlackout = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: sid(litGame.venue, litGame.field),
      date: BLACKOUT_DATE,
      kickoffMinutes: litGame.kickoffMinutes,
      format: litGame.format,
    });
    expect(onBlackout.status).toBe(AVAILABILITY_STATUS.REJECTED);
    expect(codesOf(onBlackout)).toContain(AVAILABILITY_REASON.PERMIT_BLACKOUT);
  });

  it('never lets the derived answer break a rule it just reported', () => {
    // Self-consistency across every venue, field and date in the corpus: the
    // latest legal kickoff must itself pass the per-kickoff check, and must sit
    // at or below every applicable limit.
    let answered = 0;
    let unbounded = 0;
    let pastDaylight = 0;
    for (const date of [...new Set(combinedGames.map((game) => game.date))]) {
      for (const surfaceId of graph.surfaceIds) {
        if (!graph.surfaces[surfaceId].sizes.includes(ELEVEN)) continue;
        const result = latestLegalKickoff(graph, table, calendar, {
          surfaceId,
          date,
          format: ELEVEN,
        });
        if (result.kickoffMinutes === null) continue;
        answered += 1;
        expect(blockingOf(result), `${surfaceId} ${date}`).toEqual([]);
        for (const constraint of result.constraints) {
          if (!constraint.applicable || constraint.limitMinutes === null) continue;
          // The daylight limit is the one limit a legal answer may run past (owner, 2026-11-02),
          // and when it does the answer says so; every other limit is kept.
          if (constraint.kind === AVAILABILITY_CONSTRAINT.SUNSET) {
            if (result.endMinutes > constraint.limitMinutes) {
              pastDaylight += 1;
              expect(codesOf(result), `${surfaceId} ${date}`).toContain(
                AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED
              );
            }
            continue;
          }
          expect(result.endMinutes, `${surfaceId} ${date} ${constraint.kind}`).toBeLessThanOrEqual(
            constraint.limitMinutes
          );
        }
        // Either something bounds the answer, or the calendar has admitted it
        // holds no permit record for that venue on that date. Silence is never
        // the third option.
        if (result.bindingKinds.length === 0) {
          expect(codesOf(result), `${surfaceId} ${date}`).toContain(
            AVAILABILITY_REASON.PERMIT_UNDECLARED
          );
          unbounded += 1;
        }
      }
    }
    expect(answered).toBeGreaterThan(20);
    expect(unbounded).toBeLessThan(answered);
    // Meta-assertion: the daylight exception was exercised, not vacuously true.
    expect(pastDaylight).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Unknowns are unknown, not guessed                                           */
/* -------------------------------------------------------------------------- */

describe('facility availability :: unknowns stay unknown', () => {
  it('refuses to answer for a format with no timing row, and says why (GAP-14)', () => {
    const scrimmage = combinedGames.find((game) => !formatsByName[game.format]);
    expect(scrimmage).toBeDefined();

    const result = latestLegalKickoff(graph, table, calendar, {
      surfaceId: UNLIT,
      date: ACCEPTANCE_DATE,
      format: scrimmage.format,
    });
    expect(result.kickoffMinutes).toBeNull();
    expect(result.occupancyMinutes).toBeNull();
    expect(codesOf(result)).toContain(TIMING_REASON.FORMAT_TIMING_UNDEFINED);
    expect(result.status).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(result.constraints).toEqual([]);
  });

  it('reports an unlit field on a date with no sunset record rather than guessing', () => {
    const noSunset = buildAvailabilityCalendar({
      ...toAvailabilityCalendarInput(permits, sunsets),
      sunsets: [],
    });
    const result = checkKickoffAvailability(graph, table, noSunset, {
      surfaceId: UNLIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: 18 * 60,
      format: ELEVEN,
    });
    expect(codesOf(result)).toContain(AVAILABILITY_REASON.SUNSET_UNKNOWN);
    expect(result.status).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(constraintOf(result, AVAILABILITY_CONSTRAINT.SUNSET).applicable).toBe(false);
    expect(daylightLimitMinutes(noSunset, ACCEPTANCE_DATE)).toBeNull();
  });

  it('reports an unknown surface instead of throwing', () => {
    const result = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: 'no-such-surface',
      date: ACCEPTANCE_DATE,
      kickoffMinutes: 10 * 60,
      format: ELEVEN,
    });
    expect(result.status).toBe(AVAILABILITY_STATUS.REJECTED);
    expect(codesOf(result)).toContain(FACILITY_REASON.SURFACE_UNKNOWN);
    expect(venueIdOfSurface(graph, 'no-such-surface')).toBeNull();

    const derived = latestLegalKickoff(graph, table, calendar, {
      surfaceId: 'no-such-surface',
      date: ACCEPTANCE_DATE,
      format: ELEVEN,
    });
    expect(derived.kickoffMinutes).toBeNull();
    expect(codesOf(derived)).toContain(FACILITY_REASON.SURFACE_UNKNOWN);
  });

  it('keeps the Phase 1.2 format verdicts in the same list', () => {
    // A format whose own arithmetic disagrees must never produce a clean
    // availability verdict - that is incident 7 wearing a different hat.
    // Derived from the corpus row with only the half length moved, so the
    // declared occupancy no longer follows from the halves.
    const input = toFormatTimingInput(rawFormats);
    const broken = buildFormatTimingTable({
      ...input,
      formats: input.formats.map((entry) =>
        entry.format === ELEVEN ? { ...entry, halfMinutes: entry.halfMinutes + 5 } : entry
      ),
    });
    expect(broken.findings.map((finding) => finding.code)).toContain(
      TIMING_REASON.OCCUPANCY_DERIVATION_DISAGREES
    );
    // The format is still perfectly well *known*: this is not the GAP-14 path.
    expect(requireFormatTiming(broken, ELEVEN).occupancyMinutes.scheduled).toBe(OCCUPANCY);

    const permitClose = resolvePermitWindow(calendar, {
      venueId: season2026VenueId(LIT_VENUE),
      date: ACCEPTANCE_DATE,
    }).window.closeMinutes;
    // Lit ground, an hour inside the permit close: nothing else can object.
    const kickoffMinutes = permitClose - OCCUPANCY - 60;
    const result = checkKickoffAvailability(graph, broken, calendar, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes,
      format: ELEVEN,
    });
    expect(codesOf(result)).toContain(TIMING_REASON.OCCUPANCY_DERIVATION_DISAGREES);
    expect(result.status).toBe(AVAILABILITY_STATUS.REJECTED);

    // Meta-assertion: the very same query against the corpus's own table is
    // clean, so it is the broken arithmetic doing the rejecting.
    const clean = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: LIT,
      date: ACCEPTANCE_DATE,
      kickoffMinutes,
      format: ELEVEN,
    });
    expect(clean.status).toBe(AVAILABILITY_STATUS.ALLOWED);
    expect(codesOf(clean)).not.toContain(TIMING_REASON.OCCUPANCY_DERIVATION_DISAGREES);
  });

  it('keeps the Phase 1.1 verdicts in the same list', () => {
    // A 9v9 on a 7v7-lined pitch is a lining compromise, and availability must
    // not swallow it just because the permit is fine.
    const brookside = sid('Brookside Park', 'Upper 1');
    const result = checkKickoffAvailability(graph, table, calendar, {
      surfaceId: brookside,
      date: ACCEPTANCE_DATE,
      kickoffMinutes: 10 * 60,
      format: '9v9',
    });
    expect(codesOf(result)).toContain(FACILITY_REASON.LINING_MISMATCH);
    expect(result.status).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(result.meta.surfacesConsidered).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Reason codes, schemas and purity                                            */
/* -------------------------------------------------------------------------- */

describe('facility availability :: reason codes and statuses', () => {
  it('registers a severity for every reason code', () => {
    const codes = Object.values(AVAILABILITY_REASON);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(AVAILABILITY_REASON_SEVERITY[code], code).toBeDefined();
      expect(Object.values(AVAILABILITY_SEVERITY)).toContain(AVAILABILITY_REASON_SEVERITY[code]);
      expect(availabilitySeverityOf(code)).toBe(AVAILABILITY_REASON_SEVERITY[code]);
    }
    // The two that carry the module's policy, in the table where 2.1 overrides them.
    expect(availabilitySeverityOf(AVAILABILITY_REASON.PERMIT_BLACKOUT)).toBe(
      AVAILABILITY_SEVERITY.BLOCKING
    );
    expect(availabilitySeverityOf(AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT)).toBe(
      AVAILABILITY_SEVERITY.COMPROMISE
    );
  });

  it('throws on an unregistered code rather than defaulting to info', () => {
    expect(() => availabilitySeverityOf('NOT_A_CODE')).toThrow(/no registered severity/);
  });

  it('derives all three statuses mechanically', () => {
    expect(deriveAvailabilityStatus([])).toBe(AVAILABILITY_STATUS.ALLOWED);
    expect(
      deriveAvailabilityStatus([
        makeAvailabilityFinding(AVAILABILITY_REASON.PERMIT_WEEKDAY_DEFAULT, 'info'),
      ])
    ).toBe(AVAILABILITY_STATUS.ALLOWED);
    expect(
      deriveAvailabilityStatus([
        makeAvailabilityFinding(AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT, 'tight'),
      ])
    ).toBe(AVAILABILITY_STATUS.COMPROMISED);
    expect(
      deriveAvailabilityStatus([
        makeAvailabilityFinding(AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT, 'tight'),
        makeAvailabilityFinding(AVAILABILITY_REASON.PERMIT_BLACKOUT, 'no permit'),
      ])
    ).toBe(AVAILABILITY_STATUS.REJECTED);
  });

  it('shares the severity and status vocabularies with the facility module', () => {
    // Imported, not redeclared - the same reason `timing/reasonCodes.js` does it.
    expect(AVAILABILITY_SEVERITY.BLOCKING).toBe('blocking');
    expect(AVAILABILITY_STATUS.COMPROMISED).toBe('compromised');
    expect(AVAILABILITY_CONSTRAINT_ORDER).toHaveLength(4);
    expect([...AVAILABILITY_CONSTRAINT_ORDER].sort()).toEqual(
      Object.values(AVAILABILITY_CONSTRAINT).sort()
    );
  });
});

describe('facility availability :: schema and purity', () => {
  it('produces adapter output that satisfies the strict input schema', () => {
    const input = toAvailabilityCalendarInput(permits, sunsets);
    const parsed = AvailabilityCalendarInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(
        `adapter output violates AvailabilityCalendarInputSchema: ${parsed.error.message}`
      );
    }
    expect(input.permitWindows.length).toBe(permits.length);
    expect(input.sunsets.length).toBe(sunsets.length);
  });

  it('refuses a date-scoped permit row whose date was never resolved', () => {
    // `parseFacilityPermits()` only resolves `MM/DD` scopes when given a
    // seasonYear; without one the row would quietly stop overriding anything.
    const unresolved = loadFacilityPermits();
    expect(unresolved.some((permit) => permit.scopeKind === 'date-exception')).toBe(true);
    expect(() => toAvailabilityCalendarInput(unresolved, sunsets)).toThrow(/seasonYear/);
  });

  it('rejects malformed permit windows', () => {
    const valid = {
      id: 'w',
      venueId: 'v',
      scopeKind: 'weekday-default',
      weekday: 'SAT',
      date: null,
      hasPermit: true,
      openMinutes: 420,
      closeMinutes: 1200,
      lit: false,
      lightsOffMinutes: null,
      note: null,
      source: null,
    };
    expect(PermitWindowSchema.safeParse(valid).success).toBe(true);
    // An unrecognised key is a producer bug, not a passenger.
    expect(PermitWindowSchema.safeParse({ ...valid, surprise: 1 }).success).toBe(false);
    // A blackout states no times...
    expect(
      PermitWindowSchema.safeParse({ ...valid, hasPermit: false, closeMinutes: 1200 }).success
    ).toBe(false);
    // ...and a permit states both.
    expect(PermitWindowSchema.safeParse({ ...valid, closeMinutes: null }).success).toBe(false);
    // A window may not close before it opens.
    expect(PermitWindowSchema.safeParse({ ...valid, closeMinutes: 60 }).success).toBe(false);
    // A weekday default must say which weekday.
    expect(PermitWindowSchema.safeParse({ ...valid, weekday: null }).success).toBe(false);
    // A date exception must say which date.
    expect(
      PermitWindowSchema.safeParse({ ...valid, scopeKind: 'date-exception', date: null }).success
    ).toBe(false);
  });

  it('imports nothing from node: and nothing from the fixture loaders', () => {
    const availabilityDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'packages',
      'core',
      'src',
      'availability'
    );
    /** @type {string[]} */
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.js')) files.push(full);
      }
    };
    walk(availabilityDir);
    expect(files.length).toBeGreaterThan(5);

    const specifiers = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^\s*(?:import|export)[^\n]*?from\s+'([^']+)'/gm)) {
        specifiers.push({ file, specifier: match[1] });
      }
      // GAP-30: no Date is constructed anywhere in this package.
      expect(/new Date\(/.test(source), `${file} constructs a Date`).toBe(false);
    }
    expect(specifiers.length).toBeGreaterThan(0);
    for (const { file, specifier } of specifiers) {
      expect(specifier.startsWith('node:'), `${file} imports ${specifier}`).toBe(false);
      expect(specifier.includes('fixtures/'), `${file} imports ${specifier}`).toBe(false);
      expect(specifier.includes('react'), `${file} imports ${specifier}`).toBe(false);
    }
    // It does lean on the two modules it is built on, which is the point.
    expect(specifiers.some((entry) => entry.specifier.includes('../facility/'))).toBe(true);
    expect(specifiers.some((entry) => entry.specifier.includes('../timing/'))).toBe(true);
    expect(specifiers.some((entry) => entry.specifier === 'zod')).toBe(true);
  });

  it('does not mutate its input and returns a frozen calendar', () => {
    const input = toAvailabilityCalendarInput(permits, sunsets);
    const before = JSON.stringify(input);
    const built = buildAvailabilityCalendar(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.permitsByVenue)).toBe(true);
    expect(Object.isFrozen(built.sunsetsByDate)).toBe(true);
    expect(built.stats).toEqual(calendar.stats);
  });
});
