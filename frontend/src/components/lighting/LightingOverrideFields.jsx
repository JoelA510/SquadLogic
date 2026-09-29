import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Badge from '../ui/Badge.jsx';
import Button from '../ui/Button.jsx';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import { lightingOverrideErrorMessage, practiceSlotLabel } from '../../utils/lightingOverrides.js';

const STATUS_TONE = {
  requested: 'warning',
  approved: 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
};
const STATUS_LABEL = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export function LightingStatusBadge({ status }) {
  return <Badge tone={STATUS_TONE[status] || 'neutral'}>{STATUS_LABEL[status] || status}</Badge>;
}

LightingStatusBadge.propTypes = { status: PropTypes.string.isRequired };

/**
 * Declared, not enforced (plan default 4): an override has no lights-off time.
 * Rendered beside every approve and set action, which point at it with
 * `aria-describedby`.
 */
export function NoLightsOffNote({ id }) {
  return (
    <p id={id} className="text-sm text-text-muted m-0" data-testid="lighting-no-lights-off-note">
      <strong className="text-text-primary">No lights-off time.</strong> An approved override
      exempts every date in its window from the sunset check, for the whole slot and every team on
      it. Nothing records or checks when the portable lights go off: that is declared, not enforced.
    </p>
  );
}

NoLightsOffNote.propTypes = { id: PropTypes.string.isRequired };

/**
 * A write's outcome: failures are `role="alert"` with the database's message
 * (or the overlap explanation), successes `role="status"`. Focus moves to the
 * message after every action so a keyboard or screen-reader user hears it.
 */
export function ActionMessage({ outcome }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => {
    if (outcome) ref.current?.focus();
  }, [outcome]);
  if (!outcome) return null;
  if (outcome.error) {
    return (
      <div
        ref={ref}
        tabIndex={-1}
        role="alert"
        data-testid="lighting-action-error"
        className="text-sm text-status-error"
      >
        {lightingOverrideErrorMessage(outcome.error)}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      data-testid="lighting-action-status"
      className="text-sm text-text-secondary"
    >
      {outcome.message}
    </div>
  );
}

ActionMessage.propTypes = {
  outcome: PropTypes.shape({ error: PropTypes.object, message: PropTypes.string }),
};

/** The load-failure banner. Never an empty list in its place. */
export function LightingLoadError({ error, what }) {
  if (!error) return null;
  const detail = error.message ? `: ${error.message}` : '';
  return <DataErrorBanner message={`Could not load ${what}${detail}.`} />;
}

LightingLoadError.propTypes = {
  error: PropTypes.shape({ message: PropTypes.string, code: PropTypes.string }),
  what: PropTypes.string.isRequired,
};

/**
 * Slot + inclusive date window. `onSubmit` resolves to an outcome
 * (`{ error }` or `{ message }`); the form keeps its values on a failure so the
 * user can correct them, and clears the dates on success.
 */
export function OverrideWindowForm({
  idBase,
  legend,
  slots,
  fieldNames,
  submitLabel,
  onSubmit,
  disabled = false,
  describedBy = undefined,
}) {
  const [slotId, setSlotId] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(/** @type {any} */ (null));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await onSubmit({ slotId, from, until });
      setOutcome(result);
      if (!result?.error) {
        setFrom('');
        setUntil('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card" aria-labelledby={`${idBase}-legend`}>
      <fieldset className="card-body flex flex-col gap-3 border-0 m-0">
        <legend id={`${idBase}-legend`} className="font-semibold text-text-primary">
          {legend}
        </legend>
        <div className="field">
          <label htmlFor={`${idBase}-slot`}>Practice slot</label>
          <select
            id={`${idBase}-slot`}
            className="select"
            value={slotId}
            required
            disabled={disabled}
            onChange={(event) => setSlotId(event.target.value)}
          >
            <option value="">Choose a slot</option>
            {slots.map((slot) => (
              <option key={slot.id} value={String(slot.id)}>
                {practiceSlotLabel(slot, fieldNames)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="field">
            <label htmlFor={`${idBase}-from`}>First date</label>
            <input
              id={`${idBase}-from`}
              className="input"
              type="date"
              value={from}
              required
              disabled={disabled}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${idBase}-until`}>Last date (inclusive)</label>
            <input
              id={`${idBase}-until`}
              className="input"
              type="date"
              value={until}
              min={from || undefined}
              required
              disabled={disabled}
              onChange={(event) => setUntil(event.target.value)}
            />
          </div>
        </div>
        <div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={disabled}
            loading={busy}
            aria-describedby={describedBy}
          >
            {submitLabel}
          </Button>
        </div>
        <ActionMessage outcome={outcome} />
      </fieldset>
    </form>
  );
}

OverrideWindowForm.propTypes = {
  idBase: PropTypes.string.isRequired,
  legend: PropTypes.string.isRequired,
  slots: PropTypes.array.isRequired,
  fieldNames: PropTypes.instanceOf(Map).isRequired,
  submitLabel: PropTypes.string.isRequired,
  onSubmit: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
  describedBy: PropTypes.string,
};

/** Run a write and turn its result or refusal into an outcome; never swallowed. */
export async function outcomeOf(action, successMessage) {
  try {
    await action();
    return { message: successMessage };
  } catch (error) {
    return { error: error || { message: 'The request failed with no message.' } };
  }
}
