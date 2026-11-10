/**
 * Mapping a schedule file's labels to the organization's divisions, venues, fields and teams (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` sections 4.5 and 4.6; PR 4, task D2).
 *
 * A game needs two teams, a team needs a division, a slot needs a field, and an organization that
 * arrives with a schedule may have none of them yet. This module says, for every distinct label in the
 * file, what the organization has that it could mean, proposes only when that is certain, and then
 * resolves each row against the admin's decisions. It never creates anything: it lists what a
 * confirmed import would create (`creations`) and the writer (PR 5) does it.
 *
 * ## The one rule, and what it will not do
 *
 * There is exactly one normalisation, `normaliseExternalLabel` (`externalImport/mapping.js`):
 * trim, collapse runs of whitespace to one space, fold case. It removes **no word**. `Park Back` and
 * `Park Front` are two venues; `Park` is neither of them. A matcher that treats `Back` as decoration
 * gets one file right and merges two real places in the next (the lesson is in that module's header);
 * so a label that is not exactly one record's name is not proposed, however close it looks.
 *
 * - **Exactly one match** is proposed (`status: 'match'`) and is effective unless the admin decides
 *   otherwise.
 * - **More than one** is `ambiguous`; **none** is `none`. Neither is proposed, and their rows stay
 *   `unknown-*` until the admin decides: pick a record, create one, skip, or (a team only) say it is
 *   an outside club.
 * - **A team is judged inside its division** (`UNIQUE (division_id, name)`: two divisions may each
 *   have a `Lions`), a **field inside its venue**.
 * - **An outside club** (decision 5) is a team row flagged `is_external`, one per division and club
 *   label. An outside club whose name (the decision's `name`, else the label) is the name of an own
 *   team in that division, or of a team this file creates there, is `label-is-own-team`, never an
 *   outside club; a game between two outside clubs is not one of yours.
 *   An outside team that already exists (a previous import made it) is found and reused.
 * - **Skipped is not refused.** Rows of a label the admin skips are listed apart from the rows the
 *   import refuses.
 *
 * ## What a decision is
 *
 * `{ action: 'map', id }`, `{ action: 'create', name? }`, `{ action: 'skip' }`, and for a team
 * `{ action: 'outside' }`, kept under the key a `*DecisionKey` function builds from the labels as
 * typed. A decision naming an id the league does not hold is not trusted: the row is `unknown-*`.
 *
 * ## Ids
 *
 * A resolved row carries `ids`. An existing record has its own id; one the import would create has
 * a stable placeholder, `new:<kind>:<tuple>`, so the conflict audit can run on the rows before
 * anything is written and run again, over the saved rows, after. The tuple is the JSON array of the
 * parent ids and the FINAL name (`new:team:["<division id>","sharks"]`): a record is identified by
 * what it will be, not by the label of the file that reached it, so two labels mapped to one division
 * and a team created under each are one team to create (`UNIQUE (division_id, name)`), and a created
 * team under a created division coalesces the same way. Composite keys everywhere in this module are
 * such tuples, never strings joined by a delimiter a label might contain.
 *
 * `creations` lists, per kind, one record per id: `{ id, key, name }` plus `venueId` for a field and
 * `divisionId` for a team or an outside team (an existing parent's id, or the placeholder of one the
 * import would create).
 *
 * Not checked here: a `create` whose final name is already an existing record's name under the same
 * parent, and a team shell and an outside club created under one name in one division. Both would meet
 * `UNIQUE (division_id, name)` in the writer (PR 5).
 */

import { normaliseExternalLabel } from '../externalImport/mapping.js';
import { SCHEDULE_IMPORT_REASON as R } from './reasonCodes.js';

/**
 * The key a label is matched and decided under.
 *
 * @param {unknown} label
 * @returns {string}  `''` for a blank or missing label
 */
export function scheduleLabelKey(label) {
  return label === undefined || label === null ? '' : normaliseExternalLabel(String(label));
}

