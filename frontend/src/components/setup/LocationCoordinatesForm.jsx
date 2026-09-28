import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { LocationCoordinatesSchema } from '@squadlogic/core/facility/schemas.js';
import Button from '../ui/Button.jsx';

/**
 * A venue's latitude/longitude pair, typed by an admin (plan 8.9 §2, D9).
 *
 * **Nothing geocodes and nothing is fetched.** There is no address lookup and
 * no browser geolocation: the pair is what the admin types, validated by the
 * core `LocationCoordinatesSchema` before `onSave` (the
 * `admin_set_location_coordinates` RPC) is ever called. The RPC rounds to 2
 * decimals; what this shows after a save is the RPC's answer, not the input.
 *
 * Non-admins get the stored values read-only and no inputs at all.
 */

/** A plain decimal: optional sign, digits, optional fraction. Anything else is NaN. */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

const LABELS = { latitude: 'Latitude', longitude: 'Longitude' };
const RANGES = { latitude: '-90 and 90', longitude: '-180 and 180' };

/**
 * `''` is "not entered" (null); a non-decimal is NaN, which the schema refuses
 * as not a number. Conversion is this form's; judging is the schema's.
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseCoordinate(text) {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * Stored values are shown with at least the 2 decimals the RPC keeps, and up
 * to the column's 4 so a table-owner write that was not rounded is not
 * misrepresented as if it had been.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatCoordinate(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
    useGrouping: false,
  });
}

/** @param {{ latitude?: unknown, longitude?: unknown } | null | undefined} loc */
export function hasCoordinates(loc) {
  return (
    loc?.latitude !== null &&
    loc?.latitude !== undefined &&
    loc?.longitude !== null &&
    loc?.longitude !== undefined
  );
}

/**
 * One message per field from the schema's issues. The both-or-neither refine
 * reports on `longitude`; it is moved to whichever field is actually empty, so
 * the error sits beside the input the admin has to fill.
 *
 * @param {import('zod').ZodError} error
 * @param {{ latitude: number|null, longitude: number|null }} pair
 * @returns {{ latitude?: string, longitude?: string }}
 */
function fieldErrorsFrom(error, pair) {
  /** @type {{ latitude?: string, longitude?: string }} */
  const errors = {};
  for (const issue of error.issues) {
    if (issue.code === 'custom') {
      const field = pair.latitude === null ? 'latitude' : 'longitude';
      errors[field] ??= 'Enter both latitude and longitude, or use Clear to remove both.';
      continue;
    }
    const field = issue.path[0] === 'latitude' ? 'latitude' : 'longitude';
    if (errors[field]) continue;
    errors[field] =
      issue.code === 'too_small' || issue.code === 'too_big'
        ? `${LABELS[field]} must be between ${RANGES[field]}.`
        : `${LABELS[field]} must be a number.`;
  }
  return errors;
}

/**
 * The DB message, with its SQLSTATE when the error carries one. Never empty,
 * so a refusal can never render as nothing.
 *
 * @param {any} err
 * @returns {string}
 */
function rpcErrorText(err) {
  const message = err?.message || 'The coordinates could not be saved.';
  return err?.code ? `${message} (${err.code})` : message;
}

