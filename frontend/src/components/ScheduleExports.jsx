import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { CalendarPlus, FileSpreadsheet, FileText } from 'lucide-react';
import {
  TEAM_SCHEDULE_COLUMNS,
  TEAM_SCHEDULE_HEADERS,
  TEAM_SCHEDULE_STATUS,
  teamScheduleCsv,
  teamScheduleRows,
} from '@squadlogic/core/teamScheduleExport.js';
import Button from './ui/Button.jsx';
import { fetchTeamEvents } from '../hooks/useTeamPortal.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import {
  csvBlob,
  icsBlob,
  safeFileName,
  saveFile,
  teamCalendarIcs,
  xlsxBlob,
} from '../utils/scheduleDownloads.js';
import { logger } from '../lib/logger.js';

/** "A", "A and B", "A, B and C". */
function listOf(names) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Read every team's schedule through the team page's own read, team by team.
 * Any team that fails fails the file: an export missing a team's events would
 * read as that team having none.
 *
 * @param {Array<{ id: string, name: string, division?: any }>} teams
 */
async function readSchedules(teams) {
  const results = await Promise.allSettled(
    teams.map((team) => fetchTeamEvents(team.id, team.division?.season?.timezone ?? null))
  );
  const failed = [];
  const schedules = [];
  results.forEach((result, index) => {
    const team = teams[index];
    if (result.status === 'rejected') {
      logger.error('[ScheduleExports] schedule read failed', {
        teamId: team.id,
        message: result.reason?.message,
      });
      failed.push(team.name);
      return;
    }
    schedules.push({
      team,
      timeZone: team.division?.season?.timezone ?? null,
      events: result.value.events,
      rows: result.value.rows,
      practiceChangesUnread: result.value.practiceChangesUnread,
    });
  });
  return { failed, schedules };
}

const UNREAD_NOTE = (names) =>
  ` Practice changes for ${listOf(names)} could not be read, so their practices are shown as the usual weekly series.`;

/**
 * The schedule downloads for one or more teams (plan
 * docs/changes/2026-10-22-admin-focus.md, R7): CSV and XLSX of every event of
 * every team given, and each team's calendar (`.ics`).
 *
 * **What it reads.** Each team's schedule through `fetchTeamEvents`, the read
 * the team page and the coach home make, under the caller's own session, so
 * the database's row policies decide what comes back; this component only
 * offers the buttons. The files carry the whole season, not only what is
 * upcoming, and every event the page shows, including a TIME TBD practice and
 * a game with no slot, each with its status and reason
 * (`@squadlogic/core/teamScheduleExport.js`). No file carries a contact
 * column.
 *
 * **Nothing partial goes out silently.** A team whose schedule cannot be read
 * makes no file at all, and says which team; unread practice changes are said
 * beside the download (and in the calendar's description, as the feed says
 * them).
 *
 * Buttons stay focusable while a file is being made (`aria-disabled`), so
 * focus is not lost from under a keyboard user; the status line is polite.
 *
 * @param {{ teams: Array<{ id: string, name: string, division?: any }>, fileName: string,
 *   label?: string, idPrefix: string }} props
 */
