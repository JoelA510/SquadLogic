import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';
import { addGameFormProblem } from '../../utils/gameAddByHand.js';

/**
 * "Add a game" (plan `docs/changes/2026-11-03-schedule-expansion.md`, 5.5, PR 8, task H1): one game by hand, staged
 * into the review. Its pattern is `AllowChangesDialog`'s: native, labelled controls; focus to the heading on open and
 * back to the opener on close (`Modal`); the button disabled with a visible reason until the form is complete.
 *
 * - A division, a home and an away team (an outside club allowed, marked so, 4.6).
 * - Where: an **open slot** (the bookings "Move to" offers: a slot on its own field with no game) or **a new time**
 *   (a field, a date, a start and an end; the slot is found or made on Apply).
 * - `plan(choice)` is the page's rule (`planAddedGame`): a refusal is an alert and the button stays off (a Published
 *   slot); a double booking is listed as a flag and the button stays on (owner: warnings, not blockers).
 *
 * The parent remounts it (a new `key`) for each opening.
 *
 * @param {{ open: boolean,
 *   divisions: Array<{ name: string, teams: Array<{ id: string, name: string, isExternal: boolean }> }>,
 *   openSlots: Array<{ id: string, label: string }>,
 *   fields: Array<{ id: string, name: string }>,
 *   plan: (choice: Record<string, any>) => ({ refusal: string } | { game: Record<string, any>, warnings: Array<{ type: string, message: string }> }),
 *   onAdd: (result: { game: Record<string, any>, warnings: Array<Record<string, any>> }) => void,
 *   onClose: () => void }} props
 */
