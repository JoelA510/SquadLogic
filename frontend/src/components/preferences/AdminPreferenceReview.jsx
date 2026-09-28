import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import Modal from '../ui/Modal.jsx';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import { supabase } from '../../lib/supabaseClient.js';
import { fetchAllPages } from '../../lib/pagedFetch.js';
import { logger } from '../../lib/logger.js';
import {
  decideCoachPreference,
  setCoachPreference,
  useCoachPracticePreferences,
} from '../../hooks/useCoachPracticePreferences.js';
import {
  DIMENSION_LABEL,
  LEVEL_LABEL,
  formatPreferenceValue,
  localIsoDate,
} from '../../utils/coachPreferencePreview.js';
import {
  LevelSelect,
  PreferenceValueField,
  PreferencesLoadError,
  StatusBadge,
} from './PreferenceFields.jsx';
import MustKeepPreview from './MustKeepPreview.jsx';

const DIMENSIONS = ['weekday', 'start_time', 'venue'];

/**
 * Load what the dialogs need beyond the preference rows: coach names, the
 * org's locations, the roster (`team_coach_assignments`, paged -- the history
 * only grows), team names, and the current practice series with their slots.
 */
/**
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

function useReviewContext(orgId) {
  const [state, setState] = useState(LOADING_CONTEXT);

  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    (async () => {
      // An org switch must not leave the previous org's coaches actionable (a
      // "Set" on one would write to that org) or feed its roster to the preview.
      setState(LOADING_CONTEXT);
      const [coachResult, locationResult] = await Promise.all([
        supabase.from('coaches').select('id, full_name').eq('organization_id', orgId),
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
  }, [orgId]);

  return state;
}

/**
 * Approve, approve-with-change, or set directly. Every mode shows the re-judge
 * for the preference as it would be in force after the decision.
 */
function DecisionDialog({
  dialog,
  coachName,
  locations,
  previewContext,
  date,
  onClose,
  onDone,
  toast,
}) {
  const { mode, row, coachId } = dialog;
  const [dimension, setDimension] = useState(row?.dimension ?? 'weekday');
  const [level, setLevel] = useState(row?.level ?? 'prefer_keep');
  const [value, setValue] = useState(row ? (row.value ?? null) : null);
  const [busy, setBusy] = useState(false);
  const editable = mode !== 'approve';
  const locationNames = previewContext.locationNames;

  const proposal = useMemo(
    () => ({ coachId, dimension, level, value: level === 'dont_care' ? null : value }),
    [coachId, dimension, level, value]
  );

  const title =
    mode === 'approve'
      ? 'Approve request'
      : mode === 'change'
        ? 'Approve with change'
        : 'Set preference directly';

  const confirm = async () => {
    setBusy(true);
    try {
      if (mode === 'approve') {
        await decideCoachPreference({ row, decision: 'approve' });
        toast('Request approved', 'success');
      } else if (mode === 'change') {
        await decideCoachPreference({
          row,
          decision: 'approve',
          change: { level: proposal.level, value: proposal.value },
        });
        toast('Request approved with change', 'success');
      } else {
        await setCoachPreference(proposal);
        toast('Preference set', 'success');
      }
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
      title={title}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} loading={busy} disabled={busy}>
            {mode === 'set' ? 'Set preference' : title}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm m-0">
          Coach: <strong>{coachName}</strong>
        </p>
        {row && (
          <p className="text-sm m-0">
            Requested: {DIMENSION_LABEL[row.dimension]} · {LEVEL_LABEL[row.level]} ·{' '}
            {formatPreferenceValue(row.dimension, row.value, locationNames)}
          </p>
        )}
        {mode === 'set' && (
          <div className="field">
            <label htmlFor="decision-dimension">Dimension</label>
            <select
              id="decision-dimension"
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
        )}
        {editable && (
          <div className="grid gap-4 md:grid-cols-2">
            <LevelSelect id="decision-level" value={level} onChange={setLevel} />
            <PreferenceValueField
              id="decision-value"
              dimension={/** @type {any} */ (dimension)}
              value={value}
              onChange={setValue}
              locations={locations}
              disabled={level === 'dont_care'}
            />
          </div>
        )}
        <MustKeepPreview proposal={proposal} context={previewContext} date={date} />
      </div>
    </Modal>
  );
}

DecisionDialog.propTypes = {
  dialog: PropTypes.shape({
    mode: PropTypes.oneOf(['approve', 'change', 'set']).isRequired,
    row: PropTypes.object,
    coachId: PropTypes.string.isRequired,
  }).isRequired,
  coachName: PropTypes.string.isRequired,
  locations: PropTypes.array.isRequired,
  previewContext: PropTypes.object.isRequired,
  date: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func.isRequired,
  toast: PropTypes.func.isRequired,
};

/**
 * The admin view: pending requests (approve, reject, approve with change) and
 * each coach's preferences in force (set directly).
 */
