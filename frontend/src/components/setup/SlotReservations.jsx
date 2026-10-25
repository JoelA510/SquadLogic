import React, { useId, useState } from 'react';

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const hhmm = (value) => String(value ?? '').substring(0, 5);

/**
 * One field's practice slots, each with the division it is reserved to (D2,
 * `docs/changes/2026-10-22-demo-mode.md`): a reserved slot is used only by its
 * division's teams, and a division with a reserved slot uses only its reserved
 * slots. Choosing "Any division" opens the slot again. Each choice is saved at
 * once through `onReserve` (the audited `admin_set_practice_slot_division`);
 * a refusal is announced and the select shows the stored value again.
 *
 * Divisions are the selected season's, once read (`divisionsRead`); a slot
 * reserved to a division of another season keeps it as an option, marked, so
 * nothing changes unless an admin chooses. Until the season's divisions are
 * read (none selected, the read in flight or failed) a reservation is shown
 * only as reserved, never as another season's, and can still be cleared.
 *
 * @param {{
 *   field: { id: string, name: string, practice_slots?: Array<Record<string, any>>, field_subunits?: Array<{ id: string, label: string }> },
 *   divisions: Array<{ id: string, name: string }>,
 *   divisionsRead: boolean,
 *   canEdit: boolean,
 *   onReserve: (slotId: string, divisionId: string|null) => Promise<unknown>,
 * }} props
 */
export default function SlotReservations({ field, divisions, divisionsRead, canEdit, onReserve }) {
  const headingId = useId();
  const [savingId, setSavingId] = useState(/** @type {string|null} */ (null));
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const slots = [...(field.practice_slots ?? [])].sort(
    (a, b) =>
      DAY_ORDER.indexOf(a.day_of_week) - DAY_ORDER.indexOf(b.day_of_week) ||
      String(a.start_time).localeCompare(String(b.start_time)) ||
      String(a.id).localeCompare(String(b.id))
  );
  if (slots.length === 0) return null;
  const subunitLabel = new Map((field.field_subunits ?? []).map((su) => [su.id, su.label]));
  const known = new Set(divisions.map((d) => String(d.id)));
  const reservedCount = slots.filter((slot) => slot.division_id).length;

  const describe = (slot) =>
    `${DAY_LABEL[slot.day_of_week] ?? slot.day_of_week} ${hhmm(slot.start_time)}` +
    (slot.field_subunit_id && subunitLabel.has(slot.field_subunit_id)
      ? ` (${subunitLabel.get(slot.field_subunit_id)})`
      : '');

  const handleChange = async (slot, value) => {
    setError(null);
    setSavingId(String(slot.id));
    try {
      await onReserve(String(slot.id), value === '' ? null : value);
    } catch (err) {
      setError(`The ${describe(slot)} slot could not be saved: ${err?.message ?? 'unknown error'}`);
    } finally {
      setSavingId(null);
    }
  };

  return (
    <details className="mt-3 text-sm" data-testid={`slot-reservations-${field.id}`}>
      <summary className="cursor-pointer text-text-secondary rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
        <span id={headingId}>Practice slot divisions</span>
        {` · ${reservedCount} of ${slots.length} reserved`}
      </summary>
      <ul className="mt-2 space-y-2" aria-labelledby={headingId}>
        {slots.map((slot) => (
          <li key={slot.id} className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs text-text-secondary">
              {describe(slot)}
              {`–${hhmm(slot.end_time)}`}
            </span>
            <select
              aria-label={`Division for the ${describe(slot)} practice slot on ${field.name}`}
              value={slot.division_id ?? ''}
              disabled={!canEdit || savingId !== null}
              onChange={(event) => handleChange(slot, event.target.value)}
              className="bg-bg-app border border-border-subtle rounded-lg px-2 py-1 text-text-primary focus:border-brand-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-60"
            >
              <option value="">Any division</option>
              {slot.division_id && !known.has(String(slot.division_id)) && (
                <option value={slot.division_id}>
                  {divisionsRead ? 'A division of another season' : 'A reserved division'}
                </option>
              )}
              {divisions.map((division) => (
                <option key={division.id} value={division.id}>
                  {division.name}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-status-error-text">
          {error}
        </p>
      )}
    </details>
  );
}
