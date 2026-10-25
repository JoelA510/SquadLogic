import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { Calendar } from 'lucide-react';
import { seasonCalendarDate } from '@squadlogic/core/timing/index.js';
import Badge from '../ui/Badge.jsx';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import ScheduleExports from '../ScheduleExports.jsx';
import {
  compareTeamEvents,
  fetchTeamEvents,
  PRACTICE_CHANGES_UNREAD_TEXT,
} from '../../hooks/useTeamPortal.js';
import { todayIso } from '../../utils/today.js';
import { logger } from '../../lib/logger.js';

/** How many dated events the home lists; the team pages hold the rest. */
export const COACH_SCHEDULE_LIMIT = 10;

/** A wall date as "Monday, November 2", read at local midnight (never UTC). */
const longDate = (date) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

/**
 * When an event is, as the team page says it: a TIME TBD with its reason, a
 * game not yet given a slot (no date), or the date and wall times.
 */
function whenOf(event) {
  if (event.timeTbd) {
    return event.date
      ? `Time TBD on ${longDate(event.date)}: ${event.reason}`
      : `Date and time TBD: ${event.reason}`;
  }
  if (!event.date) return 'Date and time not set yet';
  return `${longDate(event.date)}, ${event.startTime?.substring(0, 5)} - ${event.endTime?.substring(0, 5)}`;
}

/** Plain code-unit order, for the team-name tiebreak. */
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every team's events as one list: a game between two teams the coach coaches
 * comes back once per team, so it is kept once, named by both teams; then the
 * team page's order (`compareTeamEvents`), the team's name breaking a tie.
 *
 * @param {Array<Record<string, any>>} events
 */
export function mergeTeamEvents(events) {
  const games = new Map();
  const merged = [];
  for (const event of events) {
    if (event.type === 'game' && event.id != null) {
      const first = games.get(String(event.id));
      if (first) {
        first.teamName = null;
        first.description = `${first.homeTeam} vs ${first.awayTeam}`;
        continue;
      }
      const copy = { ...event };
      games.set(String(event.id), copy);
      merged.push(copy);
    } else {
      merged.push(event);
    }
  }
  return merged.sort(
    (a, b) => compareTeamEvents(a, b) || order(String(a.teamName ?? ''), String(b.teamName ?? ''))
  );
}

/**
 * The coach's own upcoming schedule, games and practices, across every team
 * they coach (plan docs/changes/2026-10-22-admin-focus.md, R6). Each team's
 * events come from `fetchTeamEvents`, the read the team page makes, on the
 * team's season clock; "upcoming" is from today in that clock (UTC when the
 * season has none).
 *
 * Nothing is dropped silently: an undated TIME TBD is always listed, with its
 * reason; dated events past the first `COACH_SCHEDULE_LIMIT` are counted, with
 * a link to each team's full schedule; and when a team's practice changes
 * could not be read, the card says so, as the team page does.
 *
 * @param {{ teams: Array<{ id: string, name: string, division?: any }> }} props
 */
