/**
 * The files a schedule export hands the browser: CSV, XLSX and the team
 * calendar (plan docs/changes/2026-10-22-admin-focus.md, R7).
 *
 * The XLSX writer (`write-excel-file`, decision 6) and the calendar renderer
 * are imported when a file is asked for, never with the page, so neither is
 * in a route's first paint.
 *
 * ## The calendar is the feed's own
 *
 * A downloaded `.ics` is rendered by the code that serves the subscribed feed
 * (`supabase/functions/_shared/calendar/icsFeed.ts`): `buildFeedEvents` places
 * every game and practice occurrence on the season's clock and turns what
 * cannot be placed into an all-day TIME TBD entry with its reason, and
 * `renderIcsCalendar` writes the VCALENDAR (UTC instants, CRLF, folded
 * lines, a CALDESC that counts what has no time). Only the rows differ: these
 * are the ones the caller's own session read for the team page
 * (`fetchTeamEvents`), under RLS, where the feed reads with the service role
 * behind a token. {@link feedRowsOf} renames the page's embeds to the feed's
 * and changes nothing else; a third generator is how two calendars of the
 * same team would come to disagree.
 *
 * @module utils/scheduleDownloads
 */

/** A name safe for a file, the feed's rule (`calendar-feed/index.ts`'s Content-Disposition). */
export const safeFileName = (name) => String(name ?? 'schedule').replace(/[^a-zA-Z0-9_-]/g, '_');

/** C0 control characters other than tab, LF and CR: not allowed in the sheet's XML. */
// eslint-disable-next-line no-control-regex -- the class is the point: these characters break XML 1.0
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * Hand a file to the browser as a download.
 *
 * @param {string} filename
 * @param {Blob} blob
 */
export function saveFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** @param {string} csv */
export const csvBlob = (csv) => new Blob([csv], { type: 'text/csv;charset=utf-8' });

/** @param {string} ics */
export const icsBlob = (ics) => new Blob([ics], { type: 'text/calendar;charset=utf-8' });

/**
 * The sheet's cells: a bold header row, then every value as **text**. An
 * identifier that looks like a number (a team named `007`, a date) stays as
 * written, and a blank cell is empty, never 0. A text cell is never a formula
 * in XLSX, so the CSV's formula guard has nothing to do here.
 *
 * @param {ReadonlyArray<string>} columns
 * @param {Array<Record<string, unknown>>} rows
 */
export function xlsxSheetData(columns, rows) {
  return [
    columns.map((header) => ({ value: header, fontWeight: 'bold' })),
    ...rows.map((row) =>
      columns.map((header) => {
        const value = row[header];
        if (value === null || value === undefined || value === '') return null;
        return { value: String(value).replace(XML_FORBIDDEN, ''), type: String };
      })
    ),
  ];
}

/**
 * The rows as an XLSX workbook of one sheet.
 *
 * @param {ReadonlyArray<string>} columns
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} [sheet]
 * @returns {Promise<Blob>}
 */
export async function xlsxBlob(columns, rows, sheet = 'Schedule') {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  return writeXlsxFile(/** @type {any} */ (xlsxSheetData(columns, rows)), {
    sheet,
    stickyRowsCount: 1,
    columns: columns.map((header) => ({ width: Math.max(12, Math.min(40, header.length + 4)) })),
  }).toBlob();
}

/** `field:fields(name, location:locations(name))` as the feed's `fields(name, locations(name))`. */
const feedFields = (field) =>
  field
    ? { name: field.name ?? null, locations: field.location ? { name: field.location.name } : null }
    : null;

/** A page slot embed (`field`) as the feed's (`fields`), every time column as read. */
const feedSlot = (slot) => (slot ? { ...slot, fields: feedFields(slot.field) } : null);

/**
 * `fetchTeamEvents`' rows in the shapes `buildFeedEvents` reads. Renames only.
 *
 * @param {{ games?: any[], practices?: any[], exceptions?: any[] }} rows
 */
export function feedRowsOf(rows) {
  return {
    games: (rows?.games ?? []).map((g) => ({ id: g.id, game_slots: feedSlot(g.game_slot) })),
    practices: (rows?.practices ?? []).map((p) => ({
      id: p.id,
      effective_date_range: p.effective_date_range,
      practice_slots: feedSlot(p.slot),
    })),
    exceptions: (rows?.exceptions ?? []).map((x) => ({ ...x, slot: feedSlot(x.slot) })),
  };
}

/**
 * One team's calendar, as the feed renders it.
 *
 * @param {{ teamName: string, orgName: string, timeZone: string | null,
 *   rows: { games?: any[], practices?: any[], exceptions?: any[] },
 *   practiceChangesUnread?: boolean, now?: Date }} input
 * @returns {Promise<string>}
 */
export async function teamCalendarIcs({
  teamName,
  orgName,
  timeZone,
  rows,
  practiceChangesUnread = false,
  now,
}) {
  const { buildFeedEvents, renderIcsCalendar, PRACTICE_CHANGES_READ } =
    await import('../../../supabase/functions/_shared/calendar/icsFeed.ts');
  const feed = feedRowsOf(rows);
  const events = buildFeedEvents({
    teamName,
    timezone: timeZone ?? null,
    games: feed.games,
    practices: feed.practices,
    exceptions: feed.exceptions,
  });
  return renderIcsCalendar({
    orgName,
    teamName,
    timezone: timeZone ?? null,
    events,
    // The page's read said its practice changes are unread: the calendar says so too.
    readFailures: practiceChangesUnread ? [PRACTICE_CHANGES_READ] : [],
    now,
  });
}
