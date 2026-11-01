import React, { useCallback, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import Badge from '../ui/Badge.jsx';
import Modal from '../ui/Modal.jsx';
import Tabs from '../ui/Tabs.jsx';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import SeasonReadOnlyNote from '../chrome/SeasonReadOnlyNote.jsx';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { useSeasonReadOnly } from '../../hooks/useSeasonReadOnly.js';
import {
  decideMustPreference,
  removePracticePreference,
  useCoachPracticePreferences,
} from '../../hooks/useCoachPracticePreferences.js';
import { useImportJobLabels, usePreferenceContext } from '../../hooks/usePreferenceContext.js';
import {
  databaseIsoDate,
  describeRule,
  previewRunDate,
} from '../../utils/coachPreferencePreview.js';
import { groupPendingMusts } from '../../utils/pendingMustGroups.js';
import { findMustConflicts } from '../../utils/practiceMustConflicts.js';
import { PreferencesLoadError } from './PreferenceFields.jsx';
import AcceptAllDialog from './AcceptAllDialog.jsx';
import AcceptMustDialog from './AcceptMustDialog.jsx';
import ConflictsView from './ConflictsView.jsx';
import PendingMusts from './PendingMusts.jsx';
import PreferenceImportPanel from './PreferenceImportPanel.jsx';
import RuleDialog from './RuleDialog.jsx';
import RulesList from './RulesList.jsx';

const PANEL_ID = 'practice-preferences-panel';

/** Confirm taking a rule out of force; the row stays as history, but there is no undo in the app. */
function RemoveDialog({ row, label, onClose, onConfirm, busy }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Remove this rule"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy} disabled={busy}>
            Remove rule
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-sm m-0">{label}</p>
        <p className="text-sm text-text-muted m-0">
          The rule stops applying to the scheduler at once. It stays in the audit trail
          {row.source === 'import'
            ? ', and importing a file for this team again does not bring it back'
            : ''}
          .
        </p>
      </div>
    </Modal>
  );
}

RemoveDialog.propTypes = {
  row: PropTypes.object.isRequired,
  label: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
  onConfirm: PropTypes.func.isRequired,
  busy: PropTypes.bool.isRequired,
};

/**
 * The admin view of the practice preference rules (Phase D C2): four tabs. **Pending musts** (a
 * must a file asked for waits as a prefer until accepted, one at a time with the impact preview, or
 * a file's musts together with Accept all); **Rules** (every rule in force, filtered by team, coach,
 * level and priority, with Edit and Remove); **Conflicts** (musts no practice can meet together);
 * **Import** (a preference file, previewed before it is applied).
 *
 * A completed season is read-only: every control that writes is off and the page says why; the
 * database refuses the writes as well (22023 `season_completed`).
 */
