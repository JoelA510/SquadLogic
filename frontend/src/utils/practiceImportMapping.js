/**
 * The Practices tab's mapping choices (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.11.5; PR 11, task L2): the
 * practice twin of `gameImportMapping.js`, for the five groups a practice file names.
 *
 * Core decides what a label could mean and what is proposed, and by whom (`proposePracticeMapping`: the exact name,
 * the alias file, the previous import's mapping); this module only turns a `<select>`'s value into the decision core
 * and the database read, and back. A choice is a string: `undecided`, `map:<id>`, `create` or `skip`.
 *
 * - **Only an exact single match opens on "use existing".** An alias or a previous mapping is shown beside the label
 *   with its source and applied only when the admin chooses it (decision 30); where two proposals disagree neither is
 *   chosen.
 * - **A label with no match opens undecided**, and its rows are listed as not imported. A record is created only by a
 *   `create` the admin chose, and only after the confirm step listed it and the admin ticked that list.
 * - **A stored decision carries its `source`** (`exact`, `alias`, `previous`, `admin`), so the audit says how each label
 *   was resolved.
 */

import {
  practiceDivisionDecisionKey,
  practiceFieldDecisionKey,
  practiceLocationDecisionKey,
} from '@squadlogic/core/practiceImport/mapping.js';

export const UNDECIDED = 'undecided';

/** The five groups of a practice mapping, in the order the screen and the database take them. */
export const PRACTICE_MAPPING_GROUPS = Object.freeze([
  { group: 'divisions', kind: 'division', title: 'Divisions', noun: 'division' },
  { group: 'locations', kind: 'location', title: 'Locations', noun: 'location' },
  { group: 'fields', kind: 'field', title: 'Fields', noun: 'field' },
  { group: 'subunits', kind: 'subunit', title: 'Halves and sides', noun: 'half or side' },
  { group: 'teams', kind: 'team', title: 'Teams', noun: 'team' },
]);

/** What each proposal's source is called on screen. */
export const PROPOSAL_SOURCE_WORDS = Object.freeze({
  exact: 'the exact name',
  alias: 'the alias file',
  previous: 'the previous import',
});

/**
 * A `map` choice's source: the proposals that name the same record say where it came from (the exact name first);
 * anything else is the admin's own choice.
 *
 * @param {any} entry
 * @param {string} id
 * @returns {'exact' | 'alias' | 'previous' | 'admin'}
 */
function sourceOf(entry, id) {
  const sources = (entry?.proposals ?? []).filter((p) => p.id === id).map((p) => p.source);
  for (const source of /** @type {const} */ (['exact', 'alias', 'previous'])) {
    if (sources.includes(source)) return source;
  }
  return 'admin';
}

/**
 * A choice as the decision it is, or null for "not decided".
 *
 * @param {string | undefined} choice
 * @param {any} [entry]  the label's entry, for the source of a `map`
 * @returns {{ action: string, id?: string, source: string } | null}
 */
export function decisionOfChoice(choice, entry) {
  if (typeof choice !== 'string' || choice === UNDECIDED) return null;
  if (choice.startsWith('map:')) {
    const id = choice.slice(4);
    return id === '' ? null : { action: 'map', id, source: sourceOf(entry, id) };
  }
  return ['create', 'skip'].includes(choice) ? { action: choice, source: 'admin' } : null;
}

/**
 * The admin's explicit choices as the decisions core reads. An explicit "not decided" is kept as a decision core cannot
 * use, so it overrides an exact match the admin turned down (`shownProblem` does not call that a problem).
 *
 * @param {Record<string, Record<string, string>>} choices
 * @param {Record<string, any[]>} [entries]  the last proposal, for each `map`'s source
 */
export function decisionsFromChoices(choices, entries) {
  /** @type {Record<string, Record<string, any>>} */
  const out = {};
  for (const { group } of PRACTICE_MAPPING_GROUPS) {
    out[group] = {};
    for (const [key, choice] of Object.entries(choices?.[group] ?? {})) {
      const entry = (entries?.[group] ?? []).find((e) => e.key === key);
      out[group][key] = decisionOfChoice(choice, entry) ?? { action: 'undecided' };
    }
  }
  return out;
}

/** The value a label's `<select>` shows: the admin's choice, else what is in effect (an exact match), else undecided. */
export function shownChoice(entry, choice) {
  if (typeof choice === 'string') return choice;
  const e = entry.effective;
  if (e?.action === 'map' && e.id) return `map:${e.id}`;
  if (e?.action === 'create' || e?.action === 'skip') return e.action;
  return UNDECIDED;
}

/**
 * The mapping the job stores: for every label the decision in effect (the admin's, else an exact match nothing
 * disagrees with), and the ticked probable moves. A label with neither has no decision, and its rows are `unknown-*`.
 *
 * @param {Record<string, any[]>} proposal  `proposePracticeMapping`'s result (made with the admin's decisions)
 * @param {Record<string, Record<string, string>>} choices
 * @param {string[]} addMovedRows  the row keys of the ticked probable-move rows, and nothing else
 */
