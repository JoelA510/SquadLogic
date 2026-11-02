/**
 * The demo's two seasons (plans docs/changes/2026-11-01-demo-season-selection.md and
 * docs/changes/2026-11-02-demo-fall-window.md): at entry the visitor chooses a fall or a spring league, the
 * same league dated differently.
 *
 * **The server decides.** `start_demo_session(p_season)` dates the season with
 * `demo_seed.season_window()` (migrations 20261114010000, and 20261115010000 for the fall) and returns the
 * dates it used. This module is that rule's twin, for the three things the browser needs before a demo
 * exists: the window each button covers, the button to preselect, and the mock client's dates. The two are
 * held equal by one table of vectors: `tests/demoSeasons.test.js` checks this file against it and checks that
 * `supabase/tests/demo_sessions.sql` embeds exactly the same table, which the SQL is run against.
 *
 * **The rule.** A window is a Monday anchor and either a length in weeks or an end date:
 *
 *   - spring starts on the Monday on or after 22 March and runs 12 weeks (the league's `season_weeks`);
 *   - fall starts on the Monday on or after 17 August and ends on 31 October of the same year (owner,
 *     2026-11-02), so its length follows the calendar: 70 to 76 days.
 *
 * An instance is dated by the year of its start. The instance a visitor gets is the earliest whose last day
 * is on or after today (the date in the league's zone), so a window containing today gives its current
 * instance, and a window already over this year gives next year's. With no choice, the default is the
 * choice whose instance ends first: the window the date falls in, or else the next one to begin.
 *
 * **Sunset.** The practice grid is static clock times and sunset moves with the date. Spring is clear of
 * it (`tests/demoSeasons.test.js` proves no unlit slot ends within ten minutes of sunset on any practice day
 * of the spring, to 2060). The fall is not, on purpose: an unlit practice ending at 19:00 is past sunset
 * from about 24 September, and the demo shows it flagged, never blocked (owner, 2026-11-02). The same test
 * derives exactly which days, from the seed's grid and the real sunset helper.
 *
 * Pure: no `Date` is constructed from a local time and the host's zone is never read; `demoToday` names
 * the league's zone explicitly.
 */

/** The league's zone: `demo_seed.league.timezone`, held equal to the seed by `tests/demoSeasons.test.js`. */
export const DEMO_TIMEZONE = 'America/Los_Angeles';

/** The spring season's length: `demo_seed.league.season_weeks`, held equal to the seed by the same test. */
export const DEMO_SPRING_WEEKS = 12;

/**
 * The two seasons a demo may be dated in, in the order the entry page lists them. `month` is 1-12. A window
 * is anchored on the Monday on or after `month`/`day` and ends either after `weeks` weeks or on
 * `endMonth`/`endDay` of the same year, never both.
 * @type {Readonly<Record<'fall' | 'spring', Readonly<{ label: string, month: number, day: number, weeks?: number, endMonth?: number, endDay?: number }>>>}
 */
const WINDOWS = Object.freeze({
  fall: Object.freeze({ label: 'Fall', month: 8, day: 17, endMonth: 10, endDay: 31 }),
  spring: Object.freeze({ label: 'Spring', month: 3, day: 22, weeks: DEMO_SPRING_WEEKS }),
});

/** @typedef {'fall' | 'spring'} DemoSeason */

/** The choices, in the order the entry page lists them. */
export const DEMO_SEASONS = /** @type {ReadonlyArray<DemoSeason>} */ (
  Object.freeze(Object.keys(WINDOWS))
);

/**
 * The one line under the Fall option on the entry page (owner, 2026-11-02): the fall's late practices end
 * after sunset from the last week of September, and the demo flags them on purpose. The spring has no line.
 */
export const DEMO_FALL_NOTE = 'Evening practices that end after sunset are flagged, by design.';

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Is this one of the two choices the server accepts? Exactly 'fall' or 'spring': no trimming, no case
 * folding, as the RPC (a value from outside is not interpreted).
 * @param {unknown} value
 * @returns {value is DemoSeason}
 */
export function isDemoSeason(value) {
  return value === 'fall' || value === 'spring';
}

/**
 * @param {string} iso `YYYY-MM-DD`
 * @returns {number} epoch ms at 00:00 UTC of that calendar date
 */
