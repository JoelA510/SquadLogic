import React, { useEffect, useRef, useState } from 'react';
import {
  practiceChangesNoteOf,
  readUnshownPracticeChanges,
} from '../utils/practiceExportChanges.js';
import { generateScheduleExports } from '@squadlogic/core/outputGeneration.js';
import {
  exportObjectPath,
  removeScheduleExports,
  uploadScheduleExport,
} from '@squadlogic/core/storageSupabase.js';
import {
  baselineDriftSummary,
  baselineParitySoundness,
} from '@squadlogic/core/publication/index.js';
import { IS_MOCK_MODE } from '../config.js';
import { isDemoOrganization } from '../lib/demo.js';
import { csvBlob, saveFile, xlsxBlob } from '../utils/scheduleDownloads.js';
import { logger } from '../lib/logger.js';
import {
  teamsWithCoachSourceDisagreement,
  teamsWithUncorroboratedCoachIdentity,
} from '@squadlogic/core/people/coachList.js';
import { teamCoachFields, teamCoaches } from '../utils/teamCoaches.js';
import {
  refreshAndReadScheduleTbd,
  scheduleTbdCounts,
  scheduleTbdNote,
} from '../utils/scheduleTbdClient.js';
import { describeScheduleTbdReason } from '@squadlogic/core/scheduleTbd.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import {
  naivePublicationStamp,
  usePublicationBaselines,
} from '../hooks/usePublicationBaselines.js';

/**
 * The publish path, and the question it makes answerable (GAP-29).
 *
 * Uploading the master CSV to Storage is the moment this app sends a schedule
 * out, and until now nothing recorded what went. `handleUpload` therefore
 * records a **publication baseline** alongside the upload: the same
 * `master.rows` the CSV was rendered from, frozen through
 * `makePublicationSnapshot()` and stored by `admin_publish_schedule_baseline()`.
 * No adapter stands between the two -- `generateScheduleExports()` builds its
 * rows from `SCHEDULE_EXPORT_COLUMNS` and `makePublicationSnapshot()` defaults
 * its `columns` to the same frozen constant.
 *
 * The reader is the section below it: pick a stored baseline, and
 * `checkBaselineParity()` says whether the working schedule is still what that
 * version said. A store nothing reads would be the defect this whole phase
 * keeps finding, with a table underneath it.
 *
 * **A failed baseline never reports as a successful publish, and never fails
 * the upload it follows.** The files really did go out; saying otherwise would
 * send an operator to re-upload. So the message carries both outcomes and the
 * status goes to `error` when the baseline did not land, because a publication
 * nobody recorded is exactly the state incident 1 could not recover from.
 */

const MOCK_UPLOAD = IS_MOCK_MODE;
const DAY_INDEX = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

function getAssignmentTeamId(assignment) {
  return assignment?.teamId ?? assignment?.team_id ?? assignment?.teams?.id ?? null;
}

function getAssignmentSlotId(assignment) {
  return (
    assignment?.slotId ??
    assignment?.slot_id ??
    assignment?.practiceSlotId ??
    assignment?.practice_slot_id ??
    assignment?.practiceSlots?.id ??
    assignment?.practice_slots?.id ??
    null
  );
}

function normalizeTeamForExport(team) {
  const id = team?.id ?? team?.teamId ?? team?.team_id;
  if (!id) return null;

  const division =
    team.division ??
    team.divisionName ??
    team.division_id ??
    team.divisionId ??
    team.divisions?.name ??
    '';

  return {
    id,
    name: team.name ?? team.teamName ?? id,
    division,
    // 8.2: the row's coach fields under one spelling, **both sources intact**,
    // so `generateScheduleExports()` reconciles them and its `coachFindings`
    // carry any disagreement. Reconciling here and passing the settled list
    // left the core one source to read, and the message below could never
    // fire — the export said "generated successfully" for a team whose two
    // sources named different people in slot 1.
    ...teamCoachFields(team),
  };
}

function getDateFromRange(range) {
  const match = String(range ?? '').match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? '2026-01-01';
}

