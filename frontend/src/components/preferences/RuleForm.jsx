import React from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import { CoachPreferenceRuleSchema } from '@squadlogic/core/practice/coachPreferences.js';
import {
  LEVEL_LABEL,
  PRIORITY_LABEL,
  WEEKDAY_OPTIONS,
  clockToMinutes,
  minutesToClock,
} from '../../utils/coachPreferencePreview.js';

/**
 * The fields of a practice preference rule, shared by Add and Edit (Phase D C2): a level, the coach's
 * priority (shown, never weighed), days (any of), start times (any of), venues (any of), each of
 * the three with "keep what it practises now" in its place, and an optional date window. A condition
 * with nothing chosen is not part of the rule.
 *
 * The form's state is plain (strings for clocks, arrays for sets); `ruleInputOfForm` turns it into
 * the shape the core schema and the RPCs take, and `checkRuleForm` says what is wrong with it in
 * the core schema's own words.
 */

/**
 * The result of checking a form: `ok` with the rule it makes (`input` for the RPCs, `rule` as core
 * parsed it), or not ok with the schema's messages.
 * @typedef {{ ok: boolean, messages: string[], input: ReturnType<typeof ruleInputOfForm> | null,
 *   rule: any }} RuleCheck
 */

/** @typedef {{ level: 'prefer' | 'must', coachPriority: string, weekdays: string[],
 *   keepWeekday: boolean, startTimes: string[], keepStart: boolean, venueIds: string[],
 *   keepVenue: boolean, effectiveFrom: string, effectiveTo: string }} RuleFormState */

/** @returns {RuleFormState} */
export function emptyRuleForm() {
  return {
    level: 'prefer',
    coachPriority: '',
    weekdays: [],
    keepWeekday: false,
    startTimes: [],
    keepStart: false,
    venueIds: [],
    keepVenue: false,
    effectiveFrom: '',
    effectiveTo: '',
  };
}

/**
 * The form for a stored rule, to edit it.
 * @param {any} row
 * @returns {RuleFormState}
 */
export function formOfRow(row) {
  return {
    level: row.level === 'must' ? 'must' : 'prefer',
    coachPriority: row.coach_priority ?? '',
    weekdays: [...(row.weekdays ?? [])],
    keepWeekday: row.keep_weekday === true,
    startTimes: (row.start_minutes ?? []).map(minutesToClock),
    keepStart: row.keep_start === true,
    venueIds: [...(row.venue_ids ?? [])],
    keepVenue: row.keep_venue === true,
    effectiveFrom: row.effective_from ?? '',
    effectiveTo: row.effective_to ?? '',
  };
}

const WEEK_INDEX = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * The rule's conditions as core and the RPCs take them. Start times are read as clocks, blank ones
 * left out, repeats collapsed and sorted: the same value twice is one value, as the import reads it.
 * A set is sent in week order and venues in id order, the order the import writes them.
 *
 * @param {RuleFormState} form
 */
export function ruleInputOfForm(form) {
  const minutes = [
    ...new Set(form.startTimes.map(clockToMinutes).filter((value) => value !== null)),
  ].sort((a, b) => a - b);
  const weekdays = [...new Set(form.weekdays)].sort(
    (a, b) => WEEK_INDEX.indexOf(a) - WEEK_INDEX.indexOf(b)
  );
  const venues = [...new Set(form.venueIds)].sort();
  return {
    level: form.level,
    weekdays: form.keepWeekday || weekdays.length === 0 ? null : weekdays,
    startMinutes: form.keepStart || minutes.length === 0 ? null : minutes,
    venueIds: form.keepVenue || venues.length === 0 ? null : venues,
    keepWeekday: form.keepWeekday,
    keepStart: form.keepStart,
    keepVenue: form.keepVenue,
    coachPriority:
      form.coachPriority === ''
        ? null
        : /** @type {'high' | 'medium' | 'low'} */ (form.coachPriority),
    effectiveFrom: form.effectiveFrom === '' ? null : form.effectiveFrom,
    effectiveTo: form.effectiveTo === '' ? null : form.effectiveTo,
  };
}

/**
 * What is wrong with the form, in the core schema's words, or the rule it makes. A time field the
 * browser could not read is reported here rather than dropped.
 *
 * @param {RuleFormState} form
 * @param {{ coachId: string, teamId: string, id?: string }} who
 * @returns {RuleCheck}
 */
export function checkRuleForm(form, { coachId, teamId, id = 'new' }) {
  const unreadable = form.startTimes.filter((time) => time !== '' && clockToMinutes(time) === null);
  if (unreadable.length > 0) {
    return {
      ok: false,
      messages: ['A start time could not be read; use the form HH:MM'],
      input: null,
      rule: null,
    };
  }
  const input = ruleInputOfForm(form);
  const parsed = CoachPreferenceRuleSchema.safeParse({ id, coachId, teamId, ...input });
  if (!parsed.success) {
    return {
      ok: false,
      messages: parsed.error.issues.map((issue) => issue.message),
      input: null,
      rule: null,
    };
  }
  return { ok: true, messages: [], input, rule: parsed.data };
}

/** A group of checkboxes with a visible legend. */
function CheckGroup({ legend, children, hint = null }) {
  return (
    <fieldset className="m-0 border-0 p-0 flex flex-col gap-2">
      <legend className="text-xs font-semibold text-text-secondary mb-1">{legend}</legend>
      {hint}
      {children}
    </fieldset>
  );
}