export default function ScheduleExports({
  teams,
  fileName,
  label = 'Download schedule',
  idPrefix,
}) {
  const { currentOrganization } = useOrganization() || {};
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    /** @type {{ tone: 'ok' | 'error', text: string } | null} */ (null)
  );
  const labelId = `${idPrefix}-schedule-exports-label`;
  const statusId = `${idPrefix}-schedule-exports-status`;

  const run = async (work) => {
    if (busy || teams.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await work());
    } catch (err) {
      logger.error('[ScheduleExports] export failed', { message: err?.message });
      setMessage({
        tone: 'error',
        text: `No file was made: ${err?.message || 'the export failed'}.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const downloadTable = (format) =>
    run(async () => {
      const { failed, schedules } = await readSchedules(teams);
      if (failed.length > 0) {
        return {
          tone: 'error',
          text: `No file was made: the schedule of ${listOf(failed)} could not be read. Try again shortly.`,
        };
      }
      const rows = teamScheduleRows(schedules);
      const stem = `${safeFileName(fileName)}_Schedule`;
      if (format === 'xlsx') {
        saveFile(`${stem}.xlsx`, await xlsxBlob(TEAM_SCHEDULE_COLUMNS, rows));
      } else {
        saveFile(`${stem}.csv`, csvBlob(teamScheduleCsv(rows)));
      }
      const untimed = rows.filter(
        (row) =>
          row[TEAM_SCHEDULE_HEADERS.STATUS] === TEAM_SCHEDULE_STATUS.TIME_TBD ||
          row[TEAM_SCHEDULE_HEADERS.STATUS] === TEAM_SCHEDULE_STATUS.DATE_TBD
      ).length;
      const unread = schedules.filter((s) => s.practiceChangesUnread).map((s) => s.team.name);
      return {
        tone: 'ok',
        text:
          `Downloaded ${rows.length} event(s)` +
          (untimed > 0 ? `, ${untimed} with no confirmed time (each with its reason).` : '.') +
          (unread.length > 0 ? UNREAD_NOTE(unread) : ''),
      };
    });

  const downloadCalendar = (team) =>
    run(async () => {
      const { failed, schedules } = await readSchedules([team]);
      if (failed.length > 0) {
        return {
          tone: 'error',
          text: `No calendar was made: the schedule of ${team.name} could not be read. Try again shortly.`,
        };
      }
      const [schedule] = schedules;
      const ics = await teamCalendarIcs({
        teamName: team.name,
        orgName: currentOrganization?.name || 'SquadLogic',
        timeZone: schedule.timeZone,
        rows: schedule.rows,
        practiceChangesUnread: schedule.practiceChangesUnread,
      });
      saveFile(`${safeFileName(team.name)}_Schedule.ics`, icsBlob(ics));
      return {
        tone: 'ok',
        text:
          `Downloaded the calendar of ${team.name}.` +
          (schedule.practiceChangesUnread ? UNREAD_NOTE([team.name]) : ''),
      };
    });

  const describedBy = message ? statusId : undefined;
  const guard = busy || undefined;

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-busy={busy}
      data-testid={`${idPrefix}-schedule-exports`}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span id={labelId} className="muted" style={{ fontSize: 13 }}>
          {label}
        </span>
        <Button
          variant="secondary"
          size="sm"
          icon={FileText}
          onClick={() => downloadTable('csv')}
          aria-disabled={guard}
          aria-describedby={describedBy}
          data-testid={`${idPrefix}-export-csv`}
        >
          CSV
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={FileSpreadsheet}
          onClick={() => downloadTable('xlsx')}
          aria-disabled={guard}
          aria-describedby={describedBy}
          data-testid={`${idPrefix}-export-xlsx`}
        >
          Excel (.xlsx)
        </Button>
        {teams.map((team) => (
          <Button
            key={team.id}
            variant="secondary"
            size="sm"
            icon={CalendarPlus}
            onClick={() => downloadCalendar(team)}
            aria-disabled={guard}
            aria-describedby={describedBy}
            data-testid={`${idPrefix}-export-ics-${team.id}`}
          >
            {teams.length > 1 ? `Calendar (.ics): ${team.name}` : 'Calendar (.ics)'}
          </Button>
        ))}
      </div>
      <p
        id={statusId}
        role="status"
        data-testid={`${idPrefix}-schedule-exports-status`}
        className={message?.tone === 'error' ? 'text-status-error-text' : 'text-text-secondary'}
        style={{ fontSize: 13, margin: 0 }}
      >
        {busy ? 'Preparing the file…' : (message?.text ?? '')}
      </p>
    </div>
  );
}

ScheduleExports.propTypes = {
  teams: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string,
      division: PropTypes.object,
    })
  ).isRequired,
  fileName: PropTypes.string.isRequired,
  label: PropTypes.string,
  idPrefix: PropTypes.string.isRequired,
};