export default function AdminPreferenceReview({ orgId, toast }) {
  const context = useReviewContext(orgId);
  const { rows, loading, error, refresh } = useCoachPracticePreferences(orgId);
  const [dialog, setDialog] = useState(/** @type {any} */ (null));
  const [busyId, setBusyId] = useState(/** @type {string|null} */ (null));
  const date = useMemo(() => localIsoDate(), []);

  const coachNames = useMemo(
    () => new Map(context.coaches.map((coach) => [String(coach.id), coach.full_name])),
    [context.coaches]
  );
  const locationNames = useMemo(
    () => new Map(context.locations.map((location) => [String(location.id), location.name])),
    [context.locations]
  );
  const coachName = useCallback(
    (coachId) => coachNames.get(String(coachId)) ?? `Coach ${coachId}`,
    [coachNames]
  );
  const approvedRows = useMemo(() => rows.filter((row) => row.status === 'approved'), [rows]);
  const pending = rows.filter((row) => row.status === 'requested');

  const previewContext = useMemo(
    () => ({
      approvedRows,
      rosterRows: context.rosterRows,
      practiceRows: context.practiceRows,
      teamNames: new Map(context.teams.map((team) => [String(team.id), team.name])),
      locationNames,
      loadError: context.previewError,
    }),
    [approvedRows, context, locationNames]
  );

  const reject = async (row) => {
    setBusyId(row.id);
    try {
      await decideCoachPreference({ row, decision: 'reject' });
      toast('Request rejected', 'success');
      await refresh();
    } catch (err) {
      toast(err?.message || 'The rejection failed', 'warning');
    } finally {
      setBusyId(null);
    }
  };

  if (context.loading) {
    return <p className="text-sm text-text-muted">Loading coach practice preferences…</p>;
  }

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
              Pending requests ({pending.length})
            </h2>
            {pending.length === 0 ? (
              <p className="text-sm text-text-muted m-0">No pending requests.</p>
            ) : (
              <div className="grid-wrap">
                <table className="grid">
                  <caption className="sr-only">Pending coach practice preference requests</caption>
                  <thead>
                    <tr>
                      <th scope="col">Coach</th>
                      <th scope="col">Dimension</th>
                      <th scope="col">Level</th>
                      <th scope="col">Value</th>
                      <th scope="col">Requested</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((row) => {
                      const name = coachName(row.coach_id);
                      const what = `${name}'s ${DIMENSION_LABEL[row.dimension].toLowerCase()} request`;
                      return (
                        <tr key={row.id}>
                          <td>{name}</td>
                          <td>{DIMENSION_LABEL[row.dimension]}</td>
                          <td>{LEVEL_LABEL[row.level]}</td>
                          <td>{formatPreferenceValue(row.dimension, row.value, locationNames)}</td>
                          <td>{new Date(row.requested_at).toLocaleDateString()}</td>
                          <td>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={busyId === row.id}
                                aria-label={`Approve ${what}`}
                                onClick={() =>
                                  setDialog({ mode: 'approve', row, coachId: String(row.coach_id) })
                                }
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busyId === row.id}
                                aria-label={`Approve ${what} with a change`}
                                onClick={() =>
                                  setDialog({ mode: 'change', row, coachId: String(row.coach_id) })
                                }
                              >
                                Change
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost-danger"
                                disabled={busyId === row.id}
                                loading={busyId === row.id}
                                aria-label={`Reject ${what}`}
                                onClick={() => reject(row)}
                              >
                                Reject
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
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
              Current preferences by coach
            </h2>
            {context.coaches.length === 0 ? (
              <p className="text-sm text-text-muted m-0">No coaches in this organization.</p>
            ) : (
              <div className="grid-wrap">
                <table className="grid">
                  <caption className="sr-only">Approved practice preferences per coach</caption>
                  <thead>
                    <tr>
                      <th scope="col">Coach</th>
                      {DIMENSIONS.map((dimension) => (
                        <th key={dimension} scope="col">
                          {DIMENSION_LABEL[dimension]}
                        </th>
                      ))}
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {context.coaches.map((coach) => {
                      const id = String(coach.id);
                      return (
                        <tr key={id}>
                          <td>{coach.full_name}</td>
                          {DIMENSIONS.map((dimension) => {
                            const held = approvedRows.find(
                              (row) => String(row.coach_id) === id && row.dimension === dimension
                            );
                            return (
                              <td key={dimension}>
                                {held ? (
                                  <span className="flex flex-col gap-1">
                                    <span>
                                      {LEVEL_LABEL[held.level]} ·{' '}
                                      {formatPreferenceValue(dimension, held.value, locationNames)}
                                    </span>
                                    <StatusBadge status={held.status} />
                                  </span>
                                ) : (
                                  <span className="text-text-muted">Don&apos;t care</span>
                                )}
                              </td>
                            );
                          })}
                          <td>
                            <Button
                              size="sm"
                              variant="secondary"
                              aria-label={`Set a preference for ${coach.full_name}`}
                              onClick={() => setDialog({ mode: 'set', row: null, coachId: id })}
                            >
                              Set…
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {dialog && (
        <DecisionDialog
          key={`${dialog.mode}-${dialog.row?.id ?? dialog.coachId}`}
          dialog={dialog}
          coachName={coachName(dialog.coachId)}
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
