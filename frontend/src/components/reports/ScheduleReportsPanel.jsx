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
  const [state, setState] = useState(/** @type {any} */ ({ key: null }));
  const key =
    organizationId && seasonSettingsId ? `${organizationId}|${seasonSettingsId}|${attempt}` : null;

  useEffect(() => {
    if (!key) return undefined;
    let current = true;
    loadReportsReference(supabaseClient, { organizationId, seasonSettingsId }).then(
      (result) => {
        if (!current) return;
        if (result.ok === true) setState({ key, status: 'ready', data: result.data });
        else {
          logger.error(`[reports] ${result.table}: ${result.message}`);
          setState({ key, status: 'error', table: result.table, message: result.message });
        }
      },
      (err) => {
        // `loadReportsReference` answers instead of throwing; this is a bug in it, said rather than swallowed.
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
  }, [key, supabaseClient, organizationId, seasonSettingsId]);

  const reference = state.key === key ? state : { key, status: 'loading' };
  const games = useMemo(() => gameAssignments ?? [], [gameAssignments]);

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
  } else if (!gameRunId) {
    body = (
      <p className="text-sm text-text-primary" data-testid="reports-no-schedule">
        No game schedule is saved yet, so there is nothing to report on. Generate and apply a game
        schedule first.
      </p>
    );
  } else if (reference.status === 'loading') {
    body = <NotChecked>the venues, teams, coaches and practices are being read.</NotChecked>;
  } else if (reference.status === 'error') {
    body = (
      <div>
        <p role="alert" className="text-sm text-status-error-text" data-testid="reports-read-error">
          {`${reference.table} could not be read (${reference.message}). No report is drawn: a report over part of the league could say a game is missing when it is not.`}
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Read again
        </Button>
      </div>
    );
  } else {
    const view = {
      games,
      reference: reference.data,
      timeZone,
      organizationId,
      supabaseClient,
      tbd: reference.data.tbdGames,
    };
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
          {tab === 'day' && <DaySheetView {...view} />}
          {tab === 'coach' && <CoachScheduleView {...view} />}
          {tab === 'changes' && <ChangesView {...view} />}
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

ScheduleReportsPanel.propTypes = {
  gameAssignments: PropTypes.array.isRequired,
  gameRunId: PropTypes.string,
  sourceErrors: PropTypes.object,
  sourceLoading: PropTypes.object,
  supabaseClient: PropTypes.object.isRequired,
};
