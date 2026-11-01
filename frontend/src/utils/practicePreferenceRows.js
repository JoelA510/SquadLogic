/**
 * One row of a practice preference file as a rule: the JavaScript twin of the parsing in
 * `finalize_practice_preference_import_job` (migration 20261112010000), which is the source of
 * truth. The mock client's finalizer and the import preview (Phase D C2) read a row through this,
 * so what the preview promises is what the database does.
 *
 * `tests/practicePreferenceRows.test.js` runs the same inputs `supabase/tests/practice_preference_import.sql`
 * does and holds this to the same answers. A row's columns are the canonical keys after the import's
 * header normalization (`importAllowlist.js` lists them): the first non-blank of each group is read.
 */

const WEEKDAY_BY_NAME = Object.freeze({
  mon: 'MON',
  monday: 'MON',
  tue: 'TUE',
  tues: 'TUE',
  tuesday: 'TUE',
  wed: 'WED',
  weds: 'WED',
  wednesday: 'WED',
  thu: 'THU',
  thur: 'THU',
  thurs: 'THU',
  thursday: 'THU',
  fri: 'FRI',
  friday: 'FRI',
  sat: 'SAT',
  saturday: 'SAT',
  sun: 'SUN',
  sunday: 'SUN',
});
const WEEK_ORDER = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** Separators of several days or times: , ; | / & "and" "or". */
const LIST_SPLIT = /\s*(?:;|,|\||\/|&|\sor\s|\sand\s)\s*/;

/** The first non-blank value among `keys`, trimmed, or null (SQL `import_payload_text`). */
export function payloadText(payload, ...keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text !== '') return text;
  }
  return null;
}

/** `5:00 PM`, `5pm`, `5:30 p.m.`, `17:00`: minutes past midnight, or null. */
export function parseStartMinutes(token) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(token.replace(/\./g, ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  const meridiem = match[3] ?? null;
  if (minute > 59) return null;
  if (meridiem === null ? hour > 23 : hour < 1 || hour > 12) return null;
  if (meridiem === 'am') return (hour % 12) * 60 + minute;
  if (meridiem === 'pm') return ((hour % 12) + 12) * 60 + minute;
  return hour * 60 + minute;
}

/** `YYYY-MM-DD` or `M/D/YYYY` as a real calendar date written `YYYY-MM-DD`, or null. */
export function parseDate(text) {
  let iso = null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) iso = text;
  else if (us) iso = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  if (iso === null) return null;
  const check = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Read one staged row.
 *
 * @param {Record<string, unknown>} payload - the row's normalized payload
 * @param {{ locations: Array<{ id: string, name: string }> }} context - the organization's locations
 * @returns {{ ok: true, rule: { email: string, team: string | null, requestedLevel: 'prefer' | 'must',
 *   weekdays: string[] | null, startMinutes: number[] | null, venueIds: string[] | null,
 *   effectiveFrom: string | null, effectiveTo: string | null, coachPriority: string | null } }
 *   | { ok: false, message: string }}
 */
export function parsePreferenceRow(payload, { locations }) {
  const email = payloadText(payload, 'email')?.toLowerCase() ?? null;
  const team = payloadText(payload, 'team_name', 'team name', 'team');
  const levelText = payloadText(payload, 'request_level')?.toLowerCase() ?? null;
  const days = payloadText(payload, 'weekdays', 'days', 'day');
  const times = payloadText(payload, 'start_times', 'start_time', 'start');
  const venues = payloadText(payload, 'venues', 'location');
  const fromText = payloadText(payload, 'effective_from', 'valid_from');
  const toText = payloadText(payload, 'effective_to', 'valid_until');
  const priorityText = payloadText(payload, 'coach_priority')?.toLowerCase() ?? null;

  let requestedLevel;
  if (levelText === null) requestedLevel = 'prefer';
  else if (/(must|required|mandatory)/.test(levelText)) requestedLevel = 'must';
  else if (/(prefer|nice|soft)/.test(levelText)) requestedLevel = 'prefer';
  else return { ok: false, message: 'Unknown request level: use prefer or must' };

  let coachPriority = null;
  if (priorityText !== null) {
    if (priorityText === 'high' || priorityText === 'low') coachPriority = priorityText;
    else if (priorityText === 'medium' || priorityText === 'med') coachPriority = 'medium';
    else return { ok: false, message: 'Unknown priority: use high, medium or low' };
  }

  let weekdays = null;
  if (days !== null) {
    const found = new Set();
    for (const token of days.toLowerCase().split(LIST_SPLIT).map((t) => t.trim())) {
      if (token === '') continue;
      const code = WEEKDAY_BY_NAME[token];
      if (!code) return { ok: false, message: 'Unknown day in the days column' };
      found.add(code);
    }
    weekdays = found.size === 0 ? null : WEEK_ORDER.filter((code) => found.has(code));
  }

  let startMinutes = null;
  if (times !== null) {
    const found = new Set();
    for (const token of times.toLowerCase().split(LIST_SPLIT).map((t) => t.trim())) {
      if (token === '') continue;
      const minutes = parseStartMinutes(token);
      if (minutes === null) {
        return { ok: false, message: 'Unreadable start time in the start times column' };
      }
      found.add(minutes);
    }
    startMinutes = found.size === 0 ? null : [...found].sort((a, b) => a - b);
  }

  let venueIds = null;
  if (venues !== null) {
    const byName = (name) =>
      locations.find((l) => String(l.name).trim().toLowerCase() === name.trim().toLowerCase());
    // A venue name may hold a comma or an ampersand, so the whole cell is tried as one name first.
    const whole = byName(venues);
    if (whole) venueIds = [String(whole.id)];
    else {
      const found = new Set();
      for (const token of venues.split(/\s*[;|]\s*/).map((t) => t.trim())) {
        if (token === '') continue;
        const location = byName(token);
        if (!location) {
          return { ok: false, message: 'Unknown venue: no location of this organization has that name' };
        }
        found.add(String(location.id));
      }
      venueIds = found.size === 0 ? null : [...found].sort();
    }
  }

  const effectiveFrom = fromText === null ? null : parseDate(fromText);
  const effectiveTo = toText === null ? null : parseDate(toText);
  if ((fromText !== null && effectiveFrom === null) || (toText !== null && effectiveTo === null)) {
    return { ok: false, message: 'Unreadable date in the effective from / until columns' };
  }
  if (effectiveFrom !== null && effectiveTo !== null && effectiveTo < effectiveFrom) {
    return { ok: false, message: 'The effective until date is before the effective from date' };
  }
  if (weekdays === null && startMinutes === null && venueIds === null) {
    return { ok: false, message: 'The row names no day, start time or venue' };
  }
  if (email === null) return { ok: false, message: 'The row has no coach email' };
  return {
    ok: true,
    rule: {
      email,
      team,
      requestedLevel,
      weekdays,
      startMinutes,
      venueIds,
      effectiveFrom,
      effectiveTo,
      coachPriority,
    },
  };
}