export default function CoachScheduleCard({ teams }) {
  const [state, setState] = useState(
    /** @type {{ events: any[], unread: boolean, failed: string[], loaded: boolean }} */ ({
      events: [],
      unread: false,
      failed: [],
      loaded: false,
    })
  );
  const teamKey = teams.map((team) => team.id).join(',');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ events: [], unread: false, failed: [], loaded: false });
      // Team by team: one team's failed read takes only that team's events
      // away, and the card names the team.
      const perTeam = await Promise.allSettled(
        teams.map(async (team) => {
          const timeZone = team.division?.season?.timezone ?? null;
          const today = seasonCalendarDate(Date.now(), timeZone) ?? todayIso();
          const { events, practiceChangesUnread } = await fetchTeamEvents(team.id, timeZone);
          return {
            unread: practiceChangesUnread,
            events: events
              .filter((event) => event.date == null || event.date >= today)
              .map(
                (event) =>
                  /** @type {Record<string, any>} */ ({
                    ...event,
                    teamId: team.id,
                    teamName: team.name,
                  })
              ),
          };
        })
      );
      if (cancelled) return;
      const failed = [];
      const loaded = [];
      perTeam.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          loaded.push(result.value);
        } else {
          logger.error('[CoachScheduleCard] schedule load failed', {
            teamId: teams[index].id,
            message: result.reason?.message,
          });
          failed.push(teams[index].name);
        }
      });
      setState({
        events: mergeTeamEvents(loaded.flatMap((entry) => entry.events)),
        unread: loaded.some((entry) => entry.unread),
        failed,
        loaded: true,
      });
    })();
    return () => {
      cancelled = true;
    };
    // teamKey stands for `teams`: a new array of the same teams reads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamKey]);

  const dated = state.events.filter((event) => event.date != null);
  const undated = state.events.filter((event) => event.date == null);
  const shown = [...dated.slice(0, COACH_SCHEDULE_LIMIT), ...undated];
  const hidden = dated.length - Math.min(dated.length, COACH_SCHEDULE_LIMIT);

  return (
    <section className="card" aria-labelledby="coach-schedule-heading">
      <div className="card-head">
        <Calendar size={18} style={{ color: 'var(--primary)' }} aria-hidden="true" />
        <h3 id="coach-schedule-heading">Your schedule</h3>
      </div>
      <div className="card-body" aria-busy={!state.loaded}>
        {!state.loaded && <p className="muted">Loading your schedule…</p>}
        {state.failed.length > 0 && (
          <DataErrorBanner
            message={
              state.failed.length === teams.length
                ? 'Your schedule could not be loaded. Try again shortly.'
                : `The schedule of ${state.failed.join(', ')} could not be loaded. Try again shortly.`
            }
          />
        )}
        {state.unread && (
          <div
            role="alert"
            data-testid="coach-practice-changes-unread"
            className="bg-status-warning-bg text-text-primary border border-status-warning rounded-xl p-4 text-sm"
          >
            {PRACTICE_CHANGES_UNREAD_TEXT}
          </div>
        )}
        {state.loaded && state.failed.length === 0 && shown.length === 0 && (
          <p className="muted">No upcoming games or practices.</p>
        )}
        {shown.length > 0 && (
          <ul className="coach-schedule" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {shown.map((event) => (
              <li
                key={`${event.teamId}-${event.type}-${event.id}-${event.date}-${event.reasonCode ?? ''}-${event.exceptionId ?? ''}`}
                data-testid="coach-schedule-event"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '10px 0',
                  borderBottom: '1px solid var(--border-soft)',
                }}
              >
                <Badge tone={event.type === 'game' ? 'success' : 'info'}>
                  {event.type === 'game' ? 'Game' : 'Practice'}
                </Badge>
                <span style={{ fontWeight: 600 }}>
                  {event.teamName ? `${event.teamName}: ` : ''}
                  {event.description}
                </span>
                <span className="muted" style={{ fontSize: 13 }}>
                  {whenOf(event)}
                  {` · ${event.location ?? 'Location TBD'}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {hidden > 0 && (
          <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
            {hidden} more later in the season. Open a team for its full schedule:{' '}
            {teams.map((team, index) => (
              <React.Fragment key={team.id}>
                {index > 0 && ', '}
                <Link className="linklike" to={`/team/${team.id}`}>
                  {team.name}
                </Link>
              </React.Fragment>
            ))}
            .
          </p>
        )}
        {/* R7: every team's whole season, not only what is listed above. */}
        <div style={{ marginTop: 14 }}>
          <ScheduleExports
            teams={teams}
            fileName={teams.length === 1 ? teams[0].name || 'team' : 'My_teams'}
            label={
              teams.length === 1
                ? "Download your team's full season"
                : "Download your teams' full season"
            }
            idPrefix="coach"
          />
        </div>
      </div>
    </section>
  );
}

CoachScheduleCard.propTypes = {
  teams: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string,
      division: PropTypes.object,
    })
  ).isRequired,
};