/**
 * A composite key: the parts as a JSON array. Joining labels with a delimiter is ambiguous the moment
 * a label contains the delimiter (`U10|Boys` + `Lions` and `U10` + `Boys|Lions` are one string), and
 * a team or field would then resolve through the other's cached reference. An array of strings
 * round-trips, so two different tuples are never one key.
 *
 * @param {...string} parts
 * @returns {string}
 */
const tuple = (...parts) => JSON.stringify(parts);

/** @param {string} divisionLabel */
export const divisionDecisionKey = (divisionLabel) => scheduleLabelKey(divisionLabel);
/** @param {string} venueLabel */
export const venueDecisionKey = (venueLabel) => scheduleLabelKey(venueLabel);
/** @param {string} venueLabel @param {string} fieldLabel */
export const fieldDecisionKey = (venueLabel, fieldLabel) =>
  tuple(scheduleLabelKey(venueLabel), scheduleLabelKey(fieldLabel));
/** @param {string} divisionLabel @param {string} teamLabel */
export const teamDecisionKey = (divisionLabel, teamLabel) =>
  tuple(scheduleLabelKey(divisionLabel), scheduleLabelKey(teamLabel));

const ACTIONS = Object.freeze({
  division: ['map', 'create', 'skip'],
  venue: ['map', 'create', 'skip'],
  field: ['map', 'create', 'skip'],
  team: ['map', 'create', 'outside', 'skip'],
});
const GROUP_OF = Object.freeze({
  division: 'divisions',
  venue: 'venues',
  field: 'fields',
  team: 'teams',
});

/**
 * @typedef {Object} LeagueView  what the organization has, as the mapping step reads it
 * @property {Array<{ id: string, name: string }>} divisions
 * @property {Array<{ id: string, name: string, divisionId: string, isExternal?: boolean }>} teams
 * @property {Array<{ id: string, name: string }>} venues
 * @property {Array<{ id: string, venueId: string, name: string }>} fields
 */

/** @param {unknown} value @param {string} what */
function requireArray(value, what) {
  if (!Array.isArray(value))
    throw new TypeError(`scheduleImport mapping: ${what} must be an array`);
  return value;
}

/** @param {LeagueView} league */
function indexLeague(league) {
  if (!league || typeof league !== 'object') {
    throw new TypeError('scheduleImport mapping: league must be an object');
  }
  const divisions = requireArray(league.divisions, 'league.divisions');
  const teams = requireArray(league.teams, 'league.teams');
  const venues = requireArray(league.venues, 'league.venues');
  const fields = requireArray(league.fields, 'league.fields');
  /** @param {Array<any>} list @param {(x: any) => string} scope */
  const groupBy = (list, scope) => {
    const out = new Map();
    for (const item of list) {
      const key = tuple(scope(item), scheduleLabelKey(item.name));
      out.set(key, [...(out.get(key) ?? []), item]);
    }
    return out;
  };
  return {
    divisionsById: new Map(divisions.map((d) => [d.id, d])),
    teamsById: new Map(teams.map((t) => [t.id, t])),
    venuesById: new Map(venues.map((v) => [v.id, v])),
    fieldsById: new Map(fields.map((f) => [f.id, f])),
    divisionsByName: groupBy(divisions, () => ''),
    venuesByName: groupBy(venues, () => ''),
    teamsByName: groupBy(teams, (t) => t.divisionId),
    fieldsByName: groupBy(fields, (f) => f.venueId),
  };
}

/**
 * The decision stored under a key, and whether one was stored that cannot be read.
 *
 * A decision that is there but is not one of the kind's actions (a typo, `outside` on a division, a
 * `map` with no id) is `invalid`, and the label then has NO effective decision: it must not fall back
 * to the proposal the admin chose not to take. Only the three fields this module reads are kept, and a
 * name only if it is non-blank text (a decision is stored data).
 *
 * @param {Record<string, any> | undefined} decisions
 * @param {'division' | 'venue' | 'field' | 'team'} kind
 * @param {string} key
 * @returns {{ decision: { action: string, id?: string, name?: string } | null, invalid: boolean }}
 */