CheckGroup.propTypes = {
  legend: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
  hint: PropTypes.node,
};

function Check({ id, label, checked, onChange, disabled = false }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-text-primary">
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

Check.propTypes = {
  id: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  checked: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};

/**
 * @param {Object} props
 * @param {string} props.idPrefix - unique per dialog, so two forms never share an id
 * @param {RuleFormState} props.form
 * @param {(next: RuleFormState) => void} props.onChange
 * @param {Array<{ id: string, name: string }>} props.locations
 * @param {boolean} [props.disabled]
 */
export default function RuleForm({ idPrefix, form, onChange, locations, disabled = false }) {
  const set = (patch) => onChange({ ...form, ...patch });
  const toggle = (list, value, on) =>
    on ? [...new Set([...list, value])] : list.filter((item) => item !== value);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="field">
          <label htmlFor={`${idPrefix}-level`}>Level</label>
          <select
            id={`${idPrefix}-level`}
            className="select"
            value={form.level}
            disabled={disabled}
            onChange={(event) => set({ level: event.target.value })}
          >
            {['prefer', 'must'].map((level) => (
              <option key={level} value={level}>
                {LEVEL_LABEL[level]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-priority`}>Coach&apos;s priority</label>
          <select
            id={`${idPrefix}-priority`}
            className="select"
            value={form.coachPriority}
            disabled={disabled}
            aria-describedby={`${idPrefix}-priority-hint`}
            onChange={(event) => set({ coachPriority: event.target.value })}
          >
            <option value="">None</option>
            {Object.entries(PRIORITY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p id={`${idPrefix}-priority-hint`} className="text-xs text-text-muted m-0">
            For your reading only: the scheduler does not weigh it.
          </p>
        </div>
      </div>

      <CheckGroup legend="Days (any of these)">
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {WEEKDAY_OPTIONS.map((option) => (
            <Check
              key={option.code}
              id={`${idPrefix}-day-${option.code}`}
              label={option.label}
              checked={form.weekdays.includes(option.code)}
              disabled={disabled || form.keepWeekday}
              onChange={(on) => set({ weekdays: toggle(form.weekdays, option.code, on) })}
            />
          ))}
        </div>
        <Check
          id={`${idPrefix}-keep-day`}
          label="Keep the day it practises now"
          checked={form.keepWeekday}
          disabled={disabled}
          onChange={(on) => set({ keepWeekday: on, weekdays: on ? [] : form.weekdays })}
        />
      </CheckGroup>

      <CheckGroup legend="Start times (any of these)">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {form.startTimes.map((time, index) => (
            <li key={index} className="flex items-end gap-2">
              <div className="field">
                <label htmlFor={`${idPrefix}-start-${index}`}>Start time {index + 1}</label>
                <input
                  id={`${idPrefix}-start-${index}`}
                  type="time"
                  className="input"
                  value={time}
                  disabled={disabled || form.keepStart}
                  onChange={(event) =>
                    set({
                      startTimes: form.startTimes.map((item, at) =>
                        at === index ? event.target.value : item
                      ),
                    })
                  }
                />
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || form.keepStart}
                aria-label={`Remove start time ${index + 1}`}
                onClick={() => set({ startTimes: form.startTimes.filter((_, at) => at !== index) })}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || form.keepStart}
            onClick={() => set({ startTimes: [...form.startTimes, ''] })}
          >
            Add a start time
          </Button>
        </div>
        <Check
          id={`${idPrefix}-keep-start`}
          label="Keep the start time it has now"
          checked={form.keepStart}
          disabled={disabled}
          onChange={(on) => set({ keepStart: on, startTimes: on ? [] : form.startTimes })}
        />
      </CheckGroup>

      <CheckGroup legend="Venues (any of these)">
        {locations.length === 0 ? (
          <p className="text-sm text-text-muted m-0">This organization has no venues yet.</p>
        ) : (
          <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
            {locations.map((location) => (
              <Check
                key={location.id}
                id={`${idPrefix}-venue-${location.id}`}
                label={location.name}
                checked={form.venueIds.includes(location.id)}
                disabled={disabled || form.keepVenue}
                onChange={(on) => set({ venueIds: toggle(form.venueIds, location.id, on) })}
              />
            ))}
          </div>
        )}
        <Check
          id={`${idPrefix}-keep-venue`}
          label="Keep the venue it has now"
          checked={form.keepVenue}
          disabled={disabled}
          onChange={(on) => set({ keepVenue: on, venueIds: on ? [] : form.venueIds })}
        />
      </CheckGroup>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="field">
          <label htmlFor={`${idPrefix}-from`}>In force from (optional)</label>
          <input
            id={`${idPrefix}-from`}
            type="date"
            className="input"
            value={form.effectiveFrom}
            disabled={disabled}
            onChange={(event) => set({ effectiveFrom: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-until`}>In force until (optional)</label>
          <input
            id={`${idPrefix}-until`}
            type="date"
            className="input"
            value={form.effectiveTo}
            disabled={disabled}
            onChange={(event) => set({ effectiveTo: event.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

RuleForm.propTypes = {
  idPrefix: PropTypes.string.isRequired,
  form: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  locations: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string, name: PropTypes.string }))
    .isRequired,
  disabled: PropTypes.bool,
};