function parseIsoDate(iso) {
  const match = ISO_DATE.exec(String(iso));
  if (!match) throw new TypeError(`not an ISO date: ${String(iso)}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new TypeError(`not a calendar date: ${iso}`);
  }
  return ms;
}

/** @param {number} ms */
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The Monday on or after a date.
 * @param {number} ms epoch ms at 00:00 UTC
 */
function mondayOnOrAfter(ms) {
  const weekday = new Date(ms).getUTCDay() || 7; // Monday 1 .. Sunday 7
  return ms + ((8 - weekday) % 7) * DAY_MS;
}

/**
 * @typedef {Object} DemoSeasonWindow
 * @property {DemoSeason} season
 * @property {string} label - `Fall` or `Spring`
 * @property {string} start - `YYYY-MM-DD`, a Monday
 * @property {string} end - `YYYY-MM-DD`, the season's last day (a Sunday for the spring, 31 October for the fall)
 * @property {number} year - the year of `start`
 * @property {number} weeks - the Monday-to-Sunday weeks the season touches (the last may be a part week)
 */

/**
 * The instance of a window a visitor gets on a given date: the earliest whose last day is on or after it.
 * @param {DemoSeason} season
 * @param {string} today `YYYY-MM-DD`, the date in the league's zone
 * @returns {DemoSeasonWindow}
 */
function instanceOn(season, today) {
  const todayMs = parseIsoDate(today);
  const { label, month, day, weeks, endMonth, endDay } = WINDOWS[season];
  const thisYear = new Date(todayMs).getUTCFullYear();
  /** @param {number} year */
  const instance = (year) => {
    const start = mondayOnOrAfter(Date.UTC(year, month - 1, day));
    const end =
      weeks === undefined
        ? Date.UTC(year, /** @type {number} */ (endMonth) - 1, /** @type {number} */ (endDay))
        : start + (weeks * 7 - 1) * DAY_MS;
    return {
      season,
      label,
      start: toIso(start),
      end: toIso(end),
      year,
      weeks: Math.ceil(((end - start) / DAY_MS + 1) / 7),
    };
  };
  // A window ends in the year it starts, so this year's instance, else next year's, is the answer.
  const current = instance(thisYear);
  return parseIsoDate(current.end) >= todayMs ? current : instance(thisYear + 1);
}

/**
 * The window the server dates a demo with.
 * @param {DemoSeason | null | undefined} choice - `null`/`undefined` is the default
 * @param {string} today `YYYY-MM-DD`
 * @returns {DemoSeasonWindow}
 * @throws {TypeError} for a choice that is neither, or a `today` that is not a calendar date
 */
export function demoSeasonWindow(choice, today) {
  if (choice === null || choice === undefined)
    return demoSeasonWindow(defaultDemoSeason(today), today);
  if (!isDemoSeason(choice)) throw new TypeError(`unknown demo season: ${String(choice)}`);
  return instanceOn(choice, today);
}

/**
 * The preselected choice: the one whose instance ends first, i.e. the window the date falls in, or else
 * the next one to begin.
 * @param {string} today `YYYY-MM-DD`
 * @returns {DemoSeason}
 */
export function defaultDemoSeason(today) {
  const [first, second] = DEMO_SEASONS.map((season) => instanceOn(season, today));
  return second.end < first.end ? second.season : first.season;
}

/**
 * Today's date in the league's zone, which is the date the server dates a demo from.
 * @param {number} [now] epoch ms
 * @returns {string} `YYYY-MM-DD`
 */
export function demoToday(now = Date.now()) {
  // 'en-CA' formats as YYYY-MM-DD; the zone is named, never the host's.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DEMO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The season's name, as the server writes it: `Fall 2027`.
 * @param {Pick<DemoSeasonWindow, 'label' | 'year'>} window
 */
export function demoSeasonName(window) {
  return `${window.label} ${window.year}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});
const DATE_YEAR_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/**
 * The dates a window covers, for a person: `Aug 23 to Oct 31, 2027`.
 * @param {Pick<DemoSeasonWindow, 'start' | 'end'>} window
 */
export function describeDemoWindow(window) {
  const start = parseIsoDate(window.start);
  const end = parseIsoDate(window.end);
  const sameYear = new Date(start).getUTCFullYear() === new Date(end).getUTCFullYear();
  return `${(sameYear ? DATE_FORMAT : DATE_YEAR_FORMAT).format(start)} to ${DATE_YEAR_FORMAT.format(end)}`;
}

/**
 * The two buttons of the entry page, with the window each covers today. `note` is the one extra line a
 * button carries (the fall's), or `null`.
 * @param {string} today `YYYY-MM-DD`
 * @returns {Array<DemoSeasonWindow & { name: string, dates: string, note: string | null }>}
 */
export function demoSeasonOptions(today) {
  return DEMO_SEASONS.map((season) => {
    const window = instanceOn(season, today);
    return {
      ...window,
      name: demoSeasonName(window),
      dates: describeDemoWindow(window),
      note: season === 'fall' ? DEMO_FALL_NOTE : null,
    };
  });
}
