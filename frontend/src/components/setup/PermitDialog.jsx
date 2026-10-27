import React, { useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { FileText } from 'lucide-react';
import { PermitInputSchema, PERMIT_FILE_TYPES } from '@squadlogic/core/facility/permits.js';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';

const ACCEPT = [...Object.keys(PERMIT_FILE_TYPES)].join(',');

/**
 * Add or edit a permit: who issued it, its number, the dates, notes, what it covers, and (on add)
 * its file. Replacing the file of an existing permit is its own action on the list.
 *
 * Every refusal is shown beside the field it concerns and gathered in one `role="alert"` summary at
 * the top, so a screen reader hears it once; the dialog's focus trap and focus return come from
 * `Modal`. A file is checked (type, size, its first bytes) the moment it is chosen, before anything
 * is sent. A permit blocks nothing: nothing here gates anything else.
 *
 * @param {object} props
 * @param {any} [props.permit] - the permit being edited, or undefined to add one
 * @param {Array<{ id: string, name: string }>} props.locations
 * @param {Array<{ id: string, name: string, location_id: string }>} props.fields
 * @param {(file: File) => Promise<any>} props.checkFile - throws a readable message for a bad file
 * @param {(input: any, file: File|null) => Promise<void>} props.onSave
 * @param {() => void} props.onClose
 */
export default function PermitDialog({ permit, locations, fields, checkFile, onSave, onClose }) {
  const editing = Boolean(permit);
  const [issuer, setIssuer] = useState(permit?.issuer ?? '');
  const [permitNumber, setPermitNumber] = useState(permit?.permit_number ?? '');
  const [validFrom, setValidFrom] = useState(permit?.valid_from ?? '');
  const [validTo, setValidTo] = useState(permit?.valid_to ?? '');
  const [notes, setNotes] = useState(permit?.notes ?? '');
  const [locationIds, setLocationIds] = useState(
    () =>
      new Set((permit?.scopes ?? []).filter((s) => s.kind === 'location').map((s) => s.location_id))
  );
  const [fieldIds, setFieldIds] = useState(
    () => new Set((permit?.scopes ?? []).filter((s) => s.kind === 'field').map((s) => s.field_id))
  );
  const [file, setFile] = useState(/** @type {File|null} */ (null));
  const [fileError, setFileError] = useState(/** @type {string|null} */ (null));
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [formError, setFormError] = useState(/** @type {string|null} */ (null));
  const [busy, setBusy] = useState(false);
  // A file is being checked (its first bytes are read): Save waits, so a file chosen a moment ago is not left out.
  const [checking, setChecking] = useState(false);
  const issuerRef = useRef(null);

  const fieldsByLocation = useMemo(() => {
    const map = new Map();
    for (const location of locations) map.set(location.id, []);
    for (const field of fields) {
      if (map.has(field.location_id)) map.get(field.location_id).push(field);
    }
    return map;
  }, [locations, fields]);

  const toggle = (setter, id) =>
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Each choice is numbered; only the newest choice's check may set the file, the message or
  // `checking`, so an older check that resolves last cannot replace what the input now shows.
  const selection = useRef(0);

  const chooseFile = async (event) => {
    const input = event.target;
    const chosen = input.files?.[0] ?? null;
    selection.current += 1;
    const mine = selection.current;
    setFile(null);
    setFileError(null);
    if (!chosen) {
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      await checkFile(chosen);
      if (mine === selection.current) setFile(chosen);
    } catch (err) {
      if (mine === selection.current) {
        setFileError(err.message);
        input.value = '';
      }
    } finally {
      if (mine === selection.current) setChecking(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setFormError(null);
    const input = {
      issuer,
      permitNumber,
      validFrom,
      validTo,
      notes,
      locationIds: [...locationIds],
      fieldIds: [...fieldIds],
    };
    const parsed = PermitInputSchema.safeParse(input);
    if (!parsed.success) {
      const byPath = /** @type {Record<string, string>} */ ({});
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        byPath[key] ??= issue.message;
      }
      // A date that is not filled in reads as the format error; say what is missing.
      if (!validFrom) byPath.validFrom = 'Enter the first valid day';
      if (!validTo) byPath.validTo = 'Enter the last valid day';
      setErrors(byPath);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      // A permit saved with a file that then failed to upload is the section's to announce: the
      // permit exists, so the dialog closes and the list says the file is missing.
      await onSave(input, file);
      onClose();
    } catch (err) {
      setFormError(err?.message || 'The permit could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const summary = [...Object.values(errors), fileError, formError].filter(Boolean);

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit permit' : 'Add permit'}
      icon={<FileText size={18} aria-hidden="true" />}
      initialFocusRef={issuerRef}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="permit-form" disabled={busy || checking}>
            {busy ? 'Saving…' : 'Save permit'}
          </Button>
        </>
      }
    >
      <form id="permit-form" className="permit-form" onSubmit={submit} noValidate>
        <div role="alert" aria-live="assertive" className="permit-alert">
          {summary.length > 0 && (
            <p className="badge danger">
              {summary.length === 1
                ? summary[0]
                : `${summary.length} things to fix: ${summary.join('. ')}`}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="permit-issuer">
            Issued by <span className="req">*</span>
          </label>
          <input
            id="permit-issuer"
            ref={issuerRef}
            className="input"
            type="text"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            aria-invalid={Boolean(errors.issuer)}
            aria-describedby={errors.issuer ? 'permit-issuer-error' : undefined}
            autoComplete="off"
          />
          {errors.issuer && (
            <p id="permit-issuer-error" className="text-sm field-error">
              {errors.issuer}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="permit-number">Permit number</label>
          <input
            id="permit-number"
            className="input"
            type="text"
            value={permitNumber}
            onChange={(e) => setPermitNumber(e.target.value)}
            aria-invalid={Boolean(errors.permitNumber)}
            aria-describedby="permit-number-help"
            autoComplete="off"
          />
          <p id="permit-number-help" className="text-sm">
            Kept exactly as typed, leading zeros and all.
          </p>
          {errors.permitNumber && <p className="text-sm field-error">{errors.permitNumber}</p>}
        </div>

        <div className="permit-dates">
          <div className="field">
            <label htmlFor="permit-from">
              Valid from <span className="req">*</span>
            </label>
            <input
              id="permit-from"
              className="input"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              aria-invalid={Boolean(errors.validFrom)}
              aria-describedby={errors.validFrom ? 'permit-from-error' : undefined}
            />
            {errors.validFrom && (
              <p id="permit-from-error" className="text-sm field-error">
                {errors.validFrom}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="permit-to">
              Valid through <span className="req">*</span>
            </label>
            <input
              id="permit-to"
              className="input"
              type="date"
              value={validTo}
              onChange={(e) => setValidTo(e.target.value)}
              aria-invalid={Boolean(errors.validTo)}
              aria-describedby={errors.validTo ? 'permit-to-error' : 'permit-to-help'}
            />
            <p id="permit-to-help" className="text-sm">
              The last day it is valid.
            </p>
            {errors.validTo && (
              <p id="permit-to-error" className="text-sm field-error">
                {errors.validTo}
              </p>
            )}
          </div>
        </div>

        <fieldset className="permit-scopes">
          <legend>
            Covers <span className="req">*</span>
          </legend>
          {locations.length === 0 && <p className="text-sm">Add a venue and a field first.</p>}
          <div className="permit-scope-list">
            {locations.map((location) => (
              <div key={location.id}>
                <label className="permit-check venue">
                  <input
                    type="checkbox"
                    checked={locationIds.has(location.id)}
                    onChange={() => toggle(setLocationIds, location.id)}
                  />
                  {location.name} (whole venue)
                </label>
                <div className="permit-field-checks">
                  {(fieldsByLocation.get(location.id) ?? []).map((field) => (
                    <label key={field.id} className="permit-check">
                      <input
                        type="checkbox"
                        checked={fieldIds.has(field.id)}
                        onChange={() => toggle(setFieldIds, field.id)}
                        aria-label={`${location.name}, ${field.name}`}
                      />
                      {field.name}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {errors.fieldIds && <p className="text-sm field-error">{errors.fieldIds}</p>}
        </fieldset>

        <div className="field">
          <label htmlFor="permit-notes">Notes</label>
          <textarea
            id="permit-notes"
            className="textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            aria-invalid={Boolean(errors.notes)}
          />
          {errors.notes && <p className="text-sm field-error">{errors.notes}</p>}
        </div>

        {!editing && (
          <div className="field">
            <label htmlFor="permit-file">The permit document (optional)</label>
            <input
              id="permit-file"
              className="input permit-file-input"
              type="file"
              accept={ACCEPT}
              onChange={chooseFile}
              aria-describedby="permit-file-help"
            />
            <p id="permit-file-help" className="text-sm">
              A PDF, JPEG or PNG up to 10 MB. You can add or replace it later.
            </p>
          </div>
        )}
      </form>
    </Modal>
  );
}

PermitDialog.propTypes = {
  permit: PropTypes.object,
  locations: PropTypes.arrayOf(PropTypes.object).isRequired,
  fields: PropTypes.arrayOf(PropTypes.object).isRequired,
  checkFile: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