function decisionFor(decisions, kind, key) {
  const group = decisions?.[GROUP_OF[kind]];
  if (!group || !Object.hasOwn(group, key)) return { decision: null, invalid: false };
  const raw = group[key];
  const readable =
    raw !== null &&
    typeof raw === 'object' &&
    ACTIONS[kind].includes(raw.action) &&
    (raw.action !== 'map' || typeof raw.id === 'string');
  if (!readable) return { decision: null, invalid: true };
  /** @type {{ action: string, id?: string, name?: string }} */
  const kept = { action: raw.action };
  if (typeof raw.id === 'string') kept.id = raw.id;
  if (typeof raw.name === 'string' && raw.name.trim() !== '') kept.name = raw.name.trim();
  return { decision: kept, invalid: false };
}

/**
 * @typedef {Object} MappingEntry  one distinct label of the file and what can be done with it
 * @property {'division' | 'venue' | 'field' | 'team'} kind
 * @property {string} key  the key to put a decision under
 * @property {string} label  the first spelling seen, trimmed
 * @property {string} [venueLabel]  for a field
 * @property {string} [divisionLabel]  for a team
 * @property {number} rowCount
 * @property {'match' | 'ambiguous' | 'none'} status
 * @property {Array<{ id: string, name: string }>} candidates
 * @property {{ action: string, id?: string } | null} proposed  only for an exact, single match
 * @property {{ action: string, id?: string, name?: string } | null} decision  the admin's
 * @property {{ action: string, id?: string, name?: string } | null} effective  the decision, else the proposal
 * @property {string[]} options
 * @property {'unknown-id' | 'invalid-decision' | 'name-exists'} [problem]  why the label has no usable
 *   decision: a `map` names a record that is not there, the stored decision cannot be read, or a `create`
 *   names a record that already exists under the same parent
 */

/** What a label resolves to once decisions are applied. */
const SKIP = Object.freeze({ type: 'skip' });

/**
 * Everything the mapping step knows: the entries to show and the references rows resolve through.
 *
 * @param {{ rows: Array<any>, league: LeagueView, decisions?: Record<string, any> }} input
 */
