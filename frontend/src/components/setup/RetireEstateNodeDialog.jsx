import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { CalendarX } from 'lucide-react';
import { repairProposal } from '@squadlogic/core/fieldAdmin/index.js';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';
import ConsequencePreview from '../scheduling/ConsequencePreview.jsx';

/**
 * The three depths of the estate, and the only things that differ between them.
 *
 * **One dialog parameterised by kind, not three dialogs.** `admin_retire_field`,
 * `admin_retire_location` and `admin_retire_field_subunit` ship one contract at
 * three depths: an unconfirmed call IS the dry run, a refusal arrives with
 * `error` null and `{retired:false, reason, affected_count, affected}`, and a
 * `refused` audit row records the world the operator decided against. Copying
 * this component per depth is precisely the shape that produced LIVE-1, LIVE-2
 * and LIVE-3 — one arm corrected while its sibling was not.
 *
 * `contains` is NOT a rendering preference. It says whether the RPC at this
 * depth produces a `contained` array at all: only the venue arm does, because
 * only a venue holds anything. A depth that reports no containment must render
 * no containment section, so that "nothing below" and "nobody looked" stay
 * distinguishable.
 *
 * @type {Record<string, { noun: string, ground: string, contains: boolean }>}
 */
export const ESTATE_KINDS = {
  location: {
    noun: 'venue',
    ground: 'this venue',
    contains: true,
  },
  field: {
    noun: 'field',
    ground: 'this ground',
    contains: false,
  },
  field_subunit: {
    noun: 'sub-surface',
    ground: 'this half-pitch',
    contains: false,
  },
};

/**
 * Retire a venue, a field or a sub-surface, with the consequence shown before
 * the commit.
 *
 * **The dry run IS the unconfirmed call.** The retire RPCs refuse rather than
 * raising, return everything the retirement would strand, and write a `refused`
 * audit row. There is no separate preview RPC and there must not be:
 * `public.field_bookings` — the shared enumerator every guard reads — has
 * EXECUTE revoked from `authenticated`, so the only reading of "what is booked
 * here" a browser can obtain is the one the guard itself computed. A second
 * reading assembled client-side would be the third hand-written list this
 * family has already been burned by twice. The same applies to `contained`:
 * `estate_contained_nodes` is likewise revoked, and this component never
 * assembles a containment list from the fields it happens to have in state.
 *
 * **The one case a pre-commit preview cannot cover, stated rather than hidden.**
 * The RPCs refuse on BOOKINGS only. Retiring a venue with nothing booked after
 * the date commits on the first call — so an operator closing a quiet site with
 * four live pitches would otherwise never be shown the four. This dialog
 * therefore renders `contained` on the COMMITTED result too, and stays open to
 * show it, instead of closing on a silence that hid half the consequence.
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
 * @param {{ id: string, name: string, effective_to?: string|null }} props.node
 * @param {'location'|'field'|'field_subunit'} props.kind
 * @param {string} props.defaultDate - `YYYY-MM-DD`
 * @param {(nodeId: string, options: { effectiveTo: string, confirm?: boolean }) => Promise<any>} props.onRetire
 * @param {() => void} props.onClose
 * @param {() => void} [props.onRetired]
 */
