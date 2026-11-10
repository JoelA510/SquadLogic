import React, { useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import ScrollRegion, { Cell } from './ScrollRegion.jsx';
import { buildDaySheet, daySheetCsv } from '@squadlogic/core/reports/daySheet.js';
import { wallOfInstant, weekdayOfDate } from '@squadlogic/core/reports/wall.js';
import { csvBlob, saveFile } from '../../utils/scheduleDownloads.js';
import { todayIso } from '../../utils/today.js';

/** A file-name part from a display name. @param {string} name */
const slug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * The Day Sheet (task G1): a date, an optional venue, one row per saved game; the TIME TBD games apart; a CSV.
 *
 * The venue is chosen by its id. Two venues can share a display name, so a name that repeats is told apart by its
 * fields in the list.
 */
export default function DaySheetView({ games, reference, timeZone }) {
  const dateId = useId();
  const venueId = useId();
  const [chosenDate, setChosenDate] = useState(/** @type {string | null} */ (null));
  const [venue, setVenue] = useState('');

  // The date a person most likely wants: the next game day on or after today, else the last one there is.
  const defaultDate = useMemo(() => {
    const days = [
      ...new Set(games.map((game) => wallOfInstant(game.start, timeZone)?.date).filter(Boolean)),
    ].sort();
    const today = todayIso();
    return days.find((day) => day >= today) ?? days[days.length - 1] ?? '';
  }, [games, timeZone]);
  const date = chosenDate ?? defaultDate;
  const dateOk = weekdayOfDate(date) !== null;

  const venueOptions = useMemo(() => {
    const fieldsOf = (id) => reference.fields.filter((f) => f.venueId === id).map((f) => f.name);
    const repeated = new Set();
    const seen = new Set();
    for (const v of reference.venues) {
      if (seen.has(v.name)) repeated.add(v.name);
      seen.add(v.name);
    }
    return reference.venues
      .map((v) => ({
        id: v.id,
        label: repeated.has(v.name)
          ? `${v.name} (${fieldsOf(v.id).sort().join(', ') || 'no fields'})`
          : v.name,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [reference.venues, reference.fields]);
  const venueLabel = venueOptions.find((option) => option.id === venue)?.label ?? '';

  // With no date chosen the sheet holds no dated game, but the TIME TBD games and the games with no readable time are
  // still listed: they belong to no date.
  const sheet = useMemo(
    () =>
      buildDaySheet({
        games,
        teams: reference.teams,
        fields: reference.fields,
        venues: reference.venues,
        tbdGames: reference.tbdGames,
        timeZone,
        date: dateOk ? date : null,
        venueId: venue || null,
      }),
    [dateOk, games, reference, timeZone, date, venue]
  );

  const download = () => {
    if (!dateOk) return;
    const name = `day-sheet-${date}${venue ? `-${slug(venueLabel)}` : ''}.csv`;
    saveFile(name, csvBlob(daySheetCsv(sheet)));
  };

  const where = venue ? `at ${venueLabel}` : 'at all venues';
  const elsewhere = sheet.counts.onDate - sheet.counts.shown;

  return (
    <div data-testid="day-sheet">
      <div className="flex flex-wrap items-end gap-3">
        <div className="field">
          <label htmlFor={dateId}>Date</label>
          <input
            id={dateId}
            type="date"
            className="input"
            value={date}
            onChange={(event) => setChosenDate(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={venueId}>Venue</label>
          <select
            id={venueId}
            className="select"
            value={venue}
            onChange={(event) => setVenue(event.target.value)}
          >
            <option value="">All venues</option>
            {venueOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <Button variant="secondary" disabled={!dateOk} onClick={download}>
          Download Day Sheet (CSV)
        </Button>
      </div>

      {!dateOk && (
        <p className="mt-3 text-sm text-text-muted" data-testid="day-sheet-choose">
          Choose a date.
        </p>
      )}

      {dateOk && (
        <p className="mt-3 text-sm text-text-primary" role="status" data-testid="day-sheet-summary">
          {`${weekdayOfDate(date)?.long} ${date}, ${where}: ${sheet.counts.shown} ${plural(sheet.counts.shown, 'game', 'games')}.`}
          {venue && elsewhere > 0
            ? ` ${elsewhere} ${plural(elsewhere, 'game', 'games')} on this date ${plural(elsewhere, 'is', 'are')} at another venue.`
            : ''}
          {venue && sheet.counts.unknownGround > 0
            ? ` ${sheet.counts.unknownGround} ${plural(sheet.counts.unknownGround, 'game is', 'games are')} at a field with no known venue, so no venue shows ${plural(sheet.counts.unknownGround, 'it', 'them')}.`
            : ''}
        </p>
      )}

      {dateOk && sheet.rows.length > 0 && (
        <ScrollRegion label={`Games on ${date} ${where}`}>
          <table className="grid grid-prose" data-testid="day-sheet-table">
            <caption className="sr-only">{`Games on ${date} ${where}`}</caption>
            <thead>
              <tr>
                {sheet.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, index) => (
                <tr key={sheet.gameIds[index] ?? index}>
                  {sheet.columns.map((column) => (
                    <Cell key={column}>{row[column]}</Cell>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {dateOk && sheet.rows.length === 0 && (
        <p className="mt-2 text-sm text-text-primary" data-testid="day-sheet-empty">
          {`No games are saved for ${date} ${venue ? `at ${venueLabel}` : 'at any venue'}.`}
        </p>
      )}

      {sheet.tbd.length > 0 && (
        <section className="mt-4" aria-labelledby={`${dateId}-tbd`} data-testid="day-sheet-tbd">
          <h3 id={`${dateId}-tbd`} className="text-sm font-medium text-text-primary">
            {`TIME TBD games (${sheet.tbd.length})`}
          </h3>
          <p className="text-xs text-text-muted">
            A game with no date yet is listed whatever date and venue you choose. A game that has a
            date and no time is listed on its date only. They are in the file after the games of the
            date.
          </p>
          <ul className="text-sm mt-1">
            {sheet.tbd.map((row, index) => (
              <li key={`${row.Home}-${row.Away}-${index}`}>
                {`${row.Division ? `${row.Division}: ` : ''}${row.Home} v ${row.Away}. ${
                  row.Date ? `${row.Date}, no time yet. ` : ''
                }${row.Status}`}
              </li>
            ))}
          </ul>
        </section>
      )}

      {sheet.unreadable.length > 0 && (
        <section className="mt-4" data-testid="day-sheet-unreadable">
          <p className="text-sm text-status-error-text" role="alert">
            {`${sheet.unreadable.length} saved ${plural(sheet.unreadable.length, 'game has', 'games have')} no start or end time that can be read, so ${plural(sheet.unreadable.length, 'it is', 'they are')} on no date: ${sheet.unreadable.map((u) => `${u.home} v ${u.away}`).join('; ')}.`}
          </p>
        </section>
      )}
    </div>
  );
}

DaySheetView.propTypes = {
  games: PropTypes.array.isRequired,
  reference: PropTypes.object.isRequired,
  timeZone: PropTypes.string.isRequired,
};
