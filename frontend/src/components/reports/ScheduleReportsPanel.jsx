import React, { useEffect, useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Tabs from '../ui/Tabs.jsx';
import Button from '../ui/Button.jsx';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { logger } from '../../lib/logger.js';
import { loadReportsReference } from '../../utils/scheduleReportsRead.js';
import DaySheetView from './DaySheetView.jsx';
import CoachScheduleView from './CoachScheduleView.jsx';
import ChangesView from './ChangesView.jsx';

const LEAGUE_GROUP = /** @type {Array<'league'>} */ (['league']);
const COACHES_GROUP = /** @type {Array<'coaches'>} */ (['coaches']);

/**
 * Reports on the Exports page (PR 7 of the schedule expansion, plan `docs/changes/2026-11-03-schedule-expansion.md`,
 * 5.1 and 5.6): the Day Sheet, a coach's schedule and "Changes since publication". Read-only views and CSV files over
 * the saved schedule; admin only (the Exports route is); names, never contacts.
 *
 * ## What it will not do (lessons 90 and 93)
 *
 * - **Say "no games" before the games arrive.** While the saved games are being read, or the league's tables are, it
 *   says "Not checked yet".
 * - **Draw a report over a partial read.** A table that fails to read (as an error or as a rejected request) is
 *   named, and nothing is drawn: the saved games failing is named too.
 * - **Guess a clock.** A season with no time zone has no date or time that can be read, and says so.
 *
 * - **Block a report for a read it does not use.** The coach schedule needs no game run (it lists practices, the
 *   marker and the practice clash, and says there are no games); the Day Sheet and Changes need one. A failure of the
 *   saved games' own read still blocks all three, the coach schedule too: a coach report over a failed games read
 *   would hide games. The coaches, their assignments and the practices are read apart, so a failure there blocks the
 *   coach schedule only.
 *
 * The saved games are the Exports page's own (`useDashboardData`: the latest run, paged), so the Day Sheet and the
 * master export read one set of rows. The rest is read here, once, by `loadReportsReference`.
 *
 * @param {Object} props
 * @param {Array<Record<string, any>>} props.gameAssignments - the saved games, camelCase rows of the latest run
 * @param {string | null} [props.gameRunId] - the latest game run, or none when no schedule is saved
 * @param {{ team?: string | null, practice?: string | null, game?: string | null }} [props.sourceErrors]
 * @param {{ team?: boolean, practice?: boolean, game?: boolean }} [props.sourceLoading]
 * @param {any} props.supabaseClient
 */
export default function ScheduleReportsPanel({
  gameAssignments,
  gameRunId = null,
  sourceErrors = {},
  sourceLoading = {},
  supabaseClient,
}) {
  const { currentOrganization, currentSeasonSetting } = useOrganization() || {};
  const organizationId = currentOrganization?.id ?? null;
  const seasonSettingsId = currentSeasonSetting?.id ?? null;
  const timeZone = currentSeasonSetting?.timezone ?? null;
  const headingId = useId();
  const panelId = useId();
  const [tab, setTab] = useState('day');
  const [attempt, setAttempt] = useState(0);
  const key =
    organizationId && seasonSettingsId ? `${organizationId}|${seasonSettingsId}|${attempt}` : null;
  // Two reads, so a report is not blocked by a read it does not use: the league is every report's, the coaches group
  // (coaches, their assignments, the practices) is the coach schedule's alone.
  const league = useReference(LEAGUE_GROUP, {
    key,
    supabaseClient,
    organizationId,
    seasonSettingsId,
  });
  const coaches = useReference(COACHES_GROUP, {
    key,
    supabaseClient,
    organizationId,
    seasonSettingsId,
  });
  const games = useMemo(() => gameAssignments ?? [], [gameAssignments]);
  const noRun = !gameRunId;
  // The coach schedule's inputs, one object while the reads stand, so its view does not recompute (and read the practice
  // changes again) on every render of this panel.
  const coachReference = useMemo(
    () =>
      league.status === 'ready' && coaches.status === 'ready'
        ? {
            ...league.data,
            coaches: coaches.data.coaches,
            assignments: coaches.data.assignments,
            practices: coaches.data.practices,
            // The TIME TBD list is written by a game save: with no game run there is no schedule for a game to be
            // unplaced from, so none is listed (the line above the table says there are no games).
            tbdGames: noRun ? [] : league.data.tbdGames,
          }
        : null,
    [league, coaches, noRun]
  );

  const tabs = [
    { id: 'day', label: 'Day Sheet' },
    { id: 'coach', label: 'Coach schedule' },
    { id: 'changes', label: 'Changes since publication' },
  ];

  let body;
  if (!organizationId || !seasonSettingsId) {
    body = <NotChecked>no season is selected.</NotChecked>;
  } else if (sourceLoading.game) {
    body = <NotChecked>the saved games are being read.</NotChecked>;
  } else if (sourceErrors.game) {
    body = (
      <p role="alert" className="text-sm text-status-error-text" data-testid="reports-source-error">
        {`The saved games could not be read (${sourceErrors.game}), so no report is drawn. Reload the page to read again.`}
      </p>
    );
  } else if (!timeZone) {
    body = (
      <p role="alert" className="text-sm text-status-error-text" data-testid="reports-no-zone">
        The season has no time zone, so the date and time of a game cannot be read and no report is
        drawn. Set the time zone in the season settings.
      </p>
    );
  } else if (league.status === 'loading') {
    body = <NotChecked>the venues, teams and slots are being read.</NotChecked>;
  } else if (league.status === 'error') {
    body = (
      <ReadError
        reference={league}
        onRetry={() => setAttempt((n) => n + 1)}
        effect="No report is drawn: a report over part of the league could say a game is missing when it is not."
      />
    );
  } else {
    const view = { games, reference: league.data, timeZone, organizationId, supabaseClient };
    body = (
      <>
        <Tabs
          tabs={tabs}
          activeTab={tab}
          onChange={setTab}
          panelId={panelId}
          label="Schedule reports"
          className="mt-2"
        />
        <div id={panelId} role="tabpanel" className="mt-3">
          {tab === 'day' && (noRun ? <NoSchedule /> : <DaySheetView {...view} />)}
          {tab === 'changes' && (noRun ? <NoSchedule /> : <ChangesView {...view} />)}
          {tab === 'coach' &&
            (coaches.status === 'loading' ? (
              <NotChecked>the coaches, their teams and the practices are being read.</NotChecked>
            ) : coaches.status === 'error' ? (
              <ReadError
                reference={coaches}
                onRetry={() => setAttempt((n) => n + 1)}
                effect="The coach schedule is not drawn: a schedule over part of a coach's teams or practices could leave one out."
              />
            ) : (
              <CoachScheduleView {...view} reference={coachReference} noGameRun={noRun} />
            ))}
        </div>
      </>
    );
  }

  return (
    <section
      className="section-panel glass-panel mt-6"
      aria-labelledby={headingId}
      data-testid="schedule-reports"
    >
      <header className="section-header">
        <h2 id={headingId}>Schedule reports</h2>
      </header>
      <p className="text-sm text-text-muted">
        Read-only views of the saved game schedule, each with a CSV file. Names only: no email or
        phone number is read or shown.
      </p>
      {body}
    </section>
  );
}

/** A view whose inputs have not arrived says so, and draws no row and no "none" (lesson 93). */
function NotChecked({ children }) {
  return (
    <p className="text-sm text-text-muted mt-2" role="status" data-testid="reports-not-checked">
      <strong>Not checked yet:</strong> {children}
    </p>
  );
}

NotChecked.propTypes = { children: PropTypes.node.isRequired };

/** Said on the Day Sheet and on Changes when there is no game run: they have nothing to report on. */
function NoSchedule() {
  return (
    <p className="text-sm text-text-primary" data-testid="reports-no-schedule">
      No game schedule is saved yet, so there is nothing to report on. Generate and apply a game
      schedule first.
    </p>
  );
}

/** A read that failed: the table named, what is not drawn because of it, and a way to read again. */
function ReadError({ reference, onRetry, effect }) {
  return (
    <div>
      <p role="alert" className="text-sm text-status-error-text" data-testid="reports-read-error">
        {`${reference.table} could not be read (${reference.message}). ${effect}`}
      </p>
      <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
        Read again
      </Button>
    </div>
  );
}

ReadError.propTypes = {
  reference: PropTypes.object.isRequired,
  onRetry: PropTypes.func.isRequired,
  effect: PropTypes.string.isRequired,
};

/**
 * One group of the reports' reads, keyed by the season it was read for: an answer for another key is never served.
 * `loadReportsReference` answers instead of throwing; a rejection here is a bug in it, said rather than swallowed.
 */
function useReference(groups, { key, supabaseClient, organizationId, seasonSettingsId }) {
  const [state, setState] = useState(/** @type {any} */ ({ key: null }));
  useEffect(() => {
    if (!key) return undefined;
    let current = true;
    loadReportsReference(supabaseClient, { organizationId, seasonSettingsId }, { groups }).then(
      (result) => {
        if (!current) return;
        if (result.ok === true) setState({ key, status: 'ready', data: result.data });
        else {
          logger.error(`[reports] ${result.table}: ${result.message}`);
          setState({ key, status: 'error', table: result.table, message: result.message });
        }
      },
      (err) => {
        if (!current) return;
        logger.error('[reports] the read threw:', err);
        setState({
          key,
          status: 'error',
          table: 'the league',
          message: String(err?.message ?? err),
        });
      }
    );
    return () => {
      current = false;
    };
  }, [key, supabaseClient, organizationId, seasonSettingsId, groups]);
  return state.key === key ? state : { key, status: 'loading' };
}

ScheduleReportsPanel.propTypes = {
  gameAssignments: PropTypes.array.isRequired,
  gameRunId: PropTypes.string,
  sourceErrors: PropTypes.object,
  sourceLoading: PropTypes.object,
  supabaseClient: PropTypes.object.isRequired,
};
