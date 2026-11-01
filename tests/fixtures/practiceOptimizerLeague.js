/**
 * **A small league both halves of the browser optimizer are held to** (Phase D PR D; plan
 * `docs/changes/2026-10-27-phase-d-scheduling.md`, section D).
 *
 * `tests/practiceOptimizerWorker.test.js` and `tests/autoSchedulerVerify.test.js` (Vitest) and
 * `supabase/functions/_shared/tests/auto-scheduler-verify_test.ts` (Deno) run the Edge solver, the
 * worker and `verify` over this one input, so every runtime answers one league rather than three
 * copies of it. Plain ESM with no imports, so Deno loads it by relative path; the two Edge helpers
 * it needs are passed in, as `solverDatedRun` does.
 *
 * Synthetic ids only. The league exercises every rule `verify` names:
 *
 * - `d1`: 12 teams, 2 practices a week of exactly 60 minutes; `d2`: 6 teams, one a week, any length.
 * - Coaches `c0` (teams `t0` and `t6`) and `c1` (`t1` and `t7`) coach two teams: a coach clash is
 *   possible. `t0` already holds one practice (a locked row), so it needs one more.
 * - 30 one-hour slots, Monday to Friday of the week of 2026-10-19, at 16:00, 17:00 and 18:00 on two
 *   fields, and a 45-minute one (`fb-thu-19-short`) that no 60-minute practice may take. Field
 *   `fa` is unlit with coordinates (an 18:00 slot ends after sunset in late October: flagged),
 *   field `fb` is lit. Slot `fb-fri-18` holds two teams; the five 16:00 slots of `fa` are
 *   reserved to `d2`, so `d2`'s six teams share five slots and one of them is left unplaced.
 * - `t3` has an approved coach `must_keep` that refuses every Monday slot, and a `prefer_keep` that
 *   every Friday slot breaches once.
 *
 * Maps are filled in an order that is NOT sorted, so a serialization that depended on map order
 * would be caught.
 */

export const LEAGUE_ZONE = 'America/New_York';
export const LEAGUE_TODAY = '2026-10-19';
const SEASON_END = '2026-11-20';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const FIRST_DATES = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
const HOURS = [16, 17, 18];
const FIELDS = ['fa', 'fb'];

/** Raw slots as the store dates them: id, instants on the season's clock, first and last date. */
function leagueSlots() {
  const slots = [];
  for (const field of FIELDS) {
    DAYS.forEach((day, d) => {
      for (const hh of HOURS) {
        const date = FIRST_DATES[d];
        slots.push({
          id: `${field}-${day}-${hh}`,
          field,
          start: `${date}T${hh}:00:00-04:00`,
          end: `${date}T${hh + 1}:00:00-04:00`,
          capacity: field === 'fb' && day === 'fri' && hh === 18 ? 2 : 1,
          firstDate: date,
          validUntil: SEASON_END,
        });
      }
    });
  }
  // One slot of 45 minutes, on the lit field: no `d1` practice (exactly 60 minutes) may take it.
  slots.push({
    id: 'fb-thu-19-short',
    field: 'fb',
    start: '2026-10-22T19:00:00-04:00',
    end: '2026-10-22T19:45:00-04:00',
    capacity: 1,
    firstDate: '2026-10-22',
    validUntil: SEASON_END,
  });
  return slots;
}

/**
 * @param {{
 *   toDaylightSlot: (slot: any, zone: string, stored: any) => any,
 *   prepareTeam: (team: any) => any,
 * }} helpers the Edge modules' own functions
 * @returns {any} a `PracticeSolverInput` (everything a run searches over)
 */
export function practiceOptimizerLeague({ toDaylightSlot, prepareTeam }) {
  const raw = leagueSlots();
  const slots = raw.map((s) => ({
    id: s.id,
    start: new Date(s.start),
    end: new Date(s.end),
    capacity: s.capacity,
    // D2: the store's reservation, as `applySlotReservations` puts it on the slot.
    divisionId: s.field === 'fa' && s.id.endsWith('-16') ? 'd2' : null,
  }));

  const reservedDivisionIds = new Set(['d2']);
  const teams = [];
  for (let i = 0; i < 18; i += 1) {
    const division = i < 12 ? 'd1' : 'd2';
    // c0 and c1 each coach two d1 teams, so one team's practice can clash with another's.
    const coachId = i === 6 ? 'c0' : i === 7 ? 'c1' : `c${i}`;
    teams.push({
      ...prepareTeam({ id: `t${i}`, division, coachId }),
      practicesPerWeek: division === 'd1' ? 2 : 1,
      practiceMinutes: division === 'd1' ? 60 : null,
      divisionId: division,
      reservedDivisionIds,
    });
  }

  // Unsorted insertion order, on purpose.
  const daylightSlots = new Map();
  for (const s of [...raw].reverse()) {
    daylightSlots.set(
      s.id,
      toDaylightSlot(
        slots.find((x) => x.id === s.id),
        LEAGUE_ZONE,
        {
          fieldId: s.field,
          validUntil: s.validUntil,
          firstDate: s.firstDate,
        }
      )
    );
  }
  const venues = new Map([
    ['fb', { fieldId: 'fb', locationId: 'lb', lit: true, latitude: 41, longitude: -74 }],
    ['fa', { fieldId: 'fa', locationId: 'la', lit: false, latitude: 40, longitude: -75 }],
  ]);

  // t3: every Monday slot breaks a must_keep; every Friday slot breaches a prefer_keep once. The
  // other slots say nothing and are left out of the map, as the encoder leaves them out.
  const verdicts = new Map();
  const t3 = new Map();
  for (const s of raw) {
    if (s.id.includes('-mon-')) {
      t3.set(s.id, {
        mustKeepViolated: true,
        preferKeepBreaches: 0,
        violatedDimensions: ['weekday'],
      });
    } else if (s.id.includes('-fri-')) {
      t3.set(s.id, { mustKeepViolated: false, preferKeepBreaches: 1, violatedDimensions: [] });
    } else {
      t3.set(s.id, { mustKeepViolated: false, preferKeepBreaches: 0, violatedDimensions: [] });
    }
  }
  verdicts.set('t3', t3);

  return {
    teams,
    slots,
    // t0 already holds a Tuesday 16:00 practice on fb: it is short of one.
    locked: [
      {
        assignmentId: 'row-t0',
        teamId: 't0',
        slotId: 'fb-tue-16',
        effectiveDateRange: `[${LEAGUE_TODAY},${SEASON_END}]`,
      },
    ],
    relocated: [],
    placeableTeamIds: teams.map((t) => t.id),
    outsideHolds: [],
    unitsNeeded: Object.fromEntries(
      teams.map((t) => [t.id, t.id === 't0' ? 1 : t.practicesPerWeek])
    ),
    preferenceGate: { verdicts },
    daylight: {
      slots: daylightSlots,
      venues,
      timeZone: LEAGUE_ZONE,
      today: LEAGUE_TODAY,
      lightingOverrides: [],
    },
    dating: { liveFrom: LEAGUE_TODAY, slots: daylightSlots },
  };
}

/** The search settings the parity tests use: fixed seed, enough iterations to move the answer. */
export const LEAGUE_CONFIG = Object.freeze({ timeBudgetMs: 25_000, maxIterations: 300, seed: 11 });