export default function RetireEstateNodeDialog({
  open,
  node,
  kind,
  defaultDate,
  onRetire,
  onClose,
  onRetired = undefined,
}) {
  const spec = ESTATE_KINDS[kind];
  const [effectiveTo, setEffectiveTo] = useState(defaultDate);
  const [preview, setPreview] = useState(/** @type {any} */ (null));
  const [committed, setCommitted] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string|null} */ (null));

  // **An unknown kind throws rather than defaulting.** Falling back to the
  // field arm would render a venue retirement with no containment section and
  // no sentence saying so -- the quietest possible way to hide half of what the
  // operator is about to do, and the same failure the `venue` argument in
  // `frontend/src/utils/fieldLifecycle.js` refuses a default for.
  if (!spec) {
    throw new Error(
      `RetireEstateNodeDialog: unknown estate kind "${kind}"; expected one of ${Object.keys(
        ESTATE_KINDS
      ).join(', ')}`
    );
  }

  const reset = () => {
    setPreview(null);
    setCommitted(null);
    setError(null);
    setBusy(false);
  };

  const close = () => {
    reset();
    setEffectiveTo(defaultDate);
    onClose();
  };

  /**
   * `contained` is forwarded ONLY when the RPC actually sent an array.
   *
   * `admin_retire_field_subunit` ships no `contained` key at all — a
   * sub-surface is the leaf of the estate, and 20260911000000 section 7 argues
   * that an empty array would be "a promise with no producer". Substituting
   * `[]` here would manufacture exactly that promise one layer up.
   *
   * @param {any} result
   */
  const containedProps = (result) => ({
    contained: Array.isArray(result?.contained) ? result.contained : undefined,
    containedCount:
      typeof result?.contained_count === 'number' ? result.contained_count : undefined,
  });

  const attempt = async (confirm) => {
    setBusy(true);
    setError(null);
    try {
      const result = await onRetire(node.id, { effectiveTo, confirm });
      if (result.retired) {
        onRetired?.();
        // **A commit with a containment report does not close silently.** The
        // guards refuse on bookings, never on containment, so this is the only
        // moment the operator can be shown which pitches and half-pitches the
        // venue took with it.
        if (spec.contains && Array.isArray(result.contained)) {
          setPreview(null);
          setError(null);
          setBusy(false);
          setCommitted(result);
          return;
        }
        reset();
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
      title={`Retire ${node?.name ?? spec.noun}`}
      icon={<CalendarX size={18} aria-hidden="true" />}
      footer={
        committed ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
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
        )
      }
    >
      {!committed && (
        <div className="field">
          <label htmlFor="retire-effective-to">
            Last day this {spec.noun} is usable <span className="req">*</span>
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
            Inclusive. A booking ON this date is left alone; {spec.ground} stops being offered the
            day after. Retiring is an end date — nothing is deleted, and it can be cleared again.
            {spec.contains
              ? ' Every field and sub-surface at this venue closes with it, by containment: no end date is written onto any of them.'
              : ''}
          </p>
        </div>
      )}

      <div aria-live="polite">
        {error && (
          <p className="badge danger" role="alert" style={{ marginTop: 10 }}>
            {error}
          </p>
        )}
        {committed && (
          <div style={{ marginTop: 12 }} data-testid="retire-committed">
            <p className="text-sm" style={{ marginBottom: 8 }}>
              <strong>{node.name}</strong> is retired after {effectiveTo}. This is what that closed
              — nothing was deleted, and clearing the end date brings back every node that has no
              end date of its own.
            </p>
            <ConsequencePreview
              subject={node.name}
              operation="retire"
              affectedCount={committed.affected_count ?? (committed.affected || []).length}
              rows={committed.affected || []}
              repair={repairProposal({
                affectedCount: committed.affected_count ?? (committed.affected || []).length,
              })}
              titleId="retire-committed-title"
              {...containedProps(committed)}
            />
          </div>
        )}
        {preview && (
          <div style={{ marginTop: 12 }}>
            <ConsequencePreview
              subject={node.name}
              operation="retire"
              affectedCount={preview.affected_count ?? (preview.affected || []).length}
              rows={preview.affected || []}
              repair={repairProposal({
                affectedCount: preview.affected_count ?? (preview.affected || []).length,
              })}
              titleId="retire-consequence-title"
              {...containedProps(preview)}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

RetireEstateNodeDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  node: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    effective_to: PropTypes.string,
  }).isRequired,
  kind: PropTypes.oneOf(['location', 'field', 'field_subunit']).isRequired,
  defaultDate: PropTypes.string.isRequired,
  onRetire: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  onRetired: PropTypes.func,
};
