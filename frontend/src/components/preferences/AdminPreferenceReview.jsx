import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import Modal from '../ui/Modal.jsx';
import Badge from '../ui/Badge.jsx';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import { supabase } from '../../lib/supabaseClient.js';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { fetchAllPages } from '../../lib/pagedFetch.js';
import { logger } from '../../lib/logger.js';
import {
  addPracticePreference,
  decideMustPreference,
  removePracticePreference,
  useCoachPracticePreferences,
} from '../../hooks/useCoachPracticePreferences.js';
import {
  DIMENSION_LABEL,
  LEVEL_LABEL,
  describeRule,
  localIsoDate,
  ruleOfRow,
} from '../../utils/coachPreferencePreview.js';
import {
  DecisionBadge,
  LevelSelect,
  PreferenceValueField,
  PreferencesLoadError,
} from './PreferenceFields.jsx';
import MustKeepPreview from './MustKeepPreview.jsx';

const DIMENSIONS = ['weekday', 'start_time', 'venue'];

/** What one condition of a rule is called in the core shape. */
const RULE_FIELDS = {
  weekday: ['weekdays', 'keepWeekday'],
  start_time: ['startMinutes', 'keepStart'],
  venue: ['venueIds', 'keepVenue'],
};

/**
 * Load what the dialogs need beyond the rule rows: coach names, the org's locations, the roster
 * (`team_coach_assignments`, paged -- the history only grows), team names, and the current practice
 * series with their slots.
 *
 * @type {Readonly<{ coaches: any[], locations: any[], rosterRows: any[], teams: any[],
 *   practiceRows: any[], error: any, previewError: any, loading: boolean }>}
 */
const LOADING_CONTEXT = Object.freeze({
  coaches: [],
  locations: [],
  rosterRows: [],
  teams: [],
  practiceRows: [],
  error: null,
  previewError: null,
  loading: true,
});

