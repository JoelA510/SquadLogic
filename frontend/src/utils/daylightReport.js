/**
 * The auto-scheduler's daylight report (8.9 PR 6), as one status line.
 *
 * The Edge Function returns `daylight` on every run: each new placement with a
 * date past sunset on unlit ground (kept whole and flagged: past sunset is
 * flagged, never blocked, owner 2026-10-27), each placement or locked row
 * whose sunset could not be judged (an unlit venue with no coordinates:
 * flagged, never treated as within daylight), and each locked row past sunset
 * with a proposed fix that nothing applies. This renders all three so none is
 * silently dropped.
 *
 * @module utils/daylightReport
 */

/** Entries named per kind before the rest are counted. */
const NAMED = 3;

/** Plain-language causes for the Edge's `SUNSET_UNKNOWN` entries. */
export const DAYLIGHT_UNKNOWN_CAUSE_TEXT = Object.freeze({
  'venue-coordinates-missing': 'the venue has no coordinates',
  'slot-venue-missing': 'the slot names no field',
  'slot-dates-unreadable': "the slot's dates could not be read",
  'sunset-undefined': 'there is no sunset at that latitude on some dates',
});

/**
 * @param {string[]} items
 * @returns {string}
 */
function listSome(items) {
  const named = items.slice(0, NAMED).join(', ');
  return items.length > NAMED ? `${named} and ${items.length - NAMED} more` : named;
}

/**
 * @param {number} n
 * @param {string} word
 * @returns {string}
 */
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * @param {number} minutes - minutes past local midnight
 * @returns {string} `HH:MM`
 */
const clock = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * @param {{
 *   pastSunset?: Array<{ teamId: string, date: string, endMinutes: number, limitMinutes: number }>,
 *   unknown?: Array<{ teamId: string, assignmentId?: string, cause: string }>,
 *   lockedPastSunset?: Array<{ teamId: string, date: string, proposedFix?: { effectiveUntil: string|null } }>,
 * }|null|undefined} daylight
 * @returns {string|null}
 */
export function describeDaylightReport(daylight) {
  if (!daylight) return null;
  const lines = [];

  const past = daylight.pastSunset ?? [];
  if (past.length > 0) {
    lines.push(
      `${count(past.length, 'new practice')} ` +
        `${past.length === 1 ? 'runs' : 'run'} past sunset on unlit ground and ` +
        `${past.length === 1 ? 'is' : 'are'} kept as placed, for you to decide: ` +
        listSome(
          past.map(
            (p) =>
              `team ${p.teamId} from ${p.date} (ends ${clock(p.endMinutes)}, ` +
              `the latest allowed is ${clock(p.limitMinutes)})`
          )
        )
    );
  }

  const unknown = daylight.unknown ?? [];
  if (unknown.length > 0) {
    /** @type {Map<string, number>} */
    const byCause = new Map();
    for (const entry of unknown) byCause.set(entry.cause, (byCause.get(entry.cause) ?? 0) + 1);
    lines.push(
      `Sunset was not checked for ${count(unknown.length, 'practice')} on unlit ground, so ` +
        `${unknown.length === 1 ? 'it is' : 'they are'} not known to end in daylight: ` +
        [...byCause.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([cause, n]) => `${n} because ${DAYLIGHT_UNKNOWN_CAUSE_TEXT[cause] ?? cause}`)
          .join(', ')
    );
  }

  const locked = daylight.lockedPastSunset ?? [];
  if (locked.length > 0) {
    lines.push(
      `${count(locked.length, 'assigned practice')} already run${locked.length === 1 ? 's' : ''} ` +
        'past sunset and stay unchanged (proposed, not applied): ' +
        listSome(
          locked.map(
            (l) =>
              `team ${l.teamId} from ${l.date}` +
              (l.proposedFix?.effectiveUntil
                ? `, end it ${l.proposedFix.effectiveUntil}`
                : l.proposedFix
                  ? ', make it all TIME TBD'
                  : '')
          )
        )
    );
  }

  return lines.length > 0 ? lines.join(' · ') : null;
}