function getDateForDay(baseDate, day) {
  const date = new Date(`${baseDate}T00:00:00Z`);
  const dayIndex = DAY_INDEX[String(day ?? '').toLowerCase()];
  if (Number.isNaN(date.getTime()) || dayIndex == null) {
    return baseDate;
  }

  const delta = (dayIndex - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function normalizeTime(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const [hours = '00', minutes = '00', seconds = '00'] = trimmed.split(':');
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}`;
}

function normalizePracticeForExport(assignment) {
  const teamId = getAssignmentTeamId(assignment);
  const slot = assignment?.practiceSlots ?? assignment?.practice_slots ?? {};
  const startTime = normalizeTime(
    assignment?.startTime ?? assignment?.start_time ?? slot.startTime ?? slot.start_time
  );
  const endTime = normalizeTime(
    assignment?.endTime ?? assignment?.end_time ?? slot.endTime ?? slot.end_time
  );
  const range = assignment?.effectiveDateRange ?? assignment?.effective_date_range;
  const day =
    assignment?.dayOfWeek ?? assignment?.day_of_week ?? slot.dayOfWeek ?? slot.day_of_week;
  const date = getDateForDay(getDateFromRange(range), day);

  if (!teamId || (!assignment?.start && !startTime) || (!assignment?.end && !endTime)) {
    return null;
  }

  return {
    teamId,
    start: assignment.start ?? `${date}T${startTime}`,
    end: assignment.end ?? `${date}T${endTime}`,
    fieldId:
      assignment.fieldId ??
      assignment.field_id ??
      slot.fieldId ??
      slot.field_id ??
      slot.fields?.id ??
      slot.fields?.name ??
      '',
    slotId: getAssignmentSlotId(assignment) ?? '',
    notes: assignment.notes ?? '',
  };
}

function normalizeGameForExport(assignment) {
  if (!assignment?.start || !assignment?.end) return null;

  return {
    homeTeamId: assignment.homeTeamId ?? assignment.home_team_id,
    awayTeamId: assignment.awayTeamId ?? assignment.away_team_id,
    start: assignment.start,
    end: assignment.end,
    fieldId: assignment.fieldId ?? assignment.field_id ?? '',
    slotId: assignment.slotId ?? assignment.slot_id ?? '',
    notes: assignment.notes ?? '',
  };
}

function buildExportPayload({ teams, teamSummary, practiceAssignments, gameAssignments }) {
  const teamDirectory = new Map();
  const addTeam = (team) => {
    const normalized = normalizeTeamForExport(team);
    if (normalized) teamDirectory.set(normalized.id, normalized);
  };

  (Array.isArray(teams) ? teams : []).forEach(addTeam);
  (Array.isArray(teamSummary?.teams) ? teamSummary.teams : []).forEach(addTeam);
  (Array.isArray(practiceAssignments) ? practiceAssignments : []).forEach((assignment) => {
    const teamId = getAssignmentTeamId(assignment);
    if (!teamDirectory.has(teamId)) {
      addTeam({ ...assignment.teams, id: teamId });
    }
  });

  const exportTeams = Array.from(teamDirectory.values());
  const exportTeamIds = new Set(exportTeams.map((team) => String(team.id)));
  const practiceRows = Array.isArray(practiceAssignments) ? practiceAssignments : [];
  const gameRows = Array.isArray(gameAssignments) ? gameAssignments : [];
  // An assignment with a broken time (no start or end) is not in the master files:
  // `generateScheduleExports` requires both for an assignment. It is counted here and said beside
  // the files (admin focus R7), never left out without a word. This is only a row whose time is
  // broken: a practice a team is short of and a game that could not be placed are not assignments
  // at all, and are listed as TIME TBD rows from the `schedule_tbd` table (Phase D, E). (A practice
  // row with no team is not counted: it names no team to export it under, and is not a time
  // question.)
  const untimed = {
    practices: practiceRows.filter(
      (a) => a && getAssignmentTeamId(a) && !normalizePracticeForExport(a)
    ).length,
    games: gameRows.filter((a) => a && !normalizeGameForExport(a)).length,
  };
  const exportPractices = practiceRows
    .map(normalizePracticeForExport)
    .filter((assignment) => assignment && exportTeamIds.has(String(assignment.teamId)));
  const exportGames = gameRows
    .map(normalizeGameForExport)
    .filter(
      (assignment) =>
        assignment &&
        exportTeamIds.has(String(assignment.homeTeamId)) &&
        exportTeamIds.has(String(assignment.awayTeamId))
    );

  return {
    teams: exportTeams,
    practiceAssignments: exportPractices,
    gameAssignments: exportGames,
    untimed,
  };
}

/**
 * The sentence for the assignments the master files leave out, or null.
 *
 * @param {{ practices: number, games: number }} untimed
 */
export function untimedAssignmentsNote(untimed) {
  const parts = [
    untimed.games > 0 ? `${untimed.games} game assignment(s)` : null,
    untimed.practices > 0 ? `${untimed.practices} practice assignment(s)` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `${parts.join(' and ')} with no start or end time are not in these files. The downloads on each team's page list that team's saved schedule, with every event that has no time marked TIME TBD and its reason.`;
}

/**
 * One line of the TIME TBD list for an admin: who, how many or which week, and why, in words.
 *
 * @param {Record<string, any>} row - a `get_schedule_tbd` row
 * @returns {string}
 */
export function scheduleTbdLine(row) {
  const why = describeScheduleTbdReason(row.kind, row.reason);
  const division = row.division_name ? ` (${row.division_name})` : '';
  if (row.kind === 'game') {
    return `${row.home_team_name ?? 'A team'} v ${row.away_team_name ?? 'a team'}, week ${row.week_index}${division}: ${why}`;
  }
  const count = row.missing_count ?? 1;
  return `${row.team_name ?? 'A team'}${division}: ${count} practice${count === 1 ? '' : 's'} not scheduled: ${why}`;
}

/**
 * A baseline parity result, rendered for an operator.
 *
 * **All four buckets, and the read's own findings.** Showing only "differing"
 * would hide a fixture that has vanished, which is the half of incident 1 that
 * actually hurt; showing only the parity findings would hide a
 * `SNAPSHOT_DIGEST_MISMATCH`, which means the stored ground truth itself is
 * not what was published and no number below it can be trusted.
 *
 * **Additions are reported as news, not as drift** -- `baselineDriftSummary()`
 * is the one reading of that, and this component does not invent a second one.
 *
 * @param {{ report: { baseline: any, snapshot: any, readFindings: any[], parity: any } }} props
 */
function ParityReport({ report }) {
  const { baseline, parity, readFindings } = report;
  const drift = baselineDriftSummary(parity);
  const all = [...readFindings, ...parity.findings];
  const blocking = all.filter((finding) => finding.severity === 'blocking');
  // **`compromise` is rendered too, and that is a review finding rather than
  // taste.** `PARITY_FIELD_UNCOMPARED` is the statement of what the numbers
  // are silent about and `PARITY_KEY_AMBIGUOUS` says rows were paired by
  // input order because the key did not identify them. Both are `compromise`,
  // both change how the counts above should be read, and dropping them put
  // the narrowing back in the silence `baseline.js` exists to break.
  const qualified = all.filter((finding) => finding.severity === 'compromise');
  // **The verdict is gated on the findings, not only on the buckets.** A run
  // whose `Start` cells nobody could read puts every row in `matched` with
  // `startMinutes` absent, so `drifted` is false and the panel printed, in
  // green, that the schedule still matches — having compared no kickoff at
  // all.
  //
  // `baselineParitySoundness()` rather than "any blocking finding", and the
  // difference matters: `PARITY_ROW_DIFFERS` and `PARITY_ROW_REMOVED` are
  // blocking **because they are the answer**, so gating on severity made the
  // panel refuse to state the result it exists to state. The soundness list
  // is the codes that mean the comparison itself cannot be read, and it lives
  // in the core beside those codes rather than in this component.
  const soundness = baselineParitySoundness(parity, readFindings);
  const unsound = !soundness.sound;

  return (
    <div
      className="bg-bg-surface rounded-lg p-4 border border-border-subtle"
      data-testid="parity-report"
    >
      <h4 className="text-sm font-medium text-text-primary mb-2">
        {`Baseline v${baseline.baselineVersion} — ${baseline.label}`}
      </h4>
      <p
        className={
          unsound
            ? 'text-sm text-status-error-text mb-2'
            : drift.drifted
              ? 'text-sm text-status-warning-text mb-2'
              : 'text-sm text-status-success-text mb-2'
        }
        data-testid="parity-verdict"
      >
        {unsound
          ? `This comparison cannot be read as a verdict (${soundness.reasons.join(', ')}); the counts below are arithmetic over something that did not compare cleanly.`
          : drift.drifted
            ? `The working schedule has moved since this was published: ${drift.differing} row(s) changed, ${drift.removed} row(s) gone.`
            : 'The working schedule still matches what was published.'}
      </p>
      <dl className="text-xs text-text-muted font-mono grid grid-cols-2 gap-x-6 gap-y-1 max-w-sm">
        <dt>Matched</dt>
        <dd data-testid="parity-matched">{drift.matched}</dd>
        <dt>Differing</dt>
        <dd data-testid="parity-differing">{drift.differing}</dd>
        <dt>Removed since publication</dt>
        <dd data-testid="parity-removed">{drift.removed}</dd>
        <dt>Added since publication</dt>
        <dd data-testid="parity-added">{drift.added}</dd>
      </dl>

      {parity.buckets.differing.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-medium text-text-secondary mb-1">What changed</h5>
          <ul className="text-xs text-text-muted space-y-1">
            {/* The key carries the row id, not just the parity key: a
                parity key that does not identify a row is exactly the
                `PARITY_KEY_AMBIGUOUS` case, and there `pair.key` repeats. */}
            {parity.buckets.differing.map((pair) => (
              <li key={pair.currentRow.rowId} data-testid="parity-differing-row">
                {`${pair.label} — ${pair.changedFields.join(', ')}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {parity.buckets.removed.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-medium text-text-secondary mb-1">
            Published and no longer in the schedule
          </h5>
          <ul className="text-xs text-text-muted space-y-1">
            {parity.buckets.removed.map((orphan) => (
              <li key={orphan.row.rowId} data-testid="parity-removed-row">
                {orphan.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {blocking.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-medium text-status-error-text mb-1">Blocking findings</h5>
          <ul className="text-xs text-status-error-text space-y-1">
            {blocking.map((finding, index) => (
              <li key={`${finding.code}-${index}`} data-testid="parity-blocking">
                {`${finding.code}: ${finding.message}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {qualified.length > 0 && (
        <div className="mt-3">
          <h5 className="text-xs font-medium text-status-warning-text mb-1">
            What these numbers do not say
          </h5>
          <ul className="text-xs text-status-warning-text space-y-1">
            {qualified.map((finding, index) => (
              <li key={`${finding.code}-${index}`} data-testid="parity-qualified">
                {`${finding.code}: ${finding.message}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * No read failed. The default for `sourceErrors`, so the pipeline call site
 * that passes nothing behaves exactly as it did.
 */
const NO_SOURCE_ERRORS = Object.freeze({ team: null, practice: null, game: null });

/** Nothing is still in flight. The default for `sourceLoading`. */
const NO_SOURCE_LOADING = Object.freeze({ team: false, practice: false, game: false });

/** How each failed source is named to an operator. */
const SOURCE_LABELS = Object.freeze({
  team: 'the teams',
  practice: 'the practice assignments',
  game: 'the game assignments',
});

/** The sources in `keys` whose rows cannot be trusted yet, in the order given. */
function unreadableSources(sourceErrors, sourceLoading, keys) {
  return keys.filter((key) => Boolean(sourceErrors?.[key]) || Boolean(sourceLoading?.[key]));
}

/** Whether any named source is unreadable because it has not arrived yet. */
function anyLoading(sourceLoading, keys) {
  return keys.some((key) => Boolean(sourceLoading?.[key]));
}

/** "the teams", "the teams and the game assignments", … */
function describeSources(keys) {
  const labels = keys.map((key) => SOURCE_LABELS[key]);
  if (labels.length < 2) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * What an export with no schedule behind it says. The master and per-team files hold one row
 * per practice or game and nothing for a team that has none, so a league that has applied no
 * schedule yet (a demo visitor's first visit, a season just formed) used to download a file
 * of headers. Nothing is faked: the page says what is missing and where to get it.
 */
const NOTHING_SCHEDULED_TEXT =
  'Nothing to export yet: no practices or games have been applied. Generate and apply a schedule on Practices (and on Games), then come back here.';

/**
 * The output panel, and what it refuses to generate from data it could not
 * read.
 *
 * **An empty array is two different facts and this component used to be told
 * only one of them.** Both call sites pass `teams={team?.teams || []}`, and
 * that `|| []` turns a refused `scheduler_runs` read into "the season has no
 * teams". A zero-row CSV is the correct export for an empty season and a
 * falsehood after a failed read, and nothing in `teams` distinguishes them --
 * so the distinction arrives separately, as `sourceErrors`, rather than as a
 * `disabled` boolean the parent computed. The panel knows which of its inputs
 * feeds which artifact; the page does not.
 *
 * **A source still in flight is not a source that returned nothing, either.**
 * `sourceLoading` is the same statement about the same three reads one moment
 * earlier. The first paint of `/exports` has empty arrays and no error at
 * all, and without this an operator who lands on the page and presses
 * Generate before the fetches resolve gets the same zero-row CSV by a route
 * that involves no failure.
 *
 * **Per artifact, not per panel.** The CSV export is built from all three
 * sources, so any one of them failing is a reason not to generate it. The
 * welcome-email drafts read teams and practice assignments only -- a coach's
 * draft carries their practice times and never mentions a game -- so a
 * refused `game_assignments` read does not stop them. Gating the whole panel
 * on one aggregate error would have claimed a precision the sources do not
 * have, in the other direction.
 *
 * **`aria-disabled`, not `disabled`.** A control with no reachable
 * explanation is its own defect: a native `disabled` button is removed from
 * the tab order, so a keyboard user meets a dead control and the reason it is
 * dead is something they have to go looking for. `aria-disabled` keeps it
 * focusable, `aria-describedby` points at the visible reason next to it, and
 * the handlers below refuse the action -- so the guard is the code path, not
 * the attribute. (`StepRunButton` puts its reason in a `Tooltip` over a
 * natively disabled button. That is the weaker surface of the two and its
 * `if (disabled) return;` cannot run; this does not copy it.)
 *
 * @param {Object} props
 * @param {Array<Object>} [props.teams]
 * @param {Object|null} [props.teamSummary]
 * @param {Array<Object>} [props.practiceAssignments]
 * @param {Array<Object>} [props.gameAssignments]
 * @param {any} props.supabaseClient
 * @param {{ team?: string|null, practice?: string|null, game?: string|null }} [props.sourceErrors]
 *   Per-source read failures from `useDashboardData().errors`. Omit when every
 *   read succeeded; an empty `teams` is then taken at face value.
 * @param {{ team?: boolean, practice?: boolean, game?: boolean }} [props.sourceLoading]
 *   Per-source reads still in flight, from `useDashboardData().loading`.
 */
export default function OutputGenerationPanel({
  teams = [],
  teamSummary = null,
  practiceAssignments = [],
  gameAssignments = [],
  supabaseClient,
  sourceErrors = NO_SOURCE_ERRORS,
  sourceLoading = NO_SOURCE_LOADING,
}) {
  const [generated, setGenerated] = useState(null);
  const [emails, setEmails] = useState(null);
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  // R9 / Q6: the exports stay series-level and say how many practices have
  // temporary changes they do not show. Its own line, beside the message.
  const [practiceChangesNote, setPracticeChangesNote] = useState(null);
  const practiceChangesRead = useRef(0);
  /** Clear the note, and let no read still in flight set it again. */
  const clearPracticeChanges = () => {
    practiceChangesRead.current += 1;
    setPracticeChangesNote(null);
  };
  /** @param {Array<Object>} exportedRows - exactly the practice rows the artifact holds */
  const notePracticeChanges = (exportedRows) => {
    clearPracticeChanges();
    const token = practiceChangesRead.current;
    readUnshownPracticeChanges(supabaseClient, exportedRows).then((result) => {
      // Only the latest generation's answer is shown.
      if (token === practiceChangesRead.current) {
        setPracticeChangesNote(practiceChangesNoteOf(result));
      }
    });
  };
  const { user } = useAuth() || {};
  const { currentOrganization, currentSeasonSetting } = useOrganization() || {};
  const seasonSettingsId = currentSeasonSetting?.id ?? null;
  // How many TIME TBD items the season has, as refreshed and read when the panel opened (or the season
  // changed). The refresh matters here: a run that placed nothing never reached the practice save, so
  // without it the list could be empty while the roster still owes practices.
  const [tbdPreview, setTbdPreview] = useState({ status: 'idle', count: 0 });
  useEffect(() => {
    if (!seasonSettingsId) {
      setTbdPreview({ status: 'idle', count: 0 });
      return undefined;
    }
    let current = true;
    setTbdPreview({ status: 'loading', count: 0 });
    refreshAndReadScheduleTbd(supabaseClient, seasonSettingsId).then(
      (list) => {
        if (current) setTbdPreview({ status: 'ready', count: list.items.length });
      },
      (err) => {
        logger.error('TIME TBD refresh/read error:', err);
        if (current) setTbdPreview({ status: 'error', count: 0 });
      }
    );
    return () => {
      current = false;
    };
  }, [seasonSettingsId, supabaseClient]);
  // The TIME TBD rows the files hold, as `get_schedule_tbd` returned them (null: none generated).
  const [tbdRows, setTbdRows] = useState(/** @type {Array<Record<string, any>> | null} */ (null));
  // A demo uploads nothing (the server refuses the folder, D3); downloads still work.
  const inDemo = isDemoOrganization(currentOrganization);
  const {
    baselines,
    loading: baselinesLoading,
    error: baselinesError,
    publishBaseline,
    compareWithBaseline,
  } = usePublicationBaselines();
  const [selectedBaselineId, setSelectedBaselineId] = useState('');
  const [parityReport, setParityReport] = useState(null);
  const [parityError, setParityError] = useState(null);
  const [parityBusy, setParityBusy] = useState(false);
  // The master XLSX download's failure, said beside the files (admin focus R7).
  const [xlsxError, setXlsxError] = useState(/** @type {string | null} */ (null));

  // The CSV export flattens teams, practices and games into one file; the
  // email drafts read teams and practices only.
  const CSV_SOURCES = ['team', 'practice', 'game'];
  const EMAIL_SOURCES = ['team', 'practice'];
  const csvBlockedBy = unreadableSources(sourceErrors, sourceLoading, CSV_SOURCES);
  const emailsBlockedBy = unreadableSources(sourceErrors, sourceLoading, EMAIL_SOURCES);
  const csvBlocked = csvBlockedBy.length > 0;
  const emailsBlocked = emailsBlockedBy.length > 0;
  // Every source read cleanly (`csvBlocked` is false) and none holds a practice or a game.
  // The TIME TBD list counts as something to export: a season with a game the scheduler could not
  // place and nothing placed yet still has files to make (its rows). The list is read when the panel
  // opens, so this gate can say so; while it is still being read, or when it could not be read, the
  // panel does not claim there is nothing (Generate reads it again and says which).
  const nothingScheduled =
    !csvBlocked &&
    (practiceAssignments?.length ?? 0) === 0 &&
    (gameAssignments?.length ?? 0) === 0 &&
    (tbdPreview.status === 'idle' || tbdPreview.status === 'ready') &&
    tbdPreview.count === 0;
  // "Not read yet" and "could not be read" are different sentences, and
  // telling an operator a read failed while it is merely slow is the same
  // class of false statement this gate exists to stop.
  const csvReason = anyLoading(sourceLoading, CSV_SOURCES)
    ? `CSVs cannot be generated yet: ${describeSources(csvBlockedBy)} have not finished loading.`
    : `CSVs cannot be generated: ${describeSources(csvBlockedBy)} could not be read. An export made now would be missing rows, not reporting an empty season. Reload the page to read again.`;
  const emailsReason = anyLoading(sourceLoading, EMAIL_SOURCES)
    ? `Drafts cannot be written yet: ${describeSources(emailsBlockedBy)} have not finished loading.`
    : `Drafts cannot be written: ${describeSources(emailsBlockedBy)} could not be read. A draft made now would tell a coach their practice times are TBD when the truth is that we could not look them up. Reload the page to read again.`;

  const generateEmails = () => {
    if (emailsBlocked) return;
    const sourceTeams =
      Array.isArray(teams) && teams.length > 0
        ? teams
        : Array.isArray(teamSummary?.teams)
          ? teamSummary.teams
          : [];

    // 8.2: one draft per coach, not one per team. The old shape addressed
    // `headCoach` and every co-coach got nothing — the same truncation the
    // export carried, in the artifact that actually reaches a person.
    //
    // A coach with no address on file still gets no draft, and that is
    // **counted and reported** rather than absorbed: most team rows the app
    // holds carry one email, so a silent "42 drafts" would look exactly like a
    // run that reached everybody.
    // Keyed by coach, not by coach-team pair: one assistant with no address who
    // coaches three teams is one person, and reporting "3 coaches" would be the
    // same unit confusion the count exists to end.
    const coachesWithoutDraft = new Set();
    const drafts = sourceTeams.flatMap((team) => {
      const teamPractices = practiceAssignments.filter((p) =>
        [p.teamId, p.team_id].some((teamId) => String(teamId) === String(team.id))
      );
      const scheduleStr =
        teamPractices.length > 0
          ? teamPractices
              .map((p) => `${p.day} at ${p.slotId.split('_').pop().slice(0, 5)} on ${p.fieldId}`)
              .join(' and ')
          : 'TBD';

      const coaches = teamCoaches(team);
      // Everybody a draft cannot reach, whether the row lacks their address or
      // their name. Counting only the named ones left a team whose rows carry
      // ids and no names reporting "0 drafts" with nobody named as skipped.
      for (const coach of coaches) {
        if (!coach.displayName || !coach.email) coachesWithoutDraft.add(coach.personId);
      }
      return coaches
        .filter((coach) => coach.displayName && coach.email)
        .map((coach) => ({
          teamId: team.id,
          coachName: coach.displayName,
          coachEmail: coach.email,
          subject: `Welcome to the season, Coach ${coach.displayName}!`,
          body: `Hi Coach ${coach.displayName},\n\nThank you for volunteering to coach ${team.name} in the ${team.division || team.divisionName} division this season! Your roster has been finalized.\n\nYour assigned practice schedule is:\n${scheduleStr}\n\nPlease let us know if you have any questions.\n\nBest,\nLeague Admin`,
        }));
    });

    setEmails(drafts);
    // The rows the drafts were written from: the practices of the drafted teams.
    const draftedTeamIds = new Set(sourceTeams.map((team) => String(team.id)));
    notePracticeChanges(
      practiceAssignments.filter((p) =>
        [p.teamId, p.team_id].some((teamId) => draftedTeamIds.has(String(teamId)))
      )
    );
    setMessage(
      coachesWithoutDraft.size === 0
        ? `Generated ${drafts.length} email drafts, one per coach.`
        : `Generated ${drafts.length} email drafts, one per coach. ${coachesWithoutDraft.size} coach(es) have no name or address on file and were not written to.`
    );
  };

  const handleGenerate = () => {
    if (csvBlocked) return;
    // An XLSX failure from the previous files is not about the next ones.
    setXlsxError(null);
    setStatus('generating');
    setMessage('Generating CSVs...');

    setTimeout(async () => {
      try {
        // The TIME TBD list (practices a team is short of, games not placed), brought up to date and
        // then read. First: a list that cannot be refreshed or read stops the files, because files made
        // without it would leave those practices and games out without a word.
        let tbd = { rows: /** @type {Array<Record<string, any>>} */ ([]), items: [] };
        if (seasonSettingsId) {
          try {
            tbd = await refreshAndReadScheduleTbd(supabaseClient, seasonSettingsId);
          } catch (tbdErr) {
            logger.error('TIME TBD refresh/read error:', tbdErr);
            setGenerated(null);
            setTbdRows(null);
            clearPracticeChanges();
            setStatus('error');
            setMessage(
              `Generation failed: the list of practices and games not scheduled yet could not be brought up to date and read (${tbdErr.message}), so files made now could leave some out. No files were made. Reload the page to try again.`
            );
            return;
          }
        }
        setTbdPreview({ status: 'ready', count: tbd.items.length });
        // The guard is the code path, not the attribute: a header-only file is not an export. Nothing
        // placed and nothing on the TIME TBD list is nothing to make files from; a list with items is.
        if (
          (practiceAssignments?.length ?? 0) === 0 &&
          (gameAssignments?.length ?? 0) === 0 &&
          tbd.items.length === 0
        ) {
          setGenerated(null);
          setTbdRows(null);
          setStatus('idle');
          setMessage(NOTHING_SCHEDULED_TEXT);
          return;
        }
        const exportPayload = buildExportPayload({
          teams,
          teamSummary,
          practiceAssignments,
          gameAssignments,
        });
        if (
          exportPayload.practiceAssignments.length === 0 &&
          exportPayload.gameAssignments.length === 0 &&
          tbd.items.length === 0
        ) {
          // Assignments exist but none can be written (no start or end time, or no team on
          // the export): say which, rather than hand over a file of headers.
          setGenerated(null);
          setTbdRows(null);
          clearPracticeChanges();
          setStatus('idle');
          setMessage(
            [
              'Nothing to export: none of the applied practices or games can be written to the files.',
              untimedAssignmentsNote(exportPayload.untimed),
            ]
              .filter(Boolean)
              .join(' ')
          );
          return;
        }
        const exports = generateScheduleExports({
          teams: exportPayload.teams,
          practiceAssignments: exportPayload.practiceAssignments,
          gameAssignments: exportPayload.gameAssignments,
          tbdItems: tbd.items,
        });
        setGenerated(exports);
        setTbdRows(tbd.rows);
        // Counted over the rows the CSV holds, filtered exactly as
        // `buildExportPayload` filters them, never over rows it dropped.
        const exportTeamIds = new Set(exportPayload.teams.map((team) => String(team.id)));
        notePracticeChanges(
          practiceAssignments.filter((assignment) => {
            const exported = normalizePracticeForExport(assignment);
            return exported && exportTeamIds.has(String(exported.teamId));
          })
        );
        // **A parity report describes one row set.** Leaving the previous
        // verdict on screen after a regenerate means a green "still matches"
        // describing a schedule that no longer exists.
        setParityReport(null);
        setParityError(null);
        setStatus('idle');
        // The reconciliation's findings are surfaced, not discarded. A
        // `COACH_ORDER_SOURCE_DISAGREES` is two sources contradicting each
        // other about a team's coach order; producing that and dropping it here
        // would make the export look clean for a team nobody has reconciled —
        // the "declared is not enforced" shape, in the artifact this change
        // exists to fix.
        //
        // Filtered on the codes that mean disagreement, **not on severity**:
        // `COACH_SLOT_UNDECLARED` is also `compromise` and fires for the
        // ordinary app row, so a severity filter told the operator that sources
        // disagreed about teams where only one source was ever read.
        //
        // `COACH_IDENTITY_UNCORROBORATED` is the other silence refused: a coach
        // no row carries an id for is exported but cannot be clash-checked, and
        // the operator is told so rather than shown a clean sheet.
        const teamsWithDisagreement = teamsWithCoachSourceDisagreement(exports.coachFindings);
        const teamsUncorroborated = teamsWithUncorroboratedCoachIdentity(exports.coachFindings);
        setMessage(
          [
            'CSVs generated successfully.',
            scheduleTbdNote(scheduleTbdCounts(tbd.items)),
            untimedAssignmentsNote(exportPayload.untimed),
            teamsWithDisagreement.length === 0
              ? null
              : `${teamsWithDisagreement.length} team(s) have sources that disagree about their coaches; every coach is exported and none is treated as the primary.`,
            teamsUncorroborated.length === 0
              ? null
              : `${teamsUncorroborated.length} team(s) have a coach with no id on file; they are exported, but no clash check can cover them until a row carries their id.`,
          ]
            .filter(Boolean)
            .join(' ')
        );
      } catch (err) {
        logger.error('Generation error:', err);
        setStatus('error');
        setTbdRows(null);
        // A note from an earlier run describes an export that no longer exists.
        clearPracticeChanges();
        setMessage(`Generation failed: ${err.message}`);
      }
    }, 0);
  };

  /**
   * Upload the master CSV and one CSV per team to the `exports` bucket, under
   * the active organization's folder (`<organizationId>/...`), which is what
   * the bucket's policies require (`20261017000000_exports_bucket.sql`).
   *
   * **A publish is all or nothing.** Each upload is settled on its own
   * (`Promise.all` reported the first refusal while the others carried on).
   * When any file fails, the ones that did upload are removed again through
   * the Storage API (the bucket's admin DELETE policy), no baseline is
   * recorded, and the message says exactly that. Otherwise a partial set
   * would stay readable to every member with no baseline or audit row saying
   * what went out (Codex review on #592). A removal that itself fails is not
   * hidden: the message names every file still in the bucket, and each is
   * logged. Pressing Upload again sends a complete set under a new stamp.
   */
  const handleUpload = async () => {
    if (!generated || csvBlocked) return;
    if (!supabaseClient && !IS_MOCK_MODE) {
      setStatus('error');
      setMessage('Supabase client not available for upload.');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let files;
    try {
      const organizationId = currentOrganization?.id;
      files = [
        {
          path: exportObjectPath(organizationId, `master-schedule-${timestamp}.csv`),
          content: generated.master.csv,
        },
        ...generated.perTeam.map((teamExport) => ({
          path: exportObjectPath(organizationId, `teams/${teamExport.teamId}-${timestamp}.csv`),
          content: teamExport.csv,
        })),
      ];
    } catch (err) {
      logger.error('Upload error:', err);
      setStatus('error');
      setMessage(`Upload failed: nothing was uploaded. ${err.message}`);
      return;
    }

    setStatus('uploading');
    setMessage('Uploading to Storage...');

    try {
      const results = await Promise.allSettled(
        files.map((file) => uploadFile(supabaseClient, file.path, file.content))
      );
      const failures = results.flatMap((result, index) =>
        result.status === 'rejected' ? [{ path: files[index].path, reason: result.reason }] : []
      );
      if (failures.length > 0) {
        for (const failure of failures) {
          logger.error('Upload error:', failure.path, failure.reason);
        }
        const failedPaths = new Set(failures.map((failure) => failure.path));
        const uploaded = files.map((file) => file.path).filter((path) => !failedPaths.has(path));
        const cleanup = await removeUploaded(supabaseClient, uploaded);
        for (const path of cleanup.leftBehind) {
          logger.error('Upload cleanup left a file in the exports bucket:', path, cleanup.error);
        }
        let outcome;
        if (uploaded.length === 0) {
          outcome = "Nothing reached the 'exports' bucket.";
        } else if (cleanup.leftBehind.length === 0) {
          outcome = `The ${uploaded.length} that uploaded ${uploaded.length === 1 ? 'was' : 'were'} removed, so nothing was published.`;
        } else {
          outcome =
            `Of the ${uploaded.length} that uploaded, ${cleanup.removed.length} ${cleanup.removed.length === 1 ? 'was' : 'were'} removed and ` +
            `${cleanup.leftBehind.length} could not be` +
            (cleanup.error ? ` (${cleanup.error})` : '') +
            ` and ${cleanup.leftBehind.length === 1 ? 'is' : 'are'} still in the 'exports' bucket: ${cleanup.leftBehind.join(', ')}.`;
        }
        setStatus('error');
        setMessage(
          `Upload failed: ${failures.length} of ${files.length} files were not uploaded ` +
            `(${failures[0].reason?.message ?? String(failures[0].reason)}). ` +
            `${outcome} No published baseline was recorded.`
        );
        return;
      }

      // **Stage 3: the writer, on the path that actually publishes.** The
      // rows go in exactly as the CSV was rendered from them.
      let baselineNote;
      let baselineFailed = false;
      try {
        const recorded = await publishBaseline({
          snapshotId: `master-schedule-${timestamp}`,
          label: `Master schedule, ${generated.master.rows.length} rows`,
          channel: 'exports bucket',
          // The caller's clock, in local wall-clock parts. This package never
          // self-stamps: a snapshot that invents its own timestamp and actor
          // has two fields that read as an audit trail and are not one.
          publishedAt: naivePublicationStamp(new Date()),
          publishedBy: user?.id ? String(user.id) : 'unknown-actor',
          rows: generated.master.rows,
        });
        baselineNote = `Recorded as published baseline v${recorded.baseline_version}.`;
      } catch (baselineErr) {
        logger.error('Baseline error:', baselineErr);
        baselineFailed = true;
        baselineNote =
          `The files went out but NO published baseline was recorded: ` +
          `${baselineErr.message}. Nothing can later be checked against this publication.`;
      }

      setStatus(baselineFailed ? 'error' : 'success');
      setMessage(`Uploaded ${files.length} files to 'exports' bucket. ${baselineNote}`);
    } catch (err) {
      logger.error('Upload error:', err);
      setStatus('error');
      setMessage(`Upload failed: ${err.message}`);
    }
  };

  /**
   * **Stage 4: the reader.** "Is the working schedule still what version v
   * said?", answered from the store rather than from this process's memory.
   */
  const handleCheckParity = async () => {
    setParityBusy(true);
    setParityError(null);
    setParityReport(null);
    try {
      const report = await compareWithBaseline(selectedBaselineId, generated?.master?.rows ?? []);
      setParityReport(report);
    } catch (err) {
      logger.error('Parity error:', err);
      setParityError(err.message || 'The baseline comparison could not be run.');
    } finally {
      setParityBusy(false);
    }
  };

  const uploadFile = async (client, path, content) => {
    if (MOCK_UPLOAD) {
      logger.log(`[Mock Upload] ${path} (${content.length} bytes)`);
      return Promise.resolve({ path });
    }
    return uploadScheduleExport({
      supabaseClient: client,
      bucket: 'exports',
      path,
      file: content,
      // The bucket has no UPDATE policy: a published export is never
      // overwritten, and an upsert would be refused.
      upsert: false,
    });
  };

  /**
   * Remove the files a failed publish did upload. A removal the client
   * throws on (not a refusal, which comes back as `error`) is reported the
   * same way: every file is still there, with the reason.
   *
   * @returns {Promise<{ removed: string[], leftBehind: string[], error: string | null }>}
   */
  const removeUploaded = async (client, paths) => {
    if (paths.length === 0) return { removed: [], leftBehind: [], error: null };
    if (MOCK_UPLOAD) {
      logger.log(`[Mock Upload] removed ${paths.join(', ')}`);
      return { removed: [...paths], leftBehind: [], error: null };
    }
    try {
      return await removeScheduleExports({ supabaseClient: client, bucket: 'exports', paths });
    } catch (err) {
      return { removed: [], leftBehind: [...paths], error: err?.message ?? String(err) };
    }
  };

  const downloadCsv = (filename, content) => saveFile(filename, csvBlob(content));

  /**
   * The master file as XLSX (admin focus R7): exactly the CSV's rows and
   * columns, `Coach Emails` included (this page is an admin's), every cell as
   * text.
   */
  const downloadMasterXlsx = async () => {
    if (!generated || csvBlocked) return;
    setXlsxError(null);
    try {
      saveFile(
        'master-schedule.xlsx',
        await xlsxBlob(generated.master.headers, generated.master.rows, 'Master schedule')
      );
    } catch (err) {
      logger.error('XLSX export error:', err);
      setXlsxError(`The XLSX file could not be made: ${err?.message ?? String(err)}`);
    }
  };

  return (
    <div className="glass-panel p-6 rounded-xl border border-border-subtle relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-orange-500/5 to-red-500/5 pointer-events-none" />

      <div className="relative z-10">
        <h2 className="text-xl font-bold text-text-primary mb-4 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-orange-400 shadow-[0_0_10px_rgba(251,146,60,0.5)]" />
          Output Generation
        </h2>

        <div className="flex flex-col gap-4">
          <div className="flex gap-4">
            <button
              type="button"
              data-testid="generate-csvs-btn"
              onClick={handleGenerate}
              disabled={status === 'generating' || status === 'uploading'}
              aria-disabled={csvBlocked || nothingScheduled || undefined}
              aria-describedby={
                csvBlocked
                  ? 'output-csv-blocked'
                  : nothingScheduled
                    ? 'output-csv-empty'
                    : undefined
              }
              className={`relative z-20 bg-bg-surface hover:bg-bg-surface-hover text-text-primary px-4 py-2 rounded-lg transition-colors${
                csvBlocked || nothingScheduled ? ' opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {status === 'generating' ? 'Generating...' : 'Generate CSVs'}
            </button>

            {/* The artifact goes with the gate, and this is the finding that
                said so: gating Generate alone left Upload, Download and the
                publish baseline one button to the right of the block, so the
                zero-row CSV still reached the bucket and was recorded as
                what went out. Whatever `generated` holds was rendered from
                rows this panel can no longer vouch for, so it is not offered
                until they can be read again. The same for the drafts list
                below, whose mailto links are live. */}
            {generated && !csvBlocked && !inDemo && (
              <button
                type="button"
                onClick={handleUpload}
                disabled={status === 'uploading'}
                // `btn-primary` and not a palette orange: white on `orange-500` was 2.88:1 (axe,
                // `color-contrast`), under AA's 4.5:1 in both themes.
                className="btn btn-primary relative z-20"
              >
                {status === 'uploading' ? 'Uploading...' : 'Upload to Storage'}
              </button>
            )}
          </div>

          {/* The reason, beside the control it explains and not only in the
              page banner above -- an operator who scrolled past the banner
              still needs to know why this button will not act. It is the
              `aria-describedby` target, so it is the reason a screen reader
              reads out on the button too, rather than a second red box
              competing with `DataErrorBanner`. */}
          {csvBlocked && (
            <p
              id="output-csv-blocked"
              data-testid="csv-blocked-reason"
              className="text-sm text-status-error m-0"
            >
              {csvReason}
            </p>
          )}

          {nothingScheduled && (
            <p
              id="output-csv-empty"
              data-testid="csv-empty-reason"
              className="text-sm text-text-secondary m-0"
            >
              {NOTHING_SCHEDULED_TEXT}
            </p>
          )}

          {generated && !csvBlocked && (
            <div className="bg-bg-surface rounded-lg p-4 border border-border-subtle mt-2">
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-medium text-text-primary">Generated Files</h3>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => downloadCsv('master-schedule.csv', generated.master.csv)}
                    className="relative z-20 text-xs text-text-accent"
                  >
                    Download Master CSV
                  </button>
                  <button
                    type="button"
                    data-testid="download-master-xlsx"
                    onClick={downloadMasterXlsx}
                    className="relative z-20 text-xs text-text-accent"
                  >
                    Download Master XLSX
                  </button>
                </div>
              </div>
              {xlsxError && (
                <p role="alert" className="text-xs text-status-error-text mb-2">
                  {xlsxError}
                </p>
              )}
              <div className="text-xs text-text-muted font-mono">
                <div>Master Schedule: {generated.master.rows.length} rows</div>
                <div>Team Schedules: {generated.perTeam.length} files</div>
              </div>
            </div>
          )}

          {generated && !csvBlocked && tbdRows && tbdRows.length > 0 && (
            <section
              aria-labelledby="schedule-tbd-heading"
              data-testid="schedule-tbd-list"
              className="bg-bg-surface rounded-lg p-4 border border-border-subtle mt-2"
            >
              <h3 id="schedule-tbd-heading" className="text-sm font-medium text-text-primary mb-1">
                Not scheduled yet: listed as TIME TBD
              </h3>
              <p className="text-xs text-text-muted mb-2">
                These are in the master and team files with the time and the ground marked TBD, and
                the reason in Notes.
              </p>
              <div
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region: focusable so the keyboard can scroll it (WCAG 2.1.1)
                tabIndex={0}
                role="region"
                aria-label="Practices and games not scheduled yet"
                className="max-h-64 overflow-y-auto"
              >
                <ul className="text-xs text-text-muted space-y-1">
                  {tbdRows.map((row) => (
                    <li key={row.id} data-testid="schedule-tbd-row">
                      {scheduleTbdLine(row)}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section
            aria-labelledby="published-baselines-heading"
            className="pt-4 border-t border-border-subtle mt-4"
          >
            <h3
              id="published-baselines-heading"
              className="text-lg font-bold text-text-primary mb-2"
            >
              Published Baselines
            </h3>
            <p className="text-xs text-text-muted mb-4">
              Uploading to Storage records what went out. Compare a published baseline against the
              schedule you have now to see what has moved since.
            </p>

            {baselinesLoading ? (
              <p className="text-sm text-text-muted">Loading published baselines…</p>
            ) : baselinesError ? (
              /* **A read that failed is not an empty store.** The hook empties
                 the list on a read error, so without this the operator is told
                 "nothing has been published yet" when the truth is that we
                 could not find out — which is the false statement
                 `docs/sql/20260920000000_revert.sql` explicitly promises this
                 surface will not make. */
              <p className="text-sm text-status-error-text" data-testid="baselines-error">
                {`Published baselines could not be read, so this says nothing about whether any exist: ${baselinesError}`}
              </p>
            ) : baselines.length === 0 ? (
              <p className="text-sm text-text-muted" data-testid="no-baselines">
                Nothing has been published yet. Generate the CSVs and upload them to record the
                first baseline.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="baseline-select"
                    className="text-xs font-medium text-text-secondary"
                  >
                    Published baseline
                  </label>
                  <select
                    id="baseline-select"
                    data-testid="baseline-select"
                    value={selectedBaselineId}
                    onChange={(event) => {
                      setSelectedBaselineId(event.target.value);
                      // The report on screen is about the version that was
                      // selected when it ran, not this one.
                      setParityReport(null);
                      setParityError(null);
                    }}
                    className="relative z-20 bg-bg-surface text-text-primary border border-border-subtle rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">Choose a version…</option>
                    {baselines.map((baseline) => (
                      <option key={baseline.id} value={baseline.id}>
                        {`v${baseline.baselineVersion} — ${baseline.label} — published ${baseline.publishedAt} (${baseline.rowCount} rows)`}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  data-testid="check-parity-btn"
                  onClick={handleCheckParity}
                  disabled={parityBusy || !selectedBaselineId || !generated}
                  className="relative z-20 bg-bg-surface hover:bg-bg-surface-hover text-text-primary px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  {parityBusy ? 'Checking…' : 'Check against current schedule'}
                </button>
                {!generated && (
                  <p className="text-xs text-text-muted">
                    Generate the CSVs first — there is no current schedule to compare against.
                  </p>
                )}
              </div>
            )}

            <div aria-live="polite" className="mt-4">
              {parityError && (
                <p className="text-sm text-status-error-text" data-testid="parity-error">
                  {parityError}
                </p>
              )}
              {parityReport && <ParityReport report={parityReport} />}
            </div>
          </section>

          <div className="pt-4 border-t border-border-subtle mt-4">
            <h3 className="text-lg font-bold text-text-primary mb-4">Coach Communications</h3>
            <button
              type="button"
              data-testid="generate-emails-btn"
              onClick={generateEmails}
              aria-disabled={emailsBlocked || undefined}
              aria-describedby={emailsBlocked ? 'output-emails-blocked' : undefined}
              className={`relative z-20 bg-purple-500/20 hover:bg-purple-500/30 text-text-accent border border-purple-500/30 px-4 py-2 rounded-lg transition-colors mb-4${
                emailsBlocked ? ' opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Generate Draft Welcome Emails
            </button>
            {emailsBlocked && (
              <p
                id="output-emails-blocked"
                data-testid="emails-blocked-reason"
                className="text-sm text-status-error mt-0 mb-4"
              >
                {emailsReason}
              </p>
            )}

            {emails && !emailsBlocked && (
              <div className="space-y-4 max-h-96 overflow-y-auto pr-2">
                {emails.length === 0 ? (
                  <p className="text-sm text-text-muted">No coaches with emails found.</p>
                ) : (
                  emails.map((email, idx) => (
                    <div
                      key={idx}
                      className="bg-bg-surface border border-border-subtle rounded-lg p-4"
                    >
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="text-sm font-bold text-text-primary">
                            To: {email.coachName} &lt;{email.coachEmail}&gt;
                          </div>
                          <div className="text-sm text-text-secondary">
                            Subject: {email.subject}
                          </div>
                        </div>
                        <a
                          href={`mailto:${email.coachEmail}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`}
                          className="relative z-20 bg-blue-500/20 text-text-accent px-3 py-1 text-xs rounded hover:bg-blue-500/30 transition-colors shrink-0"
                        >
                          Open in Mail App
                        </a>
                      </div>
                      <div className="bg-bg-app rounded p-3 text-xs text-text-secondary whitespace-pre-wrap font-mono border border-border-subtle">
                        {email.body}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="text-sm min-h-[20px]" data-testid="output-generation-status">
            {status === 'error' && <span className="text-status-error-text">{message}</span>}
            {status === 'success' && <span className="text-status-success-text">{message}</span>}
            {(status === 'generating' || status === 'uploading') && (
              <span className="text-status-warning-text animate-pulse">{message}</span>
            )}
            {status === 'idle' && message && <span className="text-text-muted">{message}</span>}
          </div>
          {practiceChangesNote && (
            <p
              role="status"
              data-testid="export-practice-changes"
              className="text-sm text-text-secondary"
            >
              {practiceChangesNote}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
