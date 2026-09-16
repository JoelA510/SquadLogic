import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { CalendarX } from 'lucide-react';
import { repairProposal } from '@squadlogic/core/fieldAdmin/index.js';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';
import ConsequencePreview from '../scheduling/ConsequencePreview.jsx';

/**
 * Retire a surface, with the consequence shown before the commit.
 *
 * **The dry run IS the unconfirmed call.** `admin_retire_field` refuses rather
 * than raising, returns everything the retirement would strand, and writes a
 * `refused` audit row. There is no separate preview RPC and there must not be:
 * `public.field_bookings` — the shared enumerator both guards read — has EXECUTE
 * revoked from `authenticated`, so the only reading of "what is booked here" a
 * browser can obtain is the one the guard itself computed. A second reading
 * assembled client-side would be the third hand-written list this family has
 * already been burned by twice.
 *
 * The refused audit row is a feature, not a cost: the operator did attempt the
 * retirement, and the trail records the world they decided against.
 *
 * **Accessibility.** The date is a native `<input type="date">`, which is
 * keyboard-operable by construction — typed digits, arrow keys, and the
 * platform picker — rather than a bespoke calendar grid that would have to
 * re-earn that. Every control carries a visible label; the preview is announced
 * through `aria-live` because it appears without navigation; the dialog's focus
 * trap and focus return come from `Modal`.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {{ id: string, name: string, effective_to?: string|null }} props.field
 * @param {string} props.defaultDate - `YYYY-MM-DD`
 * @param {(fieldId: string, options: { effectiveTo: string, confirm?: boolean }) => Promise<any>} props.onRetire
 * @param {() => void} props.onClose
 * @param {() => void} [props.onRetired]
 */
export default function RetireFieldDialog({
  open,
  field,
  defaultDate,
  onRetire,
  onClose,
  onRetired = undefined,
}) {
  const [effectiveTo, setEffectiveTo] = useState(defaultDate);
  const [preview, setPreview] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string|null} */ (null));

  const reset = () => {
    setPreview(null);
    setError(null);
    setBusy(false);
  };

  const close = () => {
    reset();
    setEffectiveTo(defaultDate);
    onClose();
  };

  const attempt = async (confirm) => {
    setBusy(true);
    setError(null);
    try {
      const result = await onRetire(field.id, { effectiveTo, confirm });
      if (result.retired) {
        reset();
        onRetired?.();
        onClose();
        return;
      }
      // A refusal: the RPC has told us what stands after the date.
      setPreview(result);
    } catch (err) {
      setError(err?.message || 'The retirement could not be attempted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Retire ${field?.name ?? 'field'}`}
      icon={<CalendarX size={18} aria-hidden="true" />}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          {preview ? (
            <Button variant="danger" onClick={() => attempt(true)} disabled={busy}>
              Retire anyway
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => attempt(false)}
              disabled={busy || !effectiveTo}
            >
              Check and retire
            </Button>
          )}
        </>
      }
    >
      <div className="field">
        <label htmlFor="retire-effective-to">
          Last day this ground is usable <span className="req">*</span>
        </label>
        <input
          id="retire-effective-to"
          className="input"
          type="date"
          value={effectiveTo}
          onChange={(event) => {
            setEffectiveTo(event.target.value);
            // A new date is a new question. Keeping the old answer on screen
            // beside a changed date is how an operator confirms against a list
            // that was never computed for it.
            setPreview(null);
          }}
          aria-describedby="retire-effective-to-help"
        />
        <p id="retire-effective-to-help" className="text-sm">
          Inclusive. A booking ON this date is left alone; the field stops being offered the day
          after. Retiring is an end date — nothing is deleted, and it can be cleared again.
        </p>
      </div>

      <div aria-live="polite">
        {error && (
          <p className="badge danger" role="alert" style={{ marginTop: 10 }}>
            {error}
          </p>
        )}
        {preview && (
          <div style={{ marginTop: 12 }}>
            <ConsequencePreview
              subject={field.name}
              operation="retire"
              affectedCount={preview.affected_count ?? (preview.affected || []).length}
              rows={preview.affected || []}
              repair={repairProposal({
                affectedCount: preview.affected_count ?? (preview.affected || []).length,
              })}
              titleId="retire-consequence-title"
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

RetireFieldDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  field: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    effective_to: PropTypes.string,
  }).isRequired,
  defaultDate: PropTypes.string.isRequired,
  onRetire: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  onRetired: PropTypes.func,
};
