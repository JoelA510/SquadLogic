import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import { supabase } from '../../lib/supabaseClient.js';
import { logger } from '../../lib/logger.js';
import {
  requestCoachPreference,
  useCoachPracticePreferences,
} from '../../hooks/useCoachPracticePreferences.js';
import {
  DIMENSION_LABEL,
  LEVEL_LABEL,
  formatPreferenceValue,
} from '../../utils/coachPreferencePreview.js';
import {
  LevelSelect,
  PreferenceValueField,
  PreferencesLoadError,
  StatusBadge,
} from './PreferenceFields.jsx';

const DIMENSIONS = ['weekday', 'start_time', 'venue'];

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString() : '';
}

/** One dimension's request form. Coaches request; nothing here approves. */
function RequestForm({ dimension, locations, disabled, onSubmit }) {
  const [level, setLevel] = useState('prefer_keep');
  const [value, setValue] = useState(/** @type {string|number|null} */ (null));
  const [busy, setBusy] = useState(false);
  const idBase = `request-${dimension}`;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const ok = await onSubmit({ dimension, level, value: level === 'dont_care' ? null : value });
      if (ok) setValue(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card" aria-labelledby={`${idBase}-legend`}>
      <fieldset className="card-body flex flex-col gap-3 border-0 m-0">
        <legend id={`${idBase}-legend`} className="font-semibold text-text-primary">
          {DIMENSION_LABEL[dimension]}
        </legend>
        <LevelSelect id={`${idBase}-level`} value={level} onChange={setLevel} disabled={disabled} />
        <PreferenceValueField
          id={`${idBase}-value`}
          dimension={dimension}
          value={value}
          onChange={setValue}
          locations={locations}
          disabled={disabled || level === 'dont_care'}
        />
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={disabled} loading={busy}>
            Request {DIMENSION_LABEL[dimension].toLowerCase()} preference
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

RequestForm.propTypes = {
  dimension: PropTypes.string.isRequired,
  locations: PropTypes.array.isRequired,
  disabled: PropTypes.bool.isRequired,
  onSubmit: PropTypes.func.isRequired,
};

function PreferenceTable({ caption, rows, locationNames, emptyText, dateColumn }) {
  if (rows.length === 0) {
    return <p className="text-sm text-text-muted m-0">{emptyText}</p>;
  }
  return (
    <div className="grid-wrap">
      <table className="grid">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Dimension</th>
            <th scope="col">Level</th>
            <th scope="col">Value</th>
            <th scope="col">Status</th>
            <th scope="col">{dateColumn.label}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{DIMENSION_LABEL[row.dimension] || row.dimension}</td>
              <td>{LEVEL_LABEL[row.level] || row.level}</td>
              <td>{formatPreferenceValue(row.dimension, row.value, locationNames)}</td>
              <td>
                <StatusBadge status={row.status} />
              </td>
              <td>{formatDate(row[dateColumn.key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

PreferenceTable.propTypes = {
  caption: PropTypes.string.isRequired,
  rows: PropTypes.array.isRequired,
  locationNames: PropTypes.instanceOf(Map).isRequired,
  emptyText: PropTypes.string.isRequired,
  dateColumn: PropTypes.shape({ key: PropTypes.string, label: PropTypes.string }).isRequired,
};

/**
 * The coach's own view: preferences in force, pending requests, history, and a
 * request form per dimension. Deliberately has no decision controls: only an
 * admin decides, and the decide RPC refuses anyone else anyway.
 */
export default function CoachPreferenceRequests({ orgId, userId, toast }) {
  const [coach, setCoach] = useState(/** @type {any} */ (null));
  const [coachState, setCoachState] = useState({ loading: true, error: null });
  const [locations, setLocations] = useState([]);

  useEffect(() => {
    if (!orgId || !userId) return undefined;
    let cancelled = false;
    (async () => {
      setCoachState({ loading: true, error: null });
      const [coachResult, locationResult] = await Promise.all([
        supabase
          .from('coaches')
          .select('id, full_name')
          .eq('organization_id', orgId)
          .eq('user_id', userId),
        supabase.from('locations').select('id, name').eq('organization_id', orgId),
      ]);
      if (cancelled) return;
      if (coachResult.error || locationResult.error) {
        const error = coachResult.error || locationResult.error;
        logger.error('Failed to load coach record or locations', error);
        setCoachState({ loading: false, error });
        return;
      }
      setCoach((coachResult.data || [])[0] ?? null);
      setLocations(locationResult.data || []);
      setCoachState({ loading: false, error: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, userId]);

  const coachId = coach ? String(coach.id) : null;
  const { rows, loading, error, refresh } = useCoachPracticePreferences(orgId, {
    coachId,
    enabled: Boolean(coachId),
  });

  const locationNames = useMemo(
    () => new Map(locations.map((location) => [String(location.id), location.name])),
    [locations]
  );
  const inForce = rows.filter((row) => row.status === 'approved');
  const pending = rows.filter((row) => row.status === 'requested');
  const history = rows.filter((row) => row.status === 'rejected' || row.status === 'superseded');

  const submit = async ({ dimension, level, value }) => {
    try {
      await requestCoachPreference({ coachId, dimension, level, value });
      toast(`${DIMENSION_LABEL[dimension]} request sent for admin review`, 'success');
      await refresh();
      return true;
    } catch (err) {
      toast(err?.message || 'The request failed', 'warning');
      return false;
    }
  };

  if (coachState.loading) {
    return <p className="text-sm text-text-muted">Loading your coach record…</p>;
  }
  if (coachState.error) {
    return (
      <DataErrorBanner
        message={`Could not load your coach record: ${coachState.error.message || 'unknown error'}.`}
      />
    );
  }
  if (!coach) {
    return (
      <div className="empty" role="status">
        Your account is not linked to a coach record in this organization, so there are no practice
        preferences to show. Ask an admin to link it.
      </div>
    );
  }

  const blocked = Boolean(error) || loading;
  return (
    <div className="flex flex-col gap-6" data-testid="coach-preferences-view">
      <PreferencesLoadError error={error} />
      <section aria-labelledby="coach-pref-request-heading">
        <h2 id="coach-pref-request-heading" className="text-base font-bold text-text-primary mb-1">
          Request a change
        </h2>
        <p className="text-sm text-text-muted mb-3">
          A request is not in force until an admin approves it. An admin may approve it with a
          different level or value.
        </p>
        <div className="grid gap-4 md:grid-cols-3">
          {DIMENSIONS.map((dimension) => (
            <RequestForm
              key={dimension}
              dimension={dimension}
              locations={locations}
              disabled={blocked}
              onSubmit={submit}
            />
          ))}
        </div>
      </section>
      {!error && (
        <>
          <section aria-labelledby="coach-pref-current-heading">
            <h2
              id="coach-pref-current-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              In force
            </h2>
            <PreferenceTable
              caption="Your approved practice preferences"
              rows={inForce}
              locationNames={locationNames}
              emptyText="No approved preferences: every dimension is Don't care."
              dateColumn={{ key: 'effective_from', label: 'In force since' }}
            />
          </section>
          <section aria-labelledby="coach-pref-pending-heading">
            <h2
              id="coach-pref-pending-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              Pending requests
            </h2>
            <PreferenceTable
              caption="Your pending requests"
              rows={pending}
              locationNames={locationNames}
              emptyText="No pending requests."
              dateColumn={{ key: 'requested_at', label: 'Requested' }}
            />
          </section>
          <section aria-labelledby="coach-pref-history-heading">
            <h2
              id="coach-pref-history-heading"
              className="text-base font-bold text-text-primary mb-3"
            >
              History
            </h2>
            <PreferenceTable
              caption="Your rejected and superseded preferences"
              rows={history}
              locationNames={locationNames}
              emptyText="No history yet."
              dateColumn={{ key: 'decided_at', label: 'Decided' }}
            />
          </section>
        </>
      )}
    </div>
  );
}

CoachPreferenceRequests.propTypes = {
  orgId: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  toast: PropTypes.func.isRequired,
};