function analyse({ rows, league, decisions }) {
  requireArray(rows, 'rows');
  const world = indexLeague(league);
  const usable = rows.filter((r) => r.status === 'ok' || r.status === 'tbd');

  /** @type {Map<string, MappingEntry>} */
  const divisionEntries = new Map();
  /** @type {Map<string, MappingEntry>} */
  const venueEntries = new Map();
  /** @type {Map<string, MappingEntry>} */
  const fieldEntries = new Map();
  /** @type {Map<string, MappingEntry>} */
  const teamEntries = new Map();
  /** key -> a reference (or SKIP, or null when unresolved) */
  const refs = { division: new Map(), venue: new Map(), field: new Map(), team: new Map() };

  /**
   * @param {Map<string, MappingEntry>} entries
   * @param {Object} spec
   */
  function entryFor(entries, { kind, key, label, extra, candidates }) {
    let entry = entries.get(key);
    if (entry) {
      entry.rowCount += 1;
      return entry;
    }
    const { decision, invalid } = decisionFor(decisions, kind, key);
    const status =
      candidates.length === 0 ? 'none' : candidates.length === 1 ? 'match' : 'ambiguous';
    const proposed = status === 'match' ? { action: 'map', id: candidates[0].id } : null;
    entry = {
      kind,
      key,
      label,
      ...extra,
      rowCount: 1,
      status,
      candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
      proposed,
      decision,
      effective: invalid ? null : (decision ?? proposed),
      options: [...ACTIONS[kind]],
      ...(invalid ? { problem: 'invalid-decision' } : {}),
    };
    entries.set(key, entry);
    return entry;
  }

  /**
   * The reference an entry's effective decision gives, or null when the label is unresolved.
   * @param {MappingEntry} entry
   * @param {(id: string) => boolean} holds  does the league hold this id, in this scope
   * @param {(id: string) => any} existing  the reference for an id
   * @param {() => any} created  the reference for a record the import would create
   */
  function refOf(entry, holds, existing, created) {
    const e = entry.effective;
    if (!e) return null;
    if (e.action === 'skip') return SKIP;
    if (e.action === 'map') {
      if (typeof e.id === 'string' && holds(e.id)) return existing(e.id);
      entry.problem = 'unknown-id';
      return null;
    }
    if (e.action === 'create') return created();
    return null;
  }

  /**
   * The reference to a record the import would create. Its identity is its kind, its parent and its
   * FINAL name (the decision's `name`, else the label as typed), never the label it was reached by:
   * two labels of the file that the admin maps to one division, and a team created under each, are one
   * team to create (`UNIQUE (division_id, name)`), and the audit must see it as one team. Decisions stay
   * keyed by label; only what is created is coalesced.
   *
   * @param {'division' | 'venue' | 'field' | 'team' | 'outside'} kind
   * @param {MappingEntry} entry
   * @param {string[]} parents  the ids of the records it lives under, outermost first (a created
   *   parent's id is its own placeholder, so a created team under a created division coalesces too)
   * @param {Record<string, string>} extra
   * @param {(nameKey: string) => unknown[]} existingNamed  the records of this kind already under the
   *   parent with that name: creating one more would meet `UNIQUE (parent, name)` in the writer
   */
  function createdRef(kind, entry, parents, extra, existingNamed) {
    const name = entry.effective?.name ?? entry.label;
    const key = scheduleLabelKey(name);
    if (existingNamed(key).length > 0) {
      entry.problem = 'name-exists';
      return null;
    }
    return {
      type: kind === 'outside' ? 'outside' : 'create',
      id: `new:${kind}:${tuple(...parents, key)}`,
      key,
      name,
      ...extra,
    };
  }

  // Divisions, then venues, then fields (a field is judged in its venue), then teams (in their division).
  for (const r of usable) {
    const key = scheduleLabelKey(r.divisionLabel);
    if (key === '') continue;
    const entry = entryFor(divisionEntries, {
      kind: 'division',
      key,
      label: r.divisionLabel,
      extra: {},
      candidates: world.divisionsByName.get(tuple('', key)) ?? [],
    });
    if (!refs.division.has(key)) {
      refs.division.set(
        key,
        refOf(
          entry,
          (id) => world.divisionsById.has(id),
          (id) => ({ type: 'existing', id }),
          () =>
            createdRef(
              'division',
              entry,
              [],
              {},
              (k) => world.divisionsByName.get(tuple('', k)) ?? []
            )
        )
      );
    }
  }

  for (const r of usable) {
    if (r.status !== 'ok') continue; // a TIME TBD game is not placed, so no venue or field is asked of it
    const venueKey = scheduleLabelKey(r.venueLabel);
    if (venueKey === '') continue;
    const venueEntry = entryFor(venueEntries, {
      kind: 'venue',
      key: venueKey,
      label: r.venueLabel,
      extra: {},
      candidates: world.venuesByName.get(tuple('', venueKey)) ?? [],
    });
    if (!refs.venue.has(venueKey)) {
      refs.venue.set(
        venueKey,
        refOf(
          venueEntry,
          (id) => world.venuesById.has(id),
          (id) => ({ type: 'existing', id }),
          () =>
            createdRef(
              'venue',
              venueEntry,
              [],
              {},
              (k) => world.venuesByName.get(tuple('', k)) ?? []
            )
        )
      );
    }
  }

  for (const r of usable) {
    if (r.status !== 'ok') continue;
    const venueKey = scheduleLabelKey(r.venueLabel);
    const fieldKey = scheduleLabelKey(r.fieldLabel);
    const venueRef = refs.venue.get(venueKey);
    if (venueKey === '' || fieldKey === '' || !venueRef || venueRef === SKIP) continue;
    const key = fieldDecisionKey(r.venueLabel, r.fieldLabel);
    const candidates =
      venueRef.type === 'existing'
        ? (world.fieldsByName.get(tuple(venueRef.id, fieldKey)) ?? [])
        : [];
    const entry = entryFor(fieldEntries, {
      kind: 'field',
      key,
      label: r.fieldLabel,
      extra: { venueLabel: r.venueLabel },
      candidates,
    });
    if (!refs.field.has(key)) {
      refs.field.set(
        key,
        refOf(
          entry,
          (id) => world.fieldsById.get(id)?.venueId === venueRef.id,
          (id) => ({ type: 'existing', id }),
          () =>
            createdRef('field', entry, [venueRef.id], { venueId: venueRef.id }, (k) =>
              venueRef.type === 'existing'
                ? (world.fieldsByName.get(tuple(venueRef.id, k)) ?? [])
                : []
            )
        )
      );
    }
  }

  for (const r of usable) {
    const divisionKey = scheduleLabelKey(r.divisionLabel);
    const divisionRef = refs.division.get(divisionKey);
    if (!divisionRef || divisionRef === SKIP) continue;
    for (const label of [r.homeLabel, r.awayLabel]) {
      const teamKey = scheduleLabelKey(label);
      if (teamKey === '') continue;
      const key = teamDecisionKey(r.divisionLabel, label);
      const candidates =
        divisionRef.type === 'existing'
          ? (world.teamsByName.get(tuple(divisionRef.id, teamKey)) ?? [])
          : [];
      /** the teams (own or outside) already in the division with a given name */
      const namedHere = (/** @type {string} */ k) =>
        divisionRef.type === 'existing'
          ? (world.teamsByName.get(tuple(divisionRef.id, k)) ?? [])
          : [];
      const entry = entryFor(teamEntries, {
        kind: 'team',
        key,
        label,
        extra: { divisionLabel: r.divisionLabel },
        candidates,
      });
      if (refs.team.has(key)) continue;
      const e = entry.effective;
      if (e?.action === 'outside') {
        // An outside club already on file is reused; an own team's name is not an outside club. The
        // NAME is judged, as the SQL judges it (`cname`): the decision's own name when it carries one,
        // else the label (PR 6, task F3b: a custom name that is an own team's was `unknown-team` here
        // and `label-is-own-team` in the SQL).
        const named = namedHere(scheduleLabelKey(e.name ?? label));
        const own = named.filter((c) => !c.isExternal);
        const external = named.filter((c) => c.isExternal);
        if (own.length > 0) {
          refs.team.set(key, { type: 'own-name', label });
        } else if (external.length === 1) {
          refs.team.set(key, { type: 'existing', id: external[0].id, outside: true });
        } else {
          refs.team.set(
            key,
            createdRef(
              'outside',
              entry,
              [divisionRef.id],
              { divisionId: divisionRef.id },
              namedHere
            )
          );
        }
        continue;
      }
      refs.team.set(
        key,
        refOf(
          entry,
          (id) => world.teamsById.get(id)?.divisionId === divisionRef.id,
          (id) => ({
            type: 'existing',
            id,
            outside: world.teamsById.get(id)?.isExternal === true,
          }),
          () =>
            createdRef('team', entry, [divisionRef.id], { divisionId: divisionRef.id }, namedHere)
        )
      );
    }
  }

  // An outside club whose name a team shell of this same file takes in the division is refused as one
  // named like an own team (the SQL's `shell_here`): `UNIQUE (division_id, name)` holds for both, and
  // the shell is the one created.
  const shellNames = new Set(
    [...refs.team.values()]
      .filter((ref) => ref && ref.type === 'create')
      .map((ref) => tuple(ref.divisionId, ref.key))
  );
  for (const [key, ref] of refs.team) {
    if (ref && ref.type === 'outside' && shellNames.has(tuple(ref.divisionId, ref.key))) {
      refs.team.set(key, { type: 'own-name', label: teamEntries.get(key)?.label ?? ref.name });
    }
  }

  return { world, refs, divisionEntries, venueEntries, fieldEntries, teamEntries };
}