function useReviewContext(orgId, seasonId) {
  const [state, setState] = useState(LOADING_CONTEXT);

  useEffect(() => {
    if (!orgId || !seasonId) return undefined;
    let cancelled = false;
    (async () => {
      // An org switch must not leave the previous org's coaches actionable (an "Add" on one would
      // write to that org) or feed its roster to the preview.
      setState(LOADING_CONTEXT);
      const [coachResult, locationResult] = await Promise.all([
        // The coaches of the season the header shows (20261108010000).
        supabase
          .from('coaches')
          .select('id, full_name')
          .eq('organization_id', orgId)
          .eq('season_settings_id', seasonId),
        supabase.from('locations').select('id, name').eq('organization_id', orgId),
      ]);
      let previewError = null;
      let rosterRows = [];
      let teams = [];
      let practiceRows = [];
      try {
        [rosterRows, teams, practiceRows] = await Promise.all([
          fetchAllPages(() =>
            supabase
              .from('team_coach_assignments')
              .select('id, team_id, coach_id, role, effective_from, effective_to')
              .eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase.from('teams').select('id, name').eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase
              .from('practice_assignments')
              .select(
                'id, team_id, effective_date_range, slot:practice_slots!practice_slot_id (day_of_week, start_time, field:fields (location_id))'
              )
              .eq('organization_id', orgId)
          ),
        ]);
      } catch (err) {
        logger.error('Failed to load the re-judge context', err);
        previewError = err || { message: 'unknown error' };
      }
      if (cancelled) return;
      const error = coachResult.error || locationResult.error || null;
      if (error) logger.error('Failed to load coaches or locations', error);
      setState({
        coaches: coachResult.data || [],
        locations: locationResult.data || [],
        rosterRows,
        teams,
        practiceRows,
        error,
        previewError,
        loading: false,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, seasonId]);

  return state;
}

/** The rule a dialog proposes, in core's shape (one condition, one value or keep-current). */
function ruleOf({ coachId, teamId, level, dimension, value }) {
  const [values, keep] = RULE_FIELDS[dimension];
  return {
    coachId,
    teamId,
    level,
    [values]: value === null ? null : [value],
    [keep]: value === null,
  };
}

/** Accept a requested must, with the re-judge of what it would break. */
function AcceptDialog({ row, coachName, teamName, previewContext, date, onClose, onDone, toast }) {
  const [busy, setBusy] = useState(false);
  // A row core cannot read says so (as the preview does for the others) instead of breaking the dialog.
  const proposal = useMemo(() => {
    try {
      return { rule: { ...ruleOfRow(row), level: 'must' }, error: null };
    } catch (err) {
      return { rule: null, error: err?.message || String(err) };
    }
  }, [row]);

  const confirm = async () => {
    setBusy(true);
    try {
      await decideMustPreference({ row, decision: 'accept' });
      toast('Accepted as a must', 'success');
      await onDone();
      onClose();
    } catch (err) {
      toast(err?.message || 'The decision failed', 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Accept as must"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} loading={busy} disabled={busy}>
            Accept as must
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm m-0">
          Coach: <strong>{coachName}</strong> · Team: <strong>{teamName}</strong>
        </p>
        <p className="text-sm m-0">
          Requested as a must: {describeRule(row, previewContext.locationNames)}
        </p>
        {proposal.error ? (
          <p role="alert" className="text-sm m-0">
            Could not re-judge this decision: {proposal.error}. Review the team&apos;s current
            series before accepting.
          </p>
        ) : (
          <MustKeepPreview proposal={proposal.rule} context={previewContext} date={date} />
        )}
      </div>
    </Modal>
  );
}

AcceptDialog.propTypes = {
  row: PropTypes.object.isRequired,
  coachName: PropTypes.string.isRequired,
  teamName: PropTypes.string.isRequired,
  previewContext: PropTypes.object.isRequired,
  date: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func.isRequired,
  toast: PropTypes.func.isRequired,
};

/** Add a rule for a coach's team: one condition with one value (or keep-current). */
function AddDialog({
  coachId,
  coachName,
  teams,
  locations,
  previewContext,
  date,
  onClose,
  onDone,
  toast,
}) {
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '');
  const [dimension, setDimension] = useState('weekday');
  const [level, setLevel] = useState('prefer');
  const [value, setValue] = useState(null);
  const [busy, setBusy] = useState(false);

  const rule = useMemo(
    () => ruleOf({ coachId, teamId, level, dimension, value }),
    [coachId, teamId, level, dimension, value]
  );
  const proposal = useMemo(() => ({ id: 'new', ...rule }), [rule]);

  const confirm = async () => {
    setBusy(true);
    try {
      await addPracticePreference(rule);
      toast('Rule added', 'success');
      await onDone();
      onClose();
    } catch (err) {
      toast(err?.message || 'The rule could not be added', 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a rule"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} loading={busy} disabled={busy || !teamId}>
            Add rule
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm m-0">
          Coach: <strong>{coachName}</strong>
        </p>
        {teams.length === 0 ? (
          <p className="text-sm m-0">
            This coach coaches no team today, so there is nothing to add a rule to.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="add-team">Team</label>
              <select
                id="add-team"
                className="select"
                value={teamId}
                onChange={(event) => setTeamId(event.target.value)}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="add-dimension">Dimension</label>
              <select
                id="add-dimension"
                className="select"
                value={dimension}
                onChange={(event) => {
                  setDimension(event.target.value);
                  setValue(null);
                }}
              >
                {DIMENSIONS.map((item) => (
                  <option key={item} value={item}>
                    {DIMENSION_LABEL[item]}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <LevelSelect id="add-level" value={level} onChange={setLevel} />
              <PreferenceValueField
                id="add-value"
                dimension={/** @type {any} */ (dimension)}
                value={value}
                onChange={setValue}
                locations={locations}
              />
            </div>
            <MustKeepPreview proposal={proposal} context={previewContext} date={date} />
          </>
        )}
      </div>
    </Modal>
  );
}

AddDialog.propTypes = {
  coachId: PropTypes.string.isRequired,
  coachName: PropTypes.string.isRequired,
  teams: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string, name: PropTypes.string }))
    .isRequired,
  locations: PropTypes.array.isRequired,
  previewContext: PropTypes.object.isRequired,
  date: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func.isRequired,
  toast: PropTypes.func.isRequired,
};

/**
 * The admin view: the requested musts waiting for a decision (accept, or keep as prefer), the rules
 * in force, and adding a rule for a coach's team. Preferences arrive by an admin's import (Phase D
 * C2 builds that screen); until then a rule is added here, one condition at a time.
 */
export default function AdminPreferenceReview({ orgId, toast }) {
  const { currentSeasonSetting } = useOrganization();
  const context = useReviewContext(orgId, currentSeasonSetting?.id ?? null);
  const {
    rows: allRows,
    loading: rowsLoading,
    error,
    refresh,
  } = useCoachPracticePreferences(orgId);
  const [dialog, setDialog] = useState(/** @type {any} */ (null));
  const [busyId, setBusyId] = useState(/** @type {string|null} */ (null));
  const date = useMemo(() => localIsoDate(), []);

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
  const loading = rowsLoading || context.loading;
  const inForce = useMemo(() => rows.filter((row) => row.status === 'in_force'), [rows]);
  const pending = inForce.filter((row) => row.must_decision === 'pending');

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

  /** The teams a coach coaches today, with their names. */
  const teamsOf = (coachId) => {
    const ids = new Set(
      context.rosterRows
        .filter(
          (row) =>
            String(row.coach_id) === String(coachId) &&
            row.effective_from <= date &&
            (row.effective_to == null || row.effective_to >= date)
        )
        .map((row) => String(row.team_id))
    );
    return [...ids]
      .map((id) => ({ id, name: teamName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const act = async (row, work, success, failure) => {
    setBusyId(row.id);
    try {
      await work();
      toast(success, 'success');
      await refresh();
    } catch (err) {
      toast(err?.message || failure, 'warning');
    } finally {
      setBusyId(null);
    }
  };

  if (context.loading) {
    return <p className="text-sm text-text-muted">Loading practice preference rules…</p>;
  }

  const ruleLabel = (row) =>
    `${coachName(row.coach_id)}'s rule for ${teamName(row.team_id)}: ${describeRule(row, locationNames)}`;

  return (
    <div className="flex flex-col gap-6" data-testid="admin-preferences-view">
      <PreferencesLoadError error={error} />
      {context.error && (
        <DataErrorBanner
          message={`Could not load coaches or locations: ${context.error.message || 'unknown error'}.`}
        />
      )}
      {!error && (rows.length > 0 || !loading) && (
        <>
          <section aria-labelledby="admin-pref-pending-heading">
            <h2
              id="admin-pref-pending-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              Pending musts ({pending.length})
            </h2>
            <p className="text-sm text-text-muted mt-0 mb-3">
              A must that was asked for counts as a prefer until you accept it.
            </p>
            {pending.length === 0 ? (
              <p className="text-sm text-text-muted m-0">No pending musts.</p>
            ) : (
              <div className="grid-wrap">
                <table className="grid">
                  <caption className="sr-only">
                    Practice preference musts waiting for a decision
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Coach</th>
                      <th scope="col">Team</th>
                      <th scope="col">Rule</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((row) => (
                      <tr key={row.id}>
                        <td>{coachName(row.coach_id)}</td>
                        <td>{teamName(row.team_id)}</td>
                        <td>{describeRule(row, locationNames)}</td>
                        <td>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={busyId === row.id}
                              aria-label={`Accept ${ruleLabel(row)} as a must`}
                              onClick={() => setDialog({ mode: 'accept', row })}
                            >
                              Accept as must
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busyId === row.id}
                              loading={busyId === row.id}
                              aria-label={`Keep ${ruleLabel(row)} as a prefer`}
                              onClick={() =>
                                act(
                                  row,
                                  () => decideMustPreference({ row, decision: 'keep_prefer' }),
                                  'Kept as prefer',
                                  'The decision failed'
                                )
                              }
                            >
                              Keep as prefer
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="admin-pref-current-heading">
            <h2
              id="admin-pref-current-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              Rules in force ({inForce.length})
            </h2>
            {inForce.length === 0 ? (
              <p className="text-sm text-text-muted m-0">No rules in force.</p>
            ) : (
              <div className="grid-wrap">
                <table className="grid">
                  <caption className="sr-only">Practice preference rules in force</caption>
                  <thead>
                    <tr>
                      <th scope="col">Coach</th>
                      <th scope="col">Team</th>
                      <th scope="col">Level</th>
                      <th scope="col">Rule</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inForce.map((row) => (
                      <tr key={row.id}>
                        <td>{coachName(row.coach_id)}</td>
                        <td>{teamName(row.team_id)}</td>
                        <td>
                          <span className="flex flex-col gap-1">
                            <span>{LEVEL_LABEL[row.level]}</span>
                            {row.must_decision && <DecisionBadge decision={row.must_decision} />}
                            {row.source === 'import' && <Badge tone="neutral">Imported</Badge>}
                          </span>
                        </td>
                        <td>{describeRule(row, locationNames)}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="ghost-danger"
                            disabled={busyId === row.id}
                            loading={busyId === row.id}
                            aria-label={`Remove ${ruleLabel(row)}`}
                            onClick={() =>
                              act(
                                row,
                                () => removePracticePreference(row),
                                'Rule removed',
                                'The rule could not be removed'
                              )
                            }
                          >
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="admin-pref-coaches-heading">
            <h2
              id="admin-pref-coaches-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              Add a rule
            </h2>
            {context.coaches.length === 0 ? (
              <p className="text-sm text-text-muted m-0">No coaches in this organization.</p>
            ) : (
              <div className="grid-wrap">
                <table className="grid">
                  <caption className="sr-only">Coaches of the season, to add a rule for</caption>
                  <thead>
                    <tr>
                      <th scope="col">Coach</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {context.coaches.map((coach) => (
                      <tr key={String(coach.id)}>
                        <td>{coach.full_name}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-label={`Add a rule for ${coach.full_name}`}
                            onClick={() => setDialog({ mode: 'add', coachId: String(coach.id) })}
                          >
                            Add…
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {dialog?.mode === 'accept' && (
        <AcceptDialog
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
      {dialog?.mode === 'add' && (
        <AddDialog
          key={`add-${dialog.coachId}`}
          coachId={dialog.coachId}
          coachName={coachName(dialog.coachId)}
          teams={teamsOf(dialog.coachId)}
          locations={context.locations}
          previewContext={previewContext}
          date={date}
          onClose={() => setDialog(null)}
          onDone={refresh}
          toast={toast}
        />
      )}
    </div>
  );
}

AdminPreferenceReview.propTypes = {
  orgId: PropTypes.string.isRequired,
  toast: PropTypes.func.isRequired,
};
