import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { CalendarOff } from 'lucide-react';
import {
  BLACKOUT_DB_REASON,
  clockToMinutes,
  findBlackoutConflicts,
  minutesToClock,
  repairProposal,
} from '@squadlogic/core/fieldAdmin/index.js';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';
import { BlackoutDraftSchema } from '../../hooks/useFieldClosures.js';

/**
 * Add or EDIT a blackout window, with what it would close shown before it is
 * written.
 *
 * **An edit is an edit.** `editing` switches this dialog from
 * `admin_create_field_blackout` to `admin_update_field_blackout`, which changes
 * the window in place: the same id, one audit entry, and a window that can be
 * followed across the change. Before 20260910000000 there was no update RPC, so
 * this screen only added, and changing a window meant removing it and adding
 * another.
 *
 * **Scope is displayed and not editable on that path**, because the RPC has no
 * parameter for it: moving a closure to other ground is a different closure,
 * whose consequence is computed over different bookings. The selects stay
 * visible and `disabled` rather than being hidden, so the operator can see what
 * they are editing; a sentence beside them says why, and the hook refuses a
 * draft whose scope has moved rather than silently sending the old one.
 *
 * **The consequence here is computed, not returned.**
 * `admin_create_field_blackout` has no dry run and does not refuse: a closure
 * over booked ground is a legitimate thing for a club to record — the ground
 * really is shut and the bookings really are now wrong. So the preview is
 * `findBlackoutConflicts()` run against the draft and the bookings the caller
 * already holds, and the operator commits with the list in front of them. That
 * is the opposite arrangement from the retirement dialog, where the guard lives
 * in the RPC and the preview is its refusal, and the difference is stated
 * because the two screens look alike.
 *
 * **Accessibility.** Native `<input type="date">` and `<input type="time">`,
 * which are keyboard-operable by construction rather than a bespoke calendar
 * that would have to re-earn it. Every control has a visible `<label>` bound by
 * `htmlFor`. Validation failures are listed in a `role="alert"` summary AND
 * named per field. The all-day switch is a real `<input type="checkbox">`, so
 * it is reachable, toggleable with Space and announced with its state.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {(draft: any) => Promise<any>} props.onCreate
 * @param {(draft: any) => Promise<any>} [props.onUpdate] - required when `editing` is set
 * @param {Record<string, any>|null} [props.editing] - the closure being edited, or null to add
 * @param {Array<{id: string, name: string}>} props.locations
 * @param {Array<{id: string, name: string, location_id: string}>} props.fields
 * @param {Array<Record<string, any>>} props.dated - dated bookings for the preview
 * @param {Array<Record<string, any>>} props.recurring - recurring bookings for the preview
 * @param {string} props.defaultDate - `YYYY-MM-DD`
 */
