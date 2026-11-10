/**
 * The mapping screen's choices (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.5 and 4.6; PR 6, tasks F2 and
 * F8): what an admin can say a label of the file is, what the screen opens on, and the decisions those choices are.
 *
 * Core decides what a label could mean (`proposeScheduleMapping`) and what the rows resolve to
 * (`resolveScheduleRows`); this module only turns a `<select>`'s value into the decision core and the database read,
 * and back. A choice is a string: `undecided`, `map:<id>`, `create`, `outside` (a team only) or `skip`.
 *
 * - **A label with exactly one match opens on "use existing"** (F8): core proposes it, and it is in effect unless the
 *   admin says otherwise.
 * - **A label with no match opens undecided.** Nothing is created because nobody decided: an undecided label's rows are
 *   listed as not imported, and a record is created only by a `create` or `outside` the admin chose, and only after
 *   the confirm step listed it.
 */

import { divisionDecisionKey, venueDecisionKey } from '@squadlogic/core/scheduleImport/mapping.js';

export const UNDECIDED = 'undecided';

/** The four groups of a mapping, in the order the screen and the database take them. */
export const MAPPING_GROUPS = Object.freeze([
  { group: 'divisions', kind: 'division', title: 'Divisions', noun: 'division' },
  { group: 'venues', kind: 'venue', title: 'Venues', noun: 'venue' },
  { group: 'fields', kind: 'field', title: 'Fields', noun: 'field' },
  { group: 'teams', kind: 'team', title: 'Teams', noun: 'team' },
]);

/**
 * A choice as the decision it is, or null for "not decided".
 *
 * @param {string | undefined} choice
 * @returns {{ action: string, id?: string } | null}
 */
export function decisionOfChoice(choice) {
  if (typeof choice !== 'string' || choice === UNDECIDED) return null;
  if (choice.startsWith('map:')) {
    const id = choice.slice(4);
    return id === '' ? null : { action: 'map', id };
  }
  return ['create', 'outside', 'skip'].includes(choice) ? { action: choice } : null;
}

/**
 * A decision as the choice a `<select>` shows.
 *
 * @param {{ action?: string, id?: string } | null | undefined} decision
 * @returns {string}
 */
export function choiceOfDecision(decision) {
  if (!decision || typeof decision.action !== 'string') return UNDECIDED;
  if (decision.action === 'map') return decision.id ? `map:${decision.id}` : UNDECIDED;
  return ['create', 'outside', 'skip'].includes(decision.action) ? decision.action : UNDECIDED;
}

/**
 * The admin's explicit choices as the decisions core reads (`{ divisions, venues, fields, teams }`).
 *
 * @param {Record<string, Record<string, string>>} choices
 */
export function decisionsFromChoices(choices) {
  /** @type {Record<string, Record<string, any>>} */
  const out = {};
  for (const { group } of MAPPING_GROUPS) {
    out[group] = {};
    for (const [key, choice] of Object.entries(choices?.[group] ?? {})) {
      const decision = decisionOfChoice(choice);
      // An explicit "not decided" is kept as a decision core cannot use, so it overrides a proposal: the admin
      // un-mapped the label, and its rows must not import through a match they turned down.
      out[group][key] = decision ?? { action: 'undecided' };
    }
  }
  return out;
}

/**
 * What is in effect for every label, as the database stores it: the admin's choice, else core's proposal, and nothing
 * for a label that has neither.
 *
 * @param {{ divisions: any[], venues: any[], fields: any[], teams: any[] }} proposal  `proposeScheduleMapping`'s result
 * @param {Record<string, Record<string, string>>} choices
 * @param {boolean} arrivePublished
 */
export function mappingForJob(proposal, choices, arrivePublished) {
  /** @type {Record<string, any>} */
  const mapping = { options: { arrive_published: arrivePublished === true } };
  for (const { group } of MAPPING_GROUPS) {
    mapping[group] = {};
    for (const entry of proposal[group] ?? []) {
      const decision = effectiveDecision(entry, choices?.[group]?.[entry.key]);
      if (decision) mapping[group][entry.key] = decision;
    }
  }
  return mapping;
}