export default function AdminPreferenceReview({ orgId, toast }) {
  const { currentSeasonSetting } = useOrganization();
  const seasonId = currentSeasonSetting?.id ?? null;
  const readOnly = useSeasonReadOnly();
  const context = usePreferenceContext(orgId, seasonId);
  const { rows: allRows, loaded: rowsLoaded, error, refresh } = useCoachPracticePreferences(orgId);
  const [tabChoice, setTabChoice] = useState(/** @type {string | null} */ (null));
  const [dialog, setDialog] = useState(/** @type {any} */ (null));
  const [busyId, setBusyId] = useState(/** @type {string | null} */ (null));
  // Two days, each the one its reader uses: the Add dialog's "coaches today" is the database's day (what
  // the RPC checks); a preview judges on the auto-scheduler's run date.
  const timeZone = currentSeasonSetting?.timezone ?? null;
  const today = useMemo(() => databaseIsoDate(), []);
  const date = useMemo(() => previewRunDate(new Date(), timeZone), [timeZone]);

  const coachNames = useMemo(
    () => new Map(context.coaches.map((coach) => [String(coach.id), coach.full_name])),
    [context.coaches]
  );
  const teamNames = useMemo(
    () => new Map(context.teams.map((team) => [String(team.id), team.name])),
    [context.teams]
  );
  const locationNames = useMemo(
    () => new Map(context.locations.map((location) => [String(location.id), location.name])),
    [context.locations]
  );
  const coachName = useCallback(
    (coachId) => coachNames.get(String(coachId)) ?? `Coach ${coachId}`,
    [coachNames]
  );
  const teamName = useCallback(
    (teamId) => teamNames.get(String(teamId)) ?? `Team ${teamId}`,
    [teamNames]
  );
  // The table has no season of its own: a rule is the season's through its coach (coaches belong to
  // one season, 20261108010000), so another season's rules are not listed or actionable. Until the
  // season's coaches are read there is nothing to match against.
  const rows = useMemo(
    () => allRows.filter((row) => coachNames.has(String(row.coach_id))),
    [allRows, coachNames]
  );
  const inForce = useMemo(() => rows.filter((row) => row.status === 'in_force'), [rows]);
  const pending = useMemo(
    () => inForce.filter((row) => row.must_decision === 'pending'),
    [inForce]
  );
  const jobIds = useMemo(
    () =>
      pending
        .map((row) => row.import_job_id)
        .filter(Boolean)
        .map(String),
    [pending]
  );
  const jobLabels = useImportJobLabels(orgId, jobIds);
  const groups = useMemo(
    () => groupPendingMusts(pending, jobLabels.labels, coachName),
    [pending, jobLabels.labels, coachName]
  );
  const rowById = useMemo(() => new Map(allRows.map((row) => [String(row.id), row])), [allRows]);

  const previewContext = useMemo(
    () => ({
      ruleRows: allRows,
      rosterRows: context.rosterRows,
      practiceRows: context.practiceRows,
      teamNames,
      locationNames,
      loadError: context.previewError,
    }),
    [allRows, context, teamNames, locationNames]
  );

  // The conflicts among the musts in force, from core. A data load that failed is a check that
  // could not run, and the view says that, never "no conflicts".
  const conflicts = useMemo(() => {
    if (context.loading || context.previewError) return { checkError: context.previewError };
    try {
      return {
        result: findMustConflicts({
          ruleRows: inForce,
          rosterRows: context.rosterRows,
          practiceRows: context.practiceRows,
          date,
        }),
      };
    } catch (err) {
      return { checkError: err };
    }
  }, [context, inForce, date]);
  const conflictCount = conflicts.result?.conflicts.length ?? 0;

  /** The teams a coach coaches today, with their names. */
  const teamsOf = useCallback(
    (coachId) => {
      const ids = new Set(
        context.rosterRows
          .filter(
            (row) =>
              String(row.coach_id) === String(coachId) &&
              row.effective_from <= today &&
              (row.effective_to == null || row.effective_to >= today)
          )
          .map((row) => String(row.team_id))
      );
      return [...ids]
        .map((id) => ({ id, name: teamName(id) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    [context.rosterRows, today, teamName]
  );
  const sortedCoaches = useMemo(
    () =>
      [...context.coaches].sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))),
    [context.coaches]
  );

  /** Run one write on a rule: toast what happened, refresh the list; true when it succeeded. */
  const act = async (row, work, success, failure) => {
    setBusyId(row.id);
    try {
      await work();
      toast(success, 'success');
      await refresh();
      return true;
    } catch (err) {
      toast(err?.message || failure, 'warning');
      return false;
    } finally {
      setBusyId(null);
    }
  };
  const keepPrefer = (row) =>
    act(
      row,
      () => decideMustPreference({ row, decision: 'keep_prefer' }),
      'Kept as prefer',
      'The decision failed'
    );
  const remove = async (row) => {
    const removed = await act(
      row,
      () => removePracticePreference(row),
      'Rule removed',
      'The rule could not be removed'
    );
    // A refusal keeps the dialog open beside its message, so the admin sees which rule it was.
    if (removed) setDialog(null);
  };

  if (context.loading) {
    return <p className="text-sm text-text-muted">Loading practice preference rules…</p>;
  }

  const ruleLabel = (row) =>
    `${coachName(row.coach_id)}'s rule for ${teamName(row.team_id)}: ${describeRule(row, locationNames)}`;
  const tab = tabChoice ?? (pending.length > 0 ? 'pending' : 'rules');
  const tabs = [
    {
      id: 'pending',
      label: 'Pending musts',
      badge: pending.length > 0 ? <Badge tone="warning">{pending.length}</Badge> : null,
    },
    { id: 'rules', label: 'Rules' },
    {
      id: 'conflicts',
      label: 'Conflicts',
      badge: conflictCount > 0 ? <Badge tone="danger">{conflictCount}</Badge> : null,
    },
    { id: 'import', label: 'Import a file' },
  ];
  const acceptAllGroup =
    dialog?.mode === 'acceptAll'
      ? (groups.find((group) => group.jobId === dialog.jobId) ?? {
          jobId: dialog.jobId,
          rows: [],
          fileName: null,
          importedOn: null,
        })
      : null;
  const seasonIsActive = currentSeasonSetting?.status === 'active';

  return (
    <div className="flex flex-col gap-4" data-testid="admin-preferences-view">
      <SeasonReadOnlyNote>
        This season is completed and read-only: its practice preferences cannot be imported,
        decided, added, edited or removed. Choose the active season in the header to make changes.
      </SeasonReadOnlyNote>
      <PreferencesLoadError error={error} />
      {context.error && (
        <DataErrorBanner
          message={`Could not load coaches or locations: ${context.error.message || 'unknown error'}.`}
        />
      )}
      {jobLabels.error && (
        <DataErrorBanner
          message={`Could not read the import files the pending musts came from (${jobLabels.error.message || 'unknown error'}); they are named by date.`}
        />
      )}
      {/* Only the first read waits: a refresh keeps the tabs, and what a panel holds, in place. */}
      {!error && rowsLoaded && (
        <>
          <Tabs
            tabs={tabs}
            activeTab={tab}
            onChange={setTabChoice}
            label="Practice preference views"
            panelId={PANEL_ID}
          />
          <div
            id={PANEL_ID}
            role="tabpanel"
            aria-label={tabs.find((item) => item.id === tab)?.label}
          >
            {tab === 'pending' && (
              <section aria-labelledby="admin-pref-pending-heading">
                <h2
                  id="admin-pref-pending-heading"
                  className="text-base font-bold text-text-primary mb-3"
                >
                  Pending musts ({pending.length})
                </h2>
                <PendingMusts
                  groups={groups}
                  coachName={coachName}
                  teamName={teamName}
                  locationNames={locationNames}
                  readOnly={readOnly}
                  busyId={busyId}
                  onAccept={(row) => setDialog({ mode: 'accept', row })}
                  onKeepPrefer={keepPrefer}
                  onAcceptAll={(jobId) => setDialog({ mode: 'acceptAll', jobId })}
                />
              </section>
            )}

            {tab === 'rules' && (
              <section aria-labelledby="admin-pref-current-heading">
                <h2
                  id="admin-pref-current-heading"
                  className="text-base font-bold text-text-primary mb-3"
                >
                  Rules in force ({inForce.length})
                </h2>
                <RulesList
                  rows={inForce}
                  coachName={coachName}
                  teamName={teamName}
                  locationNames={locationNames}
                  readOnly={readOnly}
                  busyId={busyId}
                  rosterRows={context.previewError ? null : context.rosterRows}
                  date={date}
                  onAdd={() => setDialog({ mode: 'add' })}
                  onEdit={(row) => setDialog({ mode: 'edit', row })}
                  onRemove={(row) => setDialog({ mode: 'remove', row })}
                />
              </section>
            )}

            {tab === 'conflicts' && (
              <section aria-labelledby="admin-pref-conflicts-heading">
                <h2
                  id="admin-pref-conflicts-heading"
                  className="text-base font-bold text-text-primary mb-3"
                >
                  Conflicts ({conflictCount})
                </h2>
                <ConflictsView
                  result={conflicts.result ?? { teamsExamined: [], conflicts: [], unreadable: [] }}
                  checkError={conflicts.checkError}
                  rowById={rowById}
                  coachName={coachName}
                  teamName={teamName}
                  locationNames={locationNames}
                  readOnly={readOnly}
                  busyId={busyId}
                  onEdit={(row) => setDialog({ mode: 'edit', row })}
                  onRemove={(row) => setDialog({ mode: 'remove', row })}
                />
              </section>
            )}

            {tab === 'import' && (
              <section aria-labelledby="admin-pref-import-heading">
                <h2
                  id="admin-pref-import-heading"
                  className="text-base font-bold text-text-primary mb-3"
                >
                  Import a preference file
                </h2>
                <PreferenceImportPanel
                  orgId={orgId}
                  seasonId={seasonId ?? ''}
                  seasonIsActive={seasonIsActive}
                  readOnly={readOnly || !seasonId}
                  context={context}
                  ruleRows={allRows}
                  onImported={refresh}
                  onReviewMusts={() => setTabChoice('pending')}
                />
              </section>
            )}
          </div>
        </>
      )}

      {dialog?.mode === 'accept' && (
        <AcceptMustDialog
          key={`accept-${dialog.row.id}`}
          row={dialog.row}
          coachName={coachName(dialog.row.coach_id)}
          teamName={teamName(dialog.row.team_id)}
          previewContext={previewContext}
          date={date}
          onClose={() => setDialog(null)}
          onDone={refresh}
          toast={toast}
        />
      )}
      {acceptAllGroup && (
        <AcceptAllDialog
          key={`accept-all-${dialog.jobId}`}
          group={acceptAllGroup}
          ruleRows={allRows}
          rosterRows={context.rosterRows}
          practiceRows={context.practiceRows}
          date={date}
          previewError={context.previewError}
          coachName={coachName}
          teamName={teamName}
          locationNames={locationNames}
          onClose={() => setDialog(null)}
          onRefresh={refresh}
          toast={toast}
        />
      )}
      {(dialog?.mode === 'add' || dialog?.mode === 'edit') && (
        <RuleDialog
          key={dialog.mode === 'edit' ? `edit-${dialog.row.id}` : 'add'}
          row={dialog.mode === 'edit' ? dialog.row : null}
          coaches={sortedCoaches}
          teamsOf={teamsOf}
          locations={context.locations}
          previewContext={previewContext}
          date={date}
          coachName={coachName}
          teamName={teamName}
          onClose={() => setDialog(null)}
          onDone={refresh}
          toast={toast}
        />
      )}
      {dialog?.mode === 'remove' && (
        <RemoveDialog
          key={`remove-${dialog.row.id}`}
          row={dialog.row}
          label={ruleLabel(dialog.row)}
          busy={busyId === dialog.row.id}
          onClose={() => setDialog(null)}
          onConfirm={() => remove(dialog.row)}
        />
      )}
    </div>
  );
}

AdminPreferenceReview.propTypes = {
  orgId: PropTypes.string.isRequired,
  toast: PropTypes.func.isRequired,
};