/** @param {Map<string, MappingEntry>} entries */
const sortedEntries = (entries) =>
  [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/**
 * For every distinct label of the file: what the organization has that it could mean, what is
 * proposed (only an exact, single match), what the admin decided, and what is therefore in effect.
 *
 * @param {{ rows: Array<any>, league: LeagueView, decisions?: Record<string, any> }} input
 *   `rows` are the parse's rows; only the ones it accepted are asked about
 * @returns {{ divisions: MappingEntry[], venues: MappingEntry[], fields: MappingEntry[], teams: MappingEntry[] }}
 */
export function proposeScheduleMapping({ rows, league, decisions = {} }) {
  const { divisionEntries, venueEntries, fieldEntries, teamEntries } = analyse({
    rows,
    league,
    decisions,
  });
  return {
    divisions: sortedEntries(divisionEntries),
    venues: sortedEntries(venueEntries),
    fields: sortedEntries(fieldEntries),
    teams: sortedEntries(teamEntries),
  };
}

/**
 * @typedef {Object} ResolvedScheduleRow  a parsed row, resolved
 * @property {string | null} reason
 * @property {{ division: string, field: string | null, home: string, away: string } | null} ids
 *   an existing record's id, or a `new:` placeholder for one the import would create
 * @property {{ kind: string, label: string } | null} skippedBecause
 */

/**
 * Resolve every row of a parse against the league and the admin's decisions.
 *
 * Order within a row: division, venue, field, home team, away team, then the two teams as a pair.
 * The first to fail is the row's reason; a label the admin skipped makes the row `skipped`.
 *
 * @param {{ rows: Array<any>, league: LeagueView, decisions?: Record<string, any> }} input
 * @returns {{
 *   rows: Array<any>,
 *   creations: { divisions: any[], venues: any[], fields: any[], teamShells: any[], outsideTeams: any[] },
 *   counts: { rows: number, ok: number, tbd: number, refused: number, skipped: number, byReason: Record<string, number> },
 * }}
 */
export function resolveScheduleRows({ rows, league, decisions = {} }) {
  const { refs, divisionEntries, venueEntries, fieldEntries, teamEntries } = analyse({
    rows,
    league,
    decisions,
  });
  /**
   * Why a label is unresolved, in words: a decision that cannot be read or a name that is taken says
   * so, instead of the generic "not one of yours".
   * @param {Map<string, MappingEntry>} entries
   */
  const whyNot = (entries, key, kind, label, fallback) => {
    const problem = entries.get(key)?.problem;
    const quoted = JSON.stringify(label);
    if (problem === 'invalid-decision') {
      return `The decision saved for the ${kind} ${quoted} is not one this step can read. Decide again.`;
    }
    if (problem === 'unknown-id') {
      return `The record chosen for the ${kind} ${quoted} is not one of yours. Decide again.`;
    }
    if (problem === 'name-exists') {
      const name = JSON.stringify(entries.get(key)?.effective?.name ?? label);
      return `A ${kind} named ${name} already exists here. Map ${quoted} to it instead of creating another.`;
    }
    return fallback;
  };

  /** @type {Array<{ row: any, refs?: any }>} */
  const resolved = rows.map((row) => {
    if (row.status === 'refused') return { row: { ...row, ids: null, skippedBecause: null } };
    const keep = (changes) => ({ ...row, ids: null, skippedBecause: null, ...changes });
    const refuse = (reason, message) => ({
      row: keep({ status: 'refused', reason, message, tbdReason: null, flags: [] }),
    });
    const skip = (kind, label) => ({
      row: keep({
        status: 'skipped',
        reason: null,
        message: null,
        tbdReason: null,
        flags: [],
        skippedBecause: { kind, label },
      }),
    });

    const divisionKey = scheduleLabelKey(row.divisionLabel);
    if (divisionKey === '') return refuse(R.UNKNOWN_DIVISION, 'The Division is blank.');
    const division = refs.division.get(divisionKey);
    if (division === SKIP) return skip('division', row.divisionLabel);
    if (!division) {
      return refuse(
        R.UNKNOWN_DIVISION,
        whyNot(
          divisionEntries,
          divisionKey,
          'division',
          row.divisionLabel,
          `The division ${JSON.stringify(row.divisionLabel)} is not one of yours. Map it to a division, create it, or skip its rows.`
        )
      );
    }

    /** @type {any} */
    let field = null;
    if (row.status === 'ok') {
      const venueKey = scheduleLabelKey(row.venueLabel);
      if (venueKey === '') return refuse(R.UNKNOWN_VENUE, 'The Venue is blank.');
      const venue = refs.venue.get(venueKey);
      if (venue === SKIP) return skip('venue', row.venueLabel);
      if (!venue) {
        return refuse(
          R.UNKNOWN_VENUE,
          whyNot(
            venueEntries,
            venueKey,
            'venue',
            row.venueLabel,
            `The venue ${JSON.stringify(row.venueLabel)} is not one of yours. Map it to a venue, create it, or skip its rows.`
          )
        );
      }
      const fieldRef = refs.field.get(fieldDecisionKey(row.venueLabel, row.fieldLabel));
      if (fieldRef === SKIP) return skip('field', row.fieldLabel);
      if (!fieldRef) {
        return refuse(
          R.UNKNOWN_FIELD,
          whyNot(
            fieldEntries,
            fieldDecisionKey(row.venueLabel, row.fieldLabel),
            'field',
            row.fieldLabel,
            `The field ${JSON.stringify(row.fieldLabel)} is not one of ${JSON.stringify(row.venueLabel)}'s. Map it to a field, create it, or skip its rows.`
          )
        );
      }
      field = fieldRef;
    }

    /** @type {any[]} */
    const sides = [];
    for (const [which, label] of [
      ['Home', row.homeLabel],
      ['Away', row.awayLabel],
    ]) {
      const teamKey = scheduleLabelKey(label);
      if (teamKey === '') return refuse(R.UNKNOWN_TEAM, `The ${which} Team is blank.`);
      const team = refs.team.get(teamDecisionKey(row.divisionLabel, label));
      if (team === SKIP) return skip('team', label);
      if (!team) {
        return refuse(
          R.UNKNOWN_TEAM,
          whyNot(
            teamEntries,
            teamDecisionKey(row.divisionLabel, label),
            'team',
            label,
            `The team ${JSON.stringify(label)} is not one of your teams in ${JSON.stringify(row.divisionLabel)}. Map it to a team, create it, mark it an outside club, or skip its rows.`
          )
        );
      }
      if (team.type === 'own-name') {
        return refuse(
          R.LABEL_IS_OWN_TEAM,
          `${JSON.stringify(label)} was marked as an outside club, but ${JSON.stringify(row.divisionLabel)} has a team of that name. Map it to that team instead.`
        );
      }
      sides.push(team);
    }
    const [home, away] = sides;
    const outside = (t) => t.type === 'outside' || t.outside === true;
    if (outside(home) && outside(away)) {
      return refuse(
        R.UNKNOWN_TEAM,
        'Neither team is one of yours: both are outside clubs. A game needs at least one of your teams.'
      );
    }
    if (home.id === away.id) {
      return refuse(R.SAME_TEAM, 'The home and away teams were mapped to the same team.');
    }
    return {
      row: keep({
        ids: {
          division: division.id,
          field: field ? field.id : null,
          home: home.id,
          away: away.id,
        },
      }),
      refs: { division, field, home, away },
    };
  });

  // The same game twice by the admin's own mapping (two labels mapped onto one team): the first
  // wins, as in the parse, which compared the labels as typed.
  const seen = new Set();
  for (const item of resolved) {
    const r = item.row;
    if (!r.ids || (r.status !== 'ok' && r.status !== 'tbd')) continue;
    // null stays null in the tuple, so a game with no field or time is never an id spelled "tbd"
    // A TIME TBD game is not placed (no field), and two of one pair on one day are told apart by their
    // Game ID, as in the parse.
    const key =
      r.status === 'tbd'
        ? JSON.stringify(['tbd', r.ids.home, r.ids.away, r.date, r.startTime, r.gameId])
        : JSON.stringify([r.ids.home, r.ids.away, r.ids.field, r.date, r.startTime]);
    if (seen.has(key)) {
      Object.assign(r, {
        status: 'refused',
        reason: R.DUPLICATE_ROW,
        message:
          'After mapping, this is the same game as an earlier row; the earlier row is the one imported.',
        tbdReason: null,
        flags: [],
        ids: null,
      });
      item.refs = undefined;
    } else {
      seen.add(key);
    }
  }

  // What a confirmed import would create: one record per kind, parent and final name, from the rows
  // that survive. A record reached through two labels keeps the first spelling seen.
  const creations = {
    divisions: new Map(),
    venues: new Map(),
    fields: new Map(),
    teamShells: new Map(),
    outsideTeams: new Map(),
  };
  /** @param {Map<string, any>} map @param {any} ref @param {Record<string, string>} [parent] */
  const note = (map, ref, parent = {}) => {
    if (!map.has(ref.id)) map.set(ref.id, { id: ref.id, ...parent, key: ref.key, name: ref.name });
  };
  for (const { row, refs: used } of resolved) {
    if (!used || (row.status !== 'ok' && row.status !== 'tbd')) continue;
    if (used.division.type === 'create') note(creations.divisions, used.division);
    if (used.field && used.field.type === 'create') {
      note(creations.fields, used.field, { venueId: used.field.venueId });
    }
    for (const side of [used.home, used.away]) {
      if (side.type === 'create') note(creations.teamShells, side, { divisionId: side.divisionId });
      else if (side.type === 'outside') {
        note(creations.outsideTeams, side, { divisionId: side.divisionId });
      }
    }
  }
  // A venue is created when a surviving row's field is in it (or the venue was created for its field).
  for (const { row, refs: used } of resolved) {
    if (!used || row.status !== 'ok' || !used.field) continue;
    const venue = refs.venue.get(venueDecisionKey(row.venueLabel));
    if (venue && venue !== SKIP && venue.type === 'create') note(creations.venues, venue);
  }
  /** Sorted by parent then name, as tuples, so the order does not depend on a delimiter. */
  const listed = (map) => {
    const order = (x) => JSON.stringify([x.divisionId ?? x.venueId ?? '', x.key]);
    return [...map.values()].sort((x, y) =>
      order(x) < order(y) ? -1 : order(x) > order(y) ? 1 : 0
    );
  };

  const out = resolved.map((x) => x.row);
  const counts = { rows: out.length, ok: 0, tbd: 0, refused: 0, skipped: 0, byReason: {} };
  for (const r of out) {
    counts[r.status] += 1;
    if (r.status === 'refused' && r.reason)
      counts.byReason[r.reason] = (counts.byReason[r.reason] ?? 0) + 1;
  }
  return {
    rows: out,
    creations: {
      divisions: listed(creations.divisions),
      venues: listed(creations.venues),
      fields: listed(creations.fields),
      teamShells: listed(creations.teamShells),
      outsideTeams: listed(creations.outsideTeams),
    },
    counts,
  };
}