export default function AddGameDialog({
  open,
  divisions,
  openSlots,
  fields,
  plan,
  onAdd,
  onClose,
}) {
  const headingRef = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  const close = useCallback(() => latest.current(), []);
  const ids = {
    division: useId(),
    home: useId(),
    away: useId(),
    slot: useId(),
    field: useId(),
    date: useId(),
    start: useId(),
    end: useId(),
    why: useId(),
    where: useId(),
  };
  const [choice, setChoice] = useState({
    division: '',
    homeTeamId: '',
    awayTeamId: '',
    where: openSlots.length > 0 ? 'slot' : 'new',
    cellId: '',
    fieldId: '',
    date: '',
    startTime: '',
    endTime: '',
  });
  const set = (patch) => setChoice((current) => ({ ...current, ...patch }));

  const teams = divisions.find((d) => d.name === choice.division)?.teams ?? [];
  const problem = addGameFormProblem(choice);
  const result = useMemo(() => (problem === null ? plan(choice) : null), [choice, plan, problem]);
  const refusal = result && 'refusal' in result ? result.refusal : null;
  const warnings = result && 'game' in result ? result.warnings : [];
  const why = problem ?? (refusal ? 'This game cannot be added there.' : null);

  const teamOptions = teams.map((team) => (
    <option key={team.id} value={team.id}>
      {team.isExternal ? `${team.name} (outside club)` : team.name}
    </option>
  ));

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add a game"
      initialFocusRef={headingRef}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => result && 'game' in result && onAdd(result)}
            disabled={why !== null}
            aria-describedby={ids.why}
            data-testid="add-game-confirm"
          >
            Add to the review
          </Button>
        </>
      }
    >
      <h3 ref={headingRef} tabIndex={-1} className="text-sm">
        <strong>Add a game to the review</strong>
      </h3>
      <p className="text-sm mt-2">
        The game is added to the staged schedule as one you placed by hand. Nothing is saved until
        you apply the schedule. It starts not Published.
      </p>

      <div className="field mt-2">
        <label htmlFor={ids.division}>Division</label>
        <select
          id={ids.division}
          className="select"
          value={choice.division}
          onChange={(event) =>
            set({ division: event.target.value, homeTeamId: '', awayTeamId: '' })
          }
        >
          <option value="">Choose a division</option>
          {divisions.map((division) => (
            <option key={division.name} value={division.name}>
              {division.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field mt-2">
        <label htmlFor={ids.home}>Home team</label>
        <select
          id={ids.home}
          className="select"
          value={choice.homeTeamId}
          disabled={!choice.division}
          onChange={(event) => set({ homeTeamId: event.target.value })}
        >
          <option value="">Choose the home team</option>
          {teamOptions}
        </select>
      </div>
      <div className="field mt-2">
        <label htmlFor={ids.away}>Away team</label>
        <select
          id={ids.away}
          className="select"
          value={choice.awayTeamId}
          disabled={!choice.division}
          onChange={(event) => set({ awayTeamId: event.target.value })}
        >
          <option value="">Choose the away team</option>
          {teamOptions}
        </select>
      </div>

      <fieldset className="field mt-2" aria-describedby={ids.where}>
        <legend>Where it is played</legend>
        <label className="text-sm">
          <input
            type="radio"
            name={`${ids.where}-where`}
            checked={choice.where === 'slot'}
            onChange={() => set({ where: 'slot' })}
          />{' '}
          An open slot
        </label>{' '}
        <label className="text-sm">
          <input
            type="radio"
            name={`${ids.where}-where`}
            checked={choice.where === 'new'}
            onChange={() => set({ where: 'new' })}
          />{' '}
          A new time
        </label>
        <p id={ids.where} className="text-xs mt-1">
          An open slot is a game slot with no game in it. A new time is made as a slot when you
          apply the schedule.
        </p>
      </fieldset>

      {choice.where === 'slot' ? (
        <div className="field mt-2">
          <label htmlFor={ids.slot}>Open slot</label>
          <select
            id={ids.slot}
            className="select"
            value={choice.cellId}
            onChange={(event) => set({ cellId: event.target.value })}
          >
            <option value="">
              {openSlots.length > 0 ? 'Choose an open slot' : 'No open slot'}
            </option>
            {openSlots.map((cell) => (
              <option key={cell.id} value={cell.id}>
                {cell.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="field mt-2">
            <label htmlFor={ids.field}>Field</label>
            <select
              id={ids.field}
              className="select"
              value={choice.fieldId}
              onChange={(event) => set({ fieldId: event.target.value })}
            >
              <option value="">Choose a field</option>
              {fields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field mt-2">
            <label htmlFor={ids.date}>Date</label>
            <input
              id={ids.date}
              type="date"
              className="input"
              value={choice.date}
              onChange={(event) => set({ date: event.target.value })}
            />
          </div>
          <div className="field mt-2">
            <label htmlFor={ids.start}>Starts</label>
            <input
              id={ids.start}
              type="time"
              className="input"
              value={choice.startTime}
              onChange={(event) => set({ startTime: event.target.value })}
            />
          </div>
          <div className="field mt-2">
            <label htmlFor={ids.end}>Ends</label>
            <input
              id={ids.end}
              type="time"
              className="input"
              value={choice.endTime}
              onChange={(event) => set({ endTime: event.target.value })}
            />
          </div>
        </>
      )}

      {refusal && (
        <p className="text-sm mt-2 text-status-error-text" role="alert">
          {refusal}
        </p>
      )}
      {warnings.length > 0 && (
        <div className="text-sm mt-2" role="status" data-testid="add-game-warnings">
          <p className="text-status-warning-text">
            Flagged, not blocked: you can still add it, and the conflict list will show it.
          </p>
          <ul>
            {warnings.map((warning) => (
              <li key={`${warning.type}-${warning.message}`}>{warning.message}</li>
            ))}
          </ul>
        </div>
      )}
      <p id={ids.why} className="text-sm mt-2" data-testid="add-game-why">
        {why ?? 'Ready: the game is added to the review.'}
      </p>
    </Modal>
  );
}

AddGameDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  divisions: PropTypes.arrayOf(
    PropTypes.shape({ name: PropTypes.string.isRequired, teams: PropTypes.array.isRequired })
  ).isRequired,
  openSlots: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string, label: PropTypes.string }))
    .isRequired,
  fields: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string, name: PropTypes.string }))
    .isRequired,
  plan: PropTypes.func.isRequired,
  onAdd: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