export default function BlackoutEditor({
  open,
  onClose,
  onCreate,
  onUpdate,
  editing,
  locations,
  fields,
  dated,
  recurring,
  defaultDate,
}) {
  const blank = useMemo(
    () => ({
      scope: /** @type {'location'|'field'} */ ('field'),
      scopeId: '',
      blackoutFrom: defaultDate,
      blackoutUntil: defaultDate,
      allDay: true,
      startClock: '',
      endClock: '',
      reason: 'closed',
      note: '',
    }),
    [defaultDate]
  );

  // The window under edit, in the form's own shape. `blank` when adding.
  //
  // **`reason` falls back to 'closed' rather than to ''.** An admin-authored
  // row always carries one -- `field_blackouts.reason` is NOT NULL -- but the
  // camelCase closure shape declares it nullable because the IMPORT arm of
  // `field_closures` has none, and a `<select>` given a value no `<option>`
  // holds renders as the first option instead. That silently rewrites the
  // reason of any window whose value did not arrive.
  const initial = useMemo(() => {
    if (!editing) return blank;
    return {
      scope: /** @type {'location'|'field'} */ (editing.closesFieldId ? 'field' : 'location'),
      scopeId: String(editing.closesFieldId ?? editing.closesLocationId ?? ''),
      blackoutFrom: editing.blackoutFrom,
      blackoutUntil: editing.blackoutUntil,
      allDay: editing.startMinutes === null || editing.startMinutes === undefined,
      startClock: minutesToClock(editing.startMinutes),
      endClock: minutesToClock(editing.endMinutes),
      reason: editing.reason ?? 'closed',
      note: editing.note ?? '',
    };
  }, [editing, blank]);

  /**
   * A time this dialog cannot round-trip.
   *
   * `minutesToClock(1440)` is `24:00`, which `<input type="time">` will not
   * hold: the browser blanks the box, the operator sees an empty "Closed
   * until", and saving would either fail validation for a reason that is not
   * their fault or -- worse -- write a window they did not ask for. The window
   * was writable before this dialog could open one, so the case is real.
   *
   * Recorded as open item 4 of the 8.4 PR 3 entry, where it was unreachable
   * because nothing loaded an existing window into this form. This screen makes
   * it reachable, so it is named here rather than left to a blank box.
   */
  const unrepresentable = editing
    ? [editing.startMinutes, editing.endMinutes].includes(1440)
    : false;

  const [form, setForm] = useState(initial);
  const [issues, setIssues] = useState(/** @type {string[]} */ ([]));
  const [busy, setBusy] = useState(false);

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const draft = useMemo(
    () => ({
      scope: form.scope,
      scopeId: form.scopeId,
      blackoutFrom: form.blackoutFrom,
      blackoutUntil: form.blackoutUntil,
      allDay: form.allDay,
      startMinutes: form.allDay ? null : clockToMinutes(form.startClock),
      endMinutes: form.allDay ? null : clockToMinutes(form.endClock),
      reason: form.reason,
      note: form.note.trim() === '' ? null : form.note.trim(),
    }),
    [form]
  );

  // The live preview. `safeParse` because a half-filled form is the normal
  // state of a form, not an error to shout about; the issues are raised on
  // submit.
  const preview = useMemo(() => {
    const parsed = BlackoutDraftSchema.safeParse(draft);
    if (!parsed.success) return null;
    return findBlackoutConflicts({
      closures: [
        {
          id: 'draft',
          source: 'field_blackouts',
          closesFieldId: parsed.data.scope === 'field' ? parsed.data.scopeId : null,
          closesLocationId: parsed.data.scope === 'location' ? parsed.data.scopeId : null,
          blackoutFrom: parsed.data.blackoutFrom,
          blackoutUntil: parsed.data.blackoutUntil,
          startMinutes: parsed.data.startMinutes,
          endMinutes: parsed.data.endMinutes,
        },
      ],
      fields: fields.map((field) => ({
        id: String(field.id),
        locationId: field.location_id ? String(field.location_id) : null,
      })),
      dated,
      recurring,
    });
  }, [draft, fields, dated, recurring]);

  const close = () => {
    setForm(initial);
    setIssues([]);
    onClose();
  };

  const submit = async () => {
    const parsed = BlackoutDraftSchema.safeParse(draft);
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((issue) => issue.message));
      return;
    }
    setBusy(true);
    try {
      await (editing ? onUpdate(parsed.data) : onCreate(parsed.data));
      setForm(initial);
      setIssues([]);
      onClose();
    } catch (err) {
      setIssues([err?.message || `The blackout could not be ${editing ? 'updated' : 'saved'}.`]);
    } finally {
      setBusy(false);
    }
  };

  const scopeOptions = form.scope === 'location' ? locations : fields;

  return (
    <Modal
      open={open}
      onClose={close}
      title={editing ? 'Edit this blackout window' : 'Add a blackout window'}
      icon={<CalendarOff size={18} aria-hidden="true" />}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || unrepresentable}>
            {editing ? 'Save changes' : 'Save blackout'}
          </Button>
        </>
      }
    >
      {unrepresentable && (
        <p className="badge danger" role="alert" data-testid="blackout-unrepresentable">
          This window ends at 24:00, which the time boxes below cannot hold. Remove it and add the
          replacement instead — editing it here would change a time you did not choose.
        </p>
      )}

      {issues.length > 0 && (
        <ul className="badge danger" role="alert" data-testid="blackout-issues">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="field">
        <label htmlFor="blackout-scope">What does this close?</label>
        <select
          id="blackout-scope"
          className="select"
          value={form.scope}
          disabled={Boolean(editing)}
          aria-describedby={editing ? 'blackout-scope-help' : undefined}
          onChange={(event) => set({ scope: event.target.value, scopeId: '' })}
        >
          <option value="field">One field</option>
          <option value="location">A whole venue</option>
        </select>
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="blackout-scope-id">
          {form.scope === 'location' ? 'Venue' : 'Field'} <span className="req">*</span>
        </label>
        <select
          id="blackout-scope-id"
          className="select"
          value={form.scopeId}
          disabled={Boolean(editing)}
          aria-describedby={editing ? 'blackout-scope-help' : undefined}
          onChange={(event) => set({ scopeId: event.target.value })}
        >
          <option value="">Select {form.scope === 'location' ? 'a venue' : 'a field'}</option>
          {scopeOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        {editing && (
          <p id="blackout-scope-help" className="text-sm" data-testid="blackout-scope-locked">
            The ground a closure covers cannot be changed by editing it — the closure recorded here
            really did apply here. Remove this window and add one on the new ground instead.
          </p>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
        <div className="field">
          <label htmlFor="blackout-from">
            First day <span className="req">*</span>
          </label>
          <input
            id="blackout-from"
            className="input"
            type="date"
            value={form.blackoutFrom}
            onChange={(event) => set({ blackoutFrom: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="blackout-until">
            Last day <span className="req">*</span>
          </label>
          <input
            id="blackout-until"
            className="input"
            type="date"
            value={form.blackoutUntil}
            onChange={(event) => set({ blackoutUntil: event.target.value })}
            aria-describedby="blackout-until-help"
          />
        </div>
      </div>
      <p id="blackout-until-help" className="text-sm">
        Both days are included. For a single date, use the same day twice.
      </p>

      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="blackout-all-day">
          <input
            id="blackout-all-day"
            type="checkbox"
            checked={form.allDay}
            onChange={(event) =>
              set({ allDay: event.target.checked, startClock: '', endClock: '' })
            }
          />{' '}
          Closed all day
        </label>
      </div>

      {!form.allDay && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="field">
            <label htmlFor="blackout-start">
              Closed from <span className="req">*</span>
            </label>
            <input
              id="blackout-start"
              className="input"
              type="time"
              value={form.startClock}
              onChange={(event) => set({ startClock: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="blackout-end">
              Closed until <span className="req">*</span>
            </label>
            <input
              id="blackout-end"
              className="input"
              type="time"
              value={form.endClock}
              onChange={(event) => set({ endClock: event.target.value })}
            />
          </div>
        </div>
      )}

      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="blackout-reason">Reason</label>
        <select
          id="blackout-reason"
          className="select"
          value={form.reason}
          onChange={(event) => set({ reason: event.target.value })}
        >
          {BLACKOUT_DB_REASON.map((reason) => (
            <option key={reason} value={reason}>
              {reason}
            </option>
          ))}
        </select>
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="blackout-note">Note</label>
        <textarea
          id="blackout-note"
          className="textarea"
          value={form.note}
          maxLength={200}
          onChange={(event) => set({ note: event.target.value })}
          aria-describedby="blackout-note-help"
        />
        <p id="blackout-note-help" className="text-sm">
          Optional, at most 200 characters. Do not name people — the structured reason above is
          where the why belongs, and personal data is out of scope.
        </p>
      </div>

      {/*
        **Source is stated, not asked for.** `public.field_blackouts` has no
        source column: everything written through this RPC is admin-authored by
        construction, and `field_closures.source` reports which of the two
        tables a row came from. An input whose value the database has nowhere to
        keep would be a field parsed and never read, which CLAUDE.md names
        outright.
      */}
      <p className="text-sm" style={{ marginTop: 10 }} data-testid="blackout-source">
        Source: entered here by an administrator. Windows that arrived through a field-availability
        import are listed with their own source and are neither editable nor removable on this
        screen.
      </p>

      <div aria-live="polite" style={{ marginTop: 12 }}>
        {preview && (
          <div data-testid="blackout-consequence">
            {/*
              **An edit is previewed exactly as a create is, and for the same
              reason.** Moving a window onto a date somebody has booked
              invalidates that booking just as surely as creating one there
              does, so the same `findBlackoutConflicts()` run over the DRAFT
              answers both. What this does NOT do is difference the draft
              against the window as it stands: a booking that a shrunk window
              stops closing is a restoration rather than a consequence, and the
              grid's own "Bookings closed" column reports the after state once
              the edit lands.
            */}
            <p className="text-sm">
              {editing ? 'As edited, this window' : 'This window'} would close{' '}
              <strong>{preview.meta.conflictsFound}</strong> existing booking
              {preview.meta.conflictsFound === 1 ? '' : 's'}, out of {preview.meta.pairsCompared} on
              this ground that were checked.
            </p>
            {preview.meta.pairsCompared === 0 && (
              <p className="text-sm" data-testid="blackout-nothing-compared">
                Nothing on this ground was available to check — that is not the same as nothing
                being booked.
              </p>
            )}
            <ul>
              {preview.findings.slice(0, 8).map((finding) => (
                <li key={`${finding.details.bookingKind}-${finding.details.bookingId}`}>
                  {finding.message}
                </li>
              ))}
            </ul>
            <p className="text-sm" data-reason-code={repairProposal().finding.code}>
              <strong>{repairProposal().finding.code}</strong> — {repairProposal().finding.message}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

BlackoutEditor.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreate: PropTypes.func.isRequired,
  onUpdate: PropTypes.func,
  editing: PropTypes.object,
  locations: PropTypes.array.isRequired,
  fields: PropTypes.array.isRequired,
  dated: PropTypes.array.isRequired,
  recurring: PropTypes.array.isRequired,
  defaultDate: PropTypes.string.isRequired,
};
