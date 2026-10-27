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

  const chooseFile = async (event) => {
    const chosen = event.target.files?.[0] ?? null;
    setFile(null);
    setFileError(null);
    if (!chosen) return;
    setChecking(true);
    try {
      await checkFile(chosen);
      setFile(chosen);
    } catch (err) {
      setFileError(err.message);
      event.target.value = '';
    } finally {
      setChecking(false);
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
      <form id="permit-form" onSubmit={submit} noValidate>
        <div role="alert" aria-live="assertive">
          {summary.length > 0 && (
            <p className="badge danger" style={{ marginBottom: 12 }}>
              {summary.length === 1
                ? summary[0]
                : `${summary.length} things to fix: ${summary.join('. ')}`}
            </p>
          )}
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
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
            <p id="permit-issuer-error" className="text-sm" style={{ color: 'var(--danger-text)' }}>
              {errors.issuer}
            </p>
          )}
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
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
          {errors.permitNumber && (
            <p className="text-sm" style={{ color: 'var(--danger-text)' }}>
              {errors.permitNumber}
            </p>
          )}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 12,
            marginBottom: 12,
          }}
        >
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
              <p id="permit-from-error" className="text-sm" style={{ color: 'var(--danger-text)' }}>
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
              <p id="permit-to-error" className="text-sm" style={{ color: 'var(--danger-text)' }}>
                {errors.validTo}
              </p>
            )}
          </div>
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
          <legend style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            Covers{' '}
            <span className="req" style={{ color: 'var(--danger)' }}>
              *
            </span>
          </legend>
          {locations.length === 0 && <p className="text-sm">Add a venue and a field first.</p>}
          <div
            style={{
              maxHeight: 220,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {locations.map((location) => (
              <div key={location.id}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={locationIds.has(location.id)}
                    onChange={() => toggle(setLocationIds, location.id)}
                  />
                  {location.name} (whole venue)
                </label>
                <div style={{ marginLeft: 24, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(fieldsByLocation.get(location.id) ?? []).map((field) => (
                    <label key={field.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
          {errors.fieldIds && (
            <p className="text-sm" style={{ color: 'var(--danger-text)' }}>
              {errors.fieldIds}
            </p>
          )}
        </fieldset>

        <div className="field" style={{ marginBottom: 12 }}>
          <label htmlFor="permit-notes">Notes</label>
          <textarea
            id="permit-notes"
            className="textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            aria-invalid={Boolean(errors.notes)}
          />
          {errors.notes && (
            <p className="text-sm" style={{ color: 'var(--danger-text)' }}>
              {errors.notes}
            </p>
          )}
        </div>

        {!editing && (
          <div className="field">
            <label htmlFor="permit-file">The permit document (optional)</label>
            <input
              id="permit-file"
              className="input"
              type="file"
              accept={ACCEPT}
              onChange={chooseFile}
              aria-describedby="permit-file-help"
              style={{ height: 'auto', padding: 8 }}
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