export function practiceMappingForJob(proposal, choices, addMovedRows) {
  /** @type {Record<string, any>} */
  const mapping = { options: { add_moved_rows: [...new Set(addMovedRows)].sort() } };
  for (const { group } of PRACTICE_MAPPING_GROUPS) {
    mapping[group] = {};
    for (const entry of proposal[group] ?? []) {
      const choice = choices?.[group]?.[entry.key];
      const decision =
        typeof choice === 'string' ? decisionOfChoice(choice, entry) : (entry.effective ?? null);
      if (!decision) continue;
      /** @type {Record<string, string>} */
      const stored = { action: decision.action, source: decision.source ?? 'admin' };
      if (decision.action === 'map' && decision.id) stored.id = decision.id;
      if (decision.action === 'create' && decision.name) stored.name = decision.name;
      mapping[group][entry.key] = stored;
    }
  }
  return mapping;
}

/**
 * The records a label could be mapped to: every record in its scope (the location a field is in, the field a half is
 * on, the division a team is in), as the label's parent is mapped now. An outside club is never a practice team.
 *
 * @param {any} entry
 * @param {any} league  `readPracticeImportLeague`'s result
 * @param {Record<string, any[]>} proposal
 * @param {Record<string, Record<string, string>>} choices
 * @returns {Array<{ id: string, name: string }>}
 */
export function recordsInScope(entry, league, proposal, choices) {
  const byName = (a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id));
  if (entry.kind === 'division') return [...league.divisions].sort(byName);
  if (entry.kind === 'location') return [...league.locations].sort(byName);
  /** The id the parent label is mapped to, when it is mapped to an existing record. */
  const parentId = (group, key) => {
    const parent = (proposal[group] ?? []).find((p) => p.key === key);
    if (!parent) return null;
    const shown = shownChoice(parent, choices?.[group]?.[parent.key]);
    return shown.startsWith('map:') ? shown.slice(4) : null;
  };
  if (entry.kind === 'field') {
    const locationId = parentId('locations', practiceLocationDecisionKey(entry.locationLabel));
    return league.fields
      .filter((f) => locationId !== null && f.locationId === locationId)
      .sort(byName);
  }
  if (entry.kind === 'subunit') {
    const fieldId = parentId(
      'fields',
      practiceFieldDecisionKey(entry.locationLabel, entry.fieldLabel)
    );
    return league.subunits.filter((s) => fieldId !== null && s.fieldId === fieldId).sort(byName);
  }
  const divisionId = parentId('divisions', practiceDivisionDecisionKey(entry.divisionLabel));
  return league.teams
    .filter((t) => divisionId !== null && t.divisionId === divisionId && t.isExternal !== true)
    .map((t) => ({ id: t.id, name: t.name }))
    .sort(byName);
}

/**
 * The options of a label's `<select>`.
 *
 * @param {any} entry
 * @param {Array<{ id: string, name: string }>} records
 * @returns {Array<{ value: string, label: string }>}
 */
export function choiceOptions(entry, records) {
  const noun = PRACTICE_MAPPING_GROUPS.find((g) => g.kind === entry.kind)?.noun ?? entry.kind;
  const options = [{ value: UNDECIDED, label: 'Not decided (its rows are not imported)' }];
  for (const record of records) {
    options.push({ value: `map:${record.id}`, label: `Use existing ${noun}: ${record.name}` });
  }
  options.push({
    value: 'create',
    label:
      entry.kind === 'team'
        ? `Create the team "${entry.label}" (no players or coach yet)`
        : entry.kind === 'location' || entry.kind === 'field'
          ? `Create the ${noun} "${entry.label}" (no coordinates)`
          : `Create the ${noun} "${entry.label}"`,
  });
  options.push({ value: 'skip', label: 'Skip its rows' });
  return options;
}

/**
 * The proposals of a label, in words: who proposes which record. Two that disagree are both said, and neither chosen.
 *
 * @param {any} entry
 * @param {any} league
 * @returns {string | null}
 */
export function proposalWords(entry, league) {
  const proposals = entry.proposals ?? [];
  if (proposals.length === 0) return null;
  const list =
    {
      division: league.divisions,
      location: league.locations,
      field: league.fields,
      subunit: league.subunits,
      team: league.teams,
    }[entry.kind] ?? [];
  const nameOf = (id) => list.find((r) => r.id === id)?.name ?? 'a record that is gone';
  const said = proposals.map(
    (p) => `${PROPOSAL_SOURCE_WORDS[p.source] ?? p.source}: ${nameOf(p.id)}`
  );
  return entry.conflict
    ? `Proposals disagree, so none is chosen (${said.join('; ')}).`
    : `Proposed by ${said.join('; ')}.`;
}

/**
 * Why a label has no usable decision, in words, or null. An explicit "not decided" is the admin's choice, not a problem.
 *
 * @param {any} entry
 * @param {string | undefined} choice
 * @returns {string | null}
 */
export function shownProblem(entry, choice) {
  if (choice === UNDECIDED) return null;
  if (entry.problem === 'name-exists') {
    return 'A record of that name already exists here: use the existing one instead of creating another.';
  }
  if (entry.problem === 'name-taken-by-outside-club') {
    return 'An outside club of that name is in this division, and a team cannot share its name.';
  }
  if (entry.problem === 'unknown-id') {
    return 'The record chosen is not one of yours in this place. Choose again.';
  }
  if (entry.problem === 'invalid-decision') return 'This choice cannot be read. Choose again.';
  return null;
}
