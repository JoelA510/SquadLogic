import React, { useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Badge from '../ui/Badge.jsx';
import Button from '../ui/Button.jsx';
import ScrollRegion, { Cell } from './ScrollRegion.jsx';
import {
  buildCoachDirectory,
  buildCoachSchedule,
  coachScheduleCsv,
} from '@squadlogic/core/reports/coachSchedule.js';
import { csvBlob, saveFile } from '../../utils/scheduleDownloads.js';
import { todayIso } from '../../utils/today.js';

const plural = (n, one, many) => (n === 1 ? one : many);
const slug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * A coach's schedule (tasks G2 and G2b): their games and practices across all their teams, head and assistant, a
 * clash column, and a CSV. A coach is marked as being on more than one team by counting the teams on the team list,
 * not from the flag the Coaches page shows. Names only.
 */
export default function CoachScheduleView({ games, reference, timeZone }) {
  const selectId = useId();
  const [coachId, setCoachId] = useState('');
  // The teams a coach has today: an assignment that ended is not a team of theirs.
  const asOf = useMemo(() => todayIso(), []);

  const directory = useMemo(
    () =>
      buildCoachDirectory({
        coaches: reference.coaches,
        teams: reference.teams,
        assignments: reference.assignments,
        asOf,
      }),
    [reference, asOf]
  );
  const multi = directory.coaches.filter((coach) => coach.multiTeam).length;

  const schedule = useMemo(
    () =>
      coachId
        ? buildCoachSchedule({
            coachId,
            coaches: reference.coaches,
            teams: reference.teams,
            assignments: reference.assignments,
            asOf,
            games,
            tbdGames: reference.tbdGames,
            practices: reference.practices,
            fields: reference.fields,
            venues: reference.venues,
            timeZone,
          })
        : null,
    [coachId, reference, asOf, games, timeZone]
  );

  const download = () => {
    if (schedule)
      saveFile(
        `coach-schedule-${slug(schedule.coach.name)}.csv`,
        csvBlob(coachScheduleCsv(schedule))
      );
  };

  return (
    <div data-testid="coach-schedule">
      <div className="flex flex-wrap items-end gap-3">
        <div className="field">
          <label htmlFor={selectId}>Coach</label>
          <select
            id={selectId}
            className="select"
            value={coachId}
            onChange={(event) => setCoachId(event.target.value)}
          >
            <option value="">Choose a coach</option>
            {directory.coaches.map((coach) => (
              <option key={coach.id} value={coach.id}>
                {`${coach.name} (${coach.teamCount} ${plural(coach.teamCount, 'team', 'teams')})`}
              </option>
            ))}
          </select>
        </div>
        {schedule && (
          <Button variant="secondary" onClick={download}>
            {`Download ${schedule.coach.name} schedule (CSV)`}
          </Button>
        )}
      </div>
      <p className="mt-2 text-xs text-text-muted" data-testid="coach-multi-count">
        {`${multi} of ${directory.coaches.length} ${plural(directory.coaches.length, 'coach is', 'coaches are')} on more than one team, counted from the team list (head and assistant), not from the flag on the Coaches page.`}
      </p>
      {(directory.unknownCoachIds.length > 0 || directory.unknownTeamIds.length > 0) && (
        <p
          className="mt-1 text-xs text-status-error-text"
          role="status"
          data-testid="coach-unknown"
        >
          {`Some coaching assignments name ${directory.unknownCoachIds.length} ${plural(directory.unknownCoachIds.length, 'coach', 'coaches')} and ${directory.unknownTeamIds.length} ${plural(directory.unknownTeamIds.length, 'team', 'teams')} that are not on this season's lists. They are not counted.`}
        </p>
      )}

      {schedule && (
        <section className="mt-3" aria-label={`Schedule of ${schedule.coach.name}`}>
          <h3 className="text-sm font-medium text-text-primary">
            {schedule.coach.name}{' '}
            {schedule.multiTeam && (
              <Badge tone="info" data-testid="coach-marker">
                On more than one team
              </Badge>
            )}
          </h3>
          {schedule.teams.length > 0 && (
            <p className="text-sm text-text-primary">
              {`Teams: ${schedule.teams.map((team) => `${team.name} (${team.roles.map((role) => (role === 'lead' ? 'head' : role)).join(', ')})`).join('; ')}.`}
            </p>
          )}
          <ul className="mt-1 text-xs text-text-muted list-disc pl-5" data-testid="coach-notes">
            {schedule.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          {schedule.rows.length > 0 && (
            <ScrollRegion label={`Games and practices of ${schedule.coach.name}`}>
              <table className="grid grid-prose" data-testid="coach-schedule-table">
                <caption className="sr-only">{`Games and practices of ${schedule.coach.name}`}</caption>
                <thead>
                  <tr>
                    <th scope="col">Team</th>
                    <th scope="col">Event</th>
                    <th scope="col">Against</th>
                    <th scope="col">When</th>
                    <th scope="col">Where</th>
                    <th scope="col">Status</th>
                    <th scope="col">Coach clash</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.rows.map((row, index) => (
                    <tr key={index}>
                      <Cell>{row.Team}</Cell>
                      <Cell>{row['Event Type']}</Cell>
                      <Cell>
                        {[row.Opponent, row['Home/Away'] && `(${row['Home/Away']})`]
                          .filter(Boolean)
                          .join(' ')}
                      </Cell>
                      <Cell>
                        <WhenLines row={row} />
                      </Cell>
                      <Cell>{row.Location}</Cell>
                      <Cell>{[row.Status, row.Reason].filter(Boolean).join(': ')}</Cell>
                      <Cell>{row['Coach Clash']}</Cell>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          )}
        </section>
      )}
    </div>
  );
}

/** When a row is, one line each: a game's day and date, or a practice's weekday; then the time; then a series' dates. */
function WhenLines({ row }) {
  const time = row.Start ? `${row.Start} to ${row.End}` : '';
  const lines =
    row['Event Type'] === 'Practice'
      ? [row.Day && `${row.Day}s`, time, row.Dates && `(${row.Dates})`]
      : [[row.Day, row.Date].filter(Boolean).join(' '), time];
  return lines.filter(Boolean).map((line) => (
    <div key={line} className="whitespace-nowrap">
      {line}
    </div>
  ));
}

WhenLines.propTypes = { row: PropTypes.object.isRequired };

CoachScheduleView.propTypes = {
  games: PropTypes.array.isRequired,
  reference: PropTypes.object.isRequired,
  timeZone: PropTypes.string.isRequired,
};