export default function LocationCoordinatesForm({ location, canEdit, onSave }) {
  const baseId = `coords-${location.id}`;
  const [stored, setStored] = useState({
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
  });
  const [latText, setLatText] = useState(formatCoordinate(location.latitude));
  const [lngText, setLngText] = useState(formatCoordinate(location.longitude));
  const [fieldErrors, setFieldErrors] = useState(
    /** @type {{ latitude?: string, longitude?: string }} */ ({})
  );
  const [rpcError, setRpcError] = useState(/** @type {string|null} */ (null));
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const latRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const lngRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  // A refetch that brings a different stored pair wins over what is shown, in
  // the inputs too: a Save must never resend a pair that is no longer stored.
  useEffect(() => {
    setStored({ latitude: location.latitude ?? null, longitude: location.longitude ?? null });
    setLatText(formatCoordinate(location.latitude));
    setLngText(formatCoordinate(location.longitude));
    setFieldErrors({});
  }, [location.latitude, location.longitude]);

  const storedText = hasCoordinates(stored)
    ? `${formatCoordinate(stored.latitude)}, ${formatCoordinate(stored.longitude)}`
    : 'Not set';

  const privacyNote = (
    <p id={`${baseId}-privacy`} className="text-xs text-text-secondary">
      Stored to about 1 km precision (2 decimal places) and used only to work out sunset times.
      Nothing looks the venue up; the values are what an admin types.
    </p>
  );

  if (!canEdit) {
    return (
      <div className="space-y-1" data-testid={`venue-coordinates-readonly-${location.id}`}>
        <div className="text-sm text-text-primary">
          Coordinates:{' '}
          <span data-testid={`venue-coordinates-stored-${location.id}`}>{storedText}</span>
        </div>
        {privacyNote}
      </div>
    );
  }

  /**
   * @param {number|null} latitude
   * @param {number|null} longitude
   */
  const submit = async (latitude, longitude) => {
    setRpcError(null);
    setStatus('');
    const pair = { latitude, longitude };
    const parsed = LocationCoordinatesSchema.safeParse(pair);
    if (!parsed.success) {
      const errors = fieldErrorsFrom(parsed.error, pair);
      setFieldErrors(errors);
      (errors.latitude ? latRef : lngRef).current?.focus();
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      const row = await onSave(location.id, parsed.data.latitude, parsed.data.longitude);
      // The shown result is the RPC's answer; no answer is not a success.
      if (!row) throw new Error('The save returned no result; the stored value is unknown.');
      const next = { latitude: row.latitude ?? null, longitude: row.longitude ?? null };
      setStored(next);
      setLatText(formatCoordinate(next.latitude));
      setLngText(formatCoordinate(next.longitude));
      setStatus(
        hasCoordinates(next)
          ? `Saved as ${formatCoordinate(next.latitude)}, ${formatCoordinate(next.longitude)}.`
          : 'Coordinates cleared.'
      );
    } catch (err) {
      setRpcError(rpcErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  /** @param {React.FormEvent} event */
  const handleSubmit = (event) => {
    event.preventDefault();
    const latitude = parseCoordinate(latText);
    const longitude = parseCoordinate(lngText);
    if (latitude === null && longitude === null) {
      // A blank Save is not read as a clear: clearing is stated, with Clear.
      setRpcError(null);
      setStatus('');
      setFieldErrors({
        latitude: 'Enter both latitude and longitude, or use Clear to remove both.',
      });
      latRef.current?.focus();
      return;
    }
    submit(latitude, longitude);
  };

  /**
   * @param {'latitude'|'longitude'} field
   * @param {string} value
   * @param {Function} setText
   * @param {React.RefObject<HTMLInputElement|null>} ref
   */
  const renderInput = (field, value, setText, ref) => {
    const inputId = `${baseId}-${field}`;
    const errorId = `${inputId}-error`;
    const error = fieldErrors[field];
    return (
      <div className="field">
        <label htmlFor={inputId}>{LABELS[field]}</label>
        <input
          ref={ref}
          id={inputId}
          name={field}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className="input"
          value={value}
          placeholder={`Between ${RANGES[field]}`}
          onChange={(event) => setText(event.target.value)}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${errorId} ${baseId}-privacy` : `${baseId}-privacy`}
        />
        {error && (
          <p id={errorId} className="text-xs text-status-error">
            {error}
          </p>
        )}
      </div>
    );
  };

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      className="space-y-3"
      aria-label={`Coordinates for ${location.name}`}
      data-testid={`venue-coordinates-form-${location.id}`}
    >
      <div className="text-sm text-text-primary">
        Stored: <span data-testid={`venue-coordinates-stored-${location.id}`}>{storedText}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {renderInput('latitude', latText, setLatText, latRef)}
        {renderInput('longitude', lngText, setLngText, lngRef)}
      </div>
      {privacyNote}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          Save coordinates
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={saving || !hasCoordinates(stored)}
          onClick={() => submit(null, null)}
        >
          Clear coordinates
        </Button>
      </div>
      <div
        role="status"
        aria-live="polite"
        className="text-xs text-text-secondary"
        data-testid={`venue-coordinates-status-${location.id}`}
      >
        {status}
      </div>
      {rpcError && (
        <div className="badge danger" role="alert">
          {rpcError}
        </div>
      )}
    </form>
  );
}

LocationCoordinatesForm.propTypes = {
  location: PropTypes.shape({
    id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
    name: PropTypes.string,
    latitude: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    longitude: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  }).isRequired,
  canEdit: PropTypes.bool.isRequired,
  onSave: PropTypes.func.isRequired,
};