/**
 * The decision in effect for one label: the admin's choice when they made one (an explicit "not decided" included),
 * else the proposal.
 *
 * @param {{ proposed: any }} entry
 * @param {string | undefined} choice
 * @returns {{ action: string, id?: string } | null}
 */
export function effectiveDecision(entry, choice) {
  if (typeof choice === 'string') return decisionOfChoice(choice);
  return entry.proposed ?? null;
}

/** The value a label's `<select>` shows. @param {{ proposed: any }} entry @param {string | undefined} choice */
export const shownChoice = (entry, choice) =>
  typeof choice === 'string' ? choice : choiceOfDecision(entry.proposed);

/**
 * The records a label could be mapped to: every record in its scope, not only the ones whose name matches (the admin
 * may know that "Lions FC" in the file is the team stored as "Lions").
 *
 * @param {any} entry  a `proposeScheduleMapping` entry
 * @param {import('@squadlogic/core/scheduleImport/mapping.js').LeagueView} league
 * @param {{ divisions: any[], venues: any[] }} proposal
 * @param {Record<string, Record<string, string>>} choices
 * @returns {Array<{ id: string, name: string, outside?: boolean }>}
 */
export function recordsInScope(entry, league, proposal, choices) {
  const byName = (a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id));
  if (entry.kind === 'division') return [...league.divisions].sort(byName);
  if (entry.kind === 'venue') return [...league.venues].sort(byName);
  /** The id the parent label is mapped to, when it is mapped to an existing record. */
  const parentId = (group, parentLabel) => {
    const key =
      group === 'venues' ? venueDecisionKey(parentLabel) : divisionDecisionKey(parentLabel);
    const parent = (proposal[group] ?? []).find((p) => p.key === key);
    if (!parent) return null;
    const decision = effectiveDecision(parent, choices?.[group]?.[parent.key]);
    return decision?.action === 'map' ? decision.id : null;
  };
  if (entry.kind === 'field') {
    const venueId = parentId('venues', entry.venueLabel);
    return league.fields.filter((f) => venueId !== null && f.venueId === venueId).sort(byName);
  }
  const divisionId = parentId('divisions', entry.divisionLabel);
  return league.teams
    .filter((t) => divisionId !== null && t.divisionId === divisionId)
    .map((t) => ({ id: t.id, name: t.name, outside: t.isExternal === true }))
    .sort(byName);
}

/**
 * The options of a label's `<select>`.
 *
 * @param {any} entry
 * @param {Array<{ id: string, name: string, outside?: boolean }>} records
 * @returns {Array<{ value: string, label: string }>}
 */
export function choiceOptions(entry, records) {
  const noun = MAPPING_GROUPS.find((g) => g.kind === entry.kind)?.noun ?? entry.kind;
  const options = [{ value: UNDECIDED, label: 'Not decided (its rows are not imported)' }];
  for (const record of records) {
    options.push({
      value: `map:${record.id}`,
      label: `Use existing ${record.outside ? 'outside club' : noun}: ${record.name}`,
    });
  }
  options.push({
    value: 'create',
    label:
      entry.kind === 'team'
        ? `Create the team "${entry.label}" (no players or coach yet)`
        : `Create the ${noun} "${entry.label}"`,
  });
  if (entry.kind === 'team') {
    options.push({ value: 'outside', label: 'Outside club (not one of your teams)' });
  }
  options.push({ value: 'skip', label: 'Skip its rows' });
  return options;
}

/**
 * Why a label has no usable decision, in words, or null.
 *
 * @param {any} entry
 * @returns {string | null}
 */
export function entryProblem(entry) {
  if (entry.problem === 'name-exists') {
    return 'A record of that name already exists here: use the existing one instead of creating another.';
  }
  if (entry.problem === 'unknown-id') {
    return 'The record chosen is not one of yours in this place. Choose again.';
  }
  if (entry.problem === 'invalid-decision') return 'This choice cannot be read. Choose again.';
  return null;
}
