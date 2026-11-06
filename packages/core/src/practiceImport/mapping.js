/**
 * Mapping a practice file's labels to the organization's divisions, locations, fields, subunits and
 * teams, and turning the rows into slots (plan `docs/changes/2026-11-03-schedule-expansion.md` sections
 * 4.11.3 and 4.11.5; PR 9, task J2).
 *
 * The structure is `scheduleImport/mapping.js`'s (PR 4) and the bug classes it was fixed for are kept
 * out here on purpose: a composite key is a JSON tuple, never a delimited string; a record the import
 * would create is one record per parent identity and FINAL name (decisions stay keyed by the file's
 * label); a `create` onto a name that already exists is `name-exists`; a stored decision that cannot be
 * read has no effect and does not fall back to the proposal. What differs is the ground: a practice has
 * a division, a team, a location, a field and optionally a half or side (a subunit), and the rows become
 * **slots**.
 *
 * ## The one rule, and what it will not do
 *
 * There is one normaliser (`practiceLabelKey`, which is `normaliseExternalLabel`): trim, collapse
 * whitespace, fold case, **drop no word**. `Park Back` and `Park Front` are two venues; `Park` is neither.
 * A team is judged inside its division, a field inside its location, a subunit inside its field. An
 * outside club (`is_external`) is never a practice team.
 *
 * ## Proposals, in this order, none applied without the admin (F17, decision 30)
 *
 * 1. the exact normalised label (exactly one record);
 * 2. an optional alias file (`aliases.js`), for a location, a field or a subunit;
 * 3. the mapping stored on the previous completed import of this kind (`previous`: the decisions it
 *    ended with; only a `map` to a record that still exists, in the right parent, proposes).
 *
 * Only an exact single match with nothing disagreeing is in effect on its own. An alias and a previous
 * mapping are shown and **applied only when the admin decides** (a `map` decision, which keeps the
 * `source` it came from). Where two proposals disagree, **both are shown and none is chosen**: an alias
 * never wins over an exact match, and an exact match never silently beats an alias. A proposal that
 * cannot apply (a record that is gone, or in another parent) is in `ignoredProposals`, not dropped.
 *
 * ## What a decision is
 *
 * `{ action: 'map', id, source? }`, `{ action: 'create', name? }`, `{ action: 'skip' }`, kept under the key
 * a `practice*DecisionKey` function builds from the labels as typed. A decision naming an id the
 * league does not hold in that parent is not trusted: the row is `unknown-*`.
 *
 * ## Ids
 *
 * A resolved row carries `ids`. An existing record has its own id; one the import would create has a
 * stable placeholder, `new:<kind>:<tuple>`, so the slot step can run on the rows before anything is
 * written. The tuple is the JSON array of the parent ids and the FINAL name.
 *
 * ## Slots
 *
 * "Every timed row is a slot, used or not" (plan 4.11.3): a placement and an open row both make one; a
 * `hold` row makes none. A slot is found by `(field, subunit or the whole field, weekday, start, valid
 * from)` (`slotKey.js`). Rows of one slot must agree on its End, Valid Until and Capacity, or the later
 * row is `slot-overlaps-another`; two different slots that claim one ground at overlapping times are
 * the database's supply rule (`practice_slot_conflicts`), and the LATER slot is refused, whole. This
 * module sees only the rows of the file: a clash with a slot already stored is PR 10's.
 *
 * ## Flags judged here
 *
 * `team-on-both-halves` (a team on two halves of one field at one time: two rows, two slots, never
 * merged into a whole-field row on the admin's behalf) and `hold-over-open-slot` (a hold over a slot of
 * the same file). `division-not-reserved` is the parse's. The other six flags are the database's.
 *
 * Not checked here, and so not claimed: that a created location or field has coordinates or lighting
 * (it has neither, plan finding 18), and the stored slots, reservations and counts the database judges.
 */

import { PRACTICE_IMPORT_LIMITS, PRACTICE_IMPORT_REASON as R } from './reasonCodes.js';
import {
  practiceLabelKey,
  practiceSlotKey,
  practiceSlotsOverlap,
  practiceTuple as tuple,
  practiceWindowsOverlap,
} from './slotKey.js';

/** @param {string} divisionLabel */
export const practiceDivisionDecisionKey = (divisionLabel) => practiceLabelKey(divisionLabel);
/** @param {string} locationLabel */
export const practiceLocationDecisionKey = (locationLabel) => practiceLabelKey(locationLabel);
/** @param {string} locationLabel @param {string} fieldLabel */
export const practiceFieldDecisionKey = (locationLabel, fieldLabel) =>
  tuple(practiceLabelKey(locationLabel), practiceLabelKey(fieldLabel));
/** @param {string} locationLabel @param {string} fieldLabel @param {string} subunitLabel */
export const practiceSubunitDecisionKey = (locationLabel, fieldLabel, subunitLabel) =>
  tuple(
    practiceLabelKey(locationLabel),
    practiceLabelKey(fieldLabel),
    practiceLabelKey(subunitLabel)
  );
/** @param {string} divisionLabel @param {string} teamLabel */
export const practiceTeamDecisionKey = (divisionLabel, teamLabel) =>
  tuple(practiceLabelKey(divisionLabel), practiceLabelKey(teamLabel));

const ACTIONS = Object.freeze(['map', 'create', 'skip']);
const GROUP_OF = Object.freeze({
  division: 'divisions',
  location: 'locations',
  field: 'fields',
  subunit: 'subunits',
  team: 'teams',
});
/** What a decision may say it came from. Anything else is the admin's own word. */
const DECISION_SOURCES = Object.freeze(['alias', 'previous']);

/**
 * @typedef {Object} PracticeLeagueView  what the organization has, as the mapping step reads it
 * @property {Array<{ id: string, name: string, practicesPerWeek?: number | null, practiceMinutes?: number | null }>} divisions
 * @property {Array<{ id: string, name: string, divisionId: string, isExternal?: boolean }>} teams
 * @property {Array<{ id: string, name: string }>} locations
 * @property {Array<{ id: string, locationId: string, name: string }>} fields
 * @property {Array<{ id: string, fieldId: string, name: string }>} subunits
 */

/** @param {unknown} value @param {string} what */
function requireArray(value, what) {
  if (!Array.isArray(value))
    throw new TypeError(`practiceImport mapping: ${what} must be an array`);
  return value;
}

/** @param {PracticeLeagueView} league */
function indexLeague(league) {
  if (!league || typeof league !== 'object') {
    throw new TypeError('practiceImport mapping: league must be an object');
  }
  const divisions = requireArray(league.divisions, 'league.divisions');
  const teams = requireArray(league.teams, 'league.teams');
  const locations = requireArray(league.locations, 'league.locations');
  const fields = requireArray(league.fields, 'league.fields');
  const subunits = requireArray(league.subunits, 'league.subunits');
  /** @param {Array<any>} list @param {(x: any) => string} scope */
  const groupBy = (list, scope) => {
    const out = new Map();
    for (const item of list) {
      const key = tuple(scope(item), practiceLabelKey(item.name));
      out.set(key, [...(out.get(key) ?? []), item]);
    }
    return out;
  };
  return {
    divisionsById: new Map(divisions.map((d) => [d.id, d])),
    teamsById: new Map(teams.map((t) => [t.id, t])),
    locationsById: new Map(locations.map((l) => [l.id, l])),
    fieldsById: new Map(fields.map((f) => [f.id, f])),
    subunitsById: new Map(subunits.map((s) => [s.id, s])),
    divisionsByName: groupBy(divisions, () => ''),
    locationsByName: groupBy(locations, () => ''),
    // an outside club is never a practice team: it is not a candidate, and not a trusted `map`
    teamsByName: groupBy(
      teams.filter((t) => t.isExternal !== true),
      (t) => t.divisionId
    ),
    // ...but it holds its name: `UNIQUE (division_id, name)` covers every team of the division, so a
    // `create` is checked against all of them
    allTeamsByName: groupBy(teams, (t) => t.divisionId),
    fieldsByName: groupBy(fields, (f) => f.locationId),
    subunitsByName: groupBy(subunits, (s) => s.fieldId),
  };
}

/**
 * The decision stored under a key, and whether one was stored that cannot be read.
 *
 * A decision that is there but is not one of the actions (a typo, a `map` with no id) is `invalid`, and
 * the label then has NO effective decision: it must not fall back to the proposal the admin chose not
 * to take. Only the fields this module reads are kept, a name only if it is non-blank text, and a
 * source only if it is one a proposal can come from (a decision is stored data).
 *
 * @param {Record<string, any> | undefined | null} decisions
 * @param {keyof typeof GROUP_OF} kind
 * @param {string} key
 * @returns {{ decision: { action: string, id?: string, name?: string, source: string } | null, invalid: boolean }}
 */
function decisionFor(decisions, kind, key) {
  const group = decisions?.[GROUP_OF[kind]];
  if (!group || typeof group !== 'object' || !Object.hasOwn(group, key)) {
    return { decision: null, invalid: false };
  }
  const raw = group[key];
  const readable =
    raw !== null &&
    typeof raw === 'object' &&
    ACTIONS.includes(raw.action) &&
    (raw.action !== 'map' || typeof raw.id === 'string');
  if (!readable) return { decision: null, invalid: true };
  /** @type {{ action: string, id?: string, name?: string, source: string }} */
  const kept = {
    action: raw.action,
    source: DECISION_SOURCES.includes(raw.source) ? raw.source : 'admin',
  };
  if (typeof raw.id === 'string') kept.id = raw.id;
  if (typeof raw.name === 'string' && raw.name.trim() !== '') kept.name = raw.name.trim();
  return { decision: kept, invalid: false };
}

/**
 * @typedef {Object} PracticeMappingEntry  one distinct label of the file and what can be done with it
 * @property {'division' | 'location' | 'field' | 'subunit' | 'team'} kind
 * @property {string} key  the key to put a decision under
 * @property {string} label  the first spelling seen, trimmed
 * @property {number} rowCount
 * @property {'match' | 'ambiguous' | 'none'} status  what the exact label finds
 * @property {Array<{ id: string, name: string }>} candidates  the records of that exact name in the parent
 * @property {Array<{ source: 'exact' | 'alias' | 'previous', id: string }>} proposals
 * @property {Array<{ source: string, id: string | null, why: 'unknown-id' | 'other-parent' | 'unreadable' }>} ignoredProposals
 * @property {boolean} conflict  the proposals name more than one record
 * @property {{ action: 'map', id: string, sources: string[] } | null} proposed  the one record all proposals name
 * @property {{ action: string, id?: string, name?: string, source: string } | null} decision  the admin's
 * @property {{ action: string, id?: string, name?: string, source: string } | null} effective  the decision, else
 *   an exact match nothing disagrees with
 * @property {string[]} options
 * @property {'unknown-id' | 'invalid-decision' | 'name-exists' | 'name-taken-by-outside-club'} [problem]  why the label has no usable decision
 */

/** What a label resolves to once decisions are applied. */
const SKIP = Object.freeze({ type: 'skip' });

/**
 * A reference book that falls back to another: `get` and `has` read its own references first and the
 * base's after, and `set` writes only its own. A hold reads what the other rows resolved (so the admin's
 * decisions hold for it) and adds only the ground nothing else named.
 *
 * @template T
 * @param {Record<string, Map<string, T>>} base
 * @returns {Record<string, { has: (k: string) => boolean, get: (k: string) => T | undefined, set: (k: string, v: T) => unknown }>}
 */
function layered(base) {
  /** @type {Record<string, any>} */
  const view = {};
  for (const kind of Object.keys(base)) {
    const own = new Map();
    view[kind] = {
      has: (/** @type {string} */ k) => own.has(k) || base[kind].has(k),
      get: (/** @type {string} */ k) => (own.has(k) ? own.get(k) : base[kind].get(k)),
      set: (/** @type {string} */ k, /** @type {any} */ v) => own.set(k, v),
    };
  }
  return view;
}

/**
 * Everything the mapping step knows: the entries to show and the references rows resolve through.
 *
 * @param {Object} input
 * @param {Array<any>} input.rows  the parse's rows
 * @param {PracticeLeagueView} input.league
 * @param {Record<string, any>} [input.decisions]
 * @param {import('./aliases.js').PracticeAliases} [input.aliases]
 * @param {Record<string, any>} [input.previous]
 */
function analyse({ rows, league, decisions, aliases, previous }) {
  requireArray(rows, 'rows');
  const world = indexLeague(league);
  // The rows that ask for ground: a placement and an open slot. A hold makes no slot, so it asks for
  // nothing; it is compared with the slots afterwards, by ground found for it below.
  const asking = rows.filter((r) => r.status === 'placement' || r.status === 'open');

  /** @type {Record<keyof typeof GROUP_OF, Map<string, PracticeMappingEntry>>} */
  const entries = {
    division: new Map(),
    location: new Map(),
    field: new Map(),
    subunit: new Map(),
    team: new Map(),
  };
  /** key -> a reference (or SKIP, or null when unresolved) */
  const refs = {
    division: new Map(),
    location: new Map(),
    field: new Map(),
    subunit: new Map(),
    team: new Map(),
  };

  /** @param {Record<string, any> | undefined} group @param {string} key */
  const aliasOf = (group, key) =>
    group && typeof group === 'object' && Object.hasOwn(group, key) ? group[key] : null;

  /**
   * @param {typeof entries} into  the entries this label is recorded in
   * @param {keyof typeof GROUP_OF} kind
   * @param {Object} spec
   * @param {string} spec.key
   * @param {string} spec.label
   * @param {Record<string, string>} spec.extra
   * @param {Array<{ id: string, name: string }>} spec.candidates
   * @param {string | null} spec.aliasId  the record the alias file names for this label, or null
   * @param {(id: string) => boolean} spec.exists  does the league hold this id at all
   * @param {(id: string) => boolean} spec.holds  does the league hold it in the parent this label is in
   */
  function entryFor(into, kind, { key, label, extra, candidates, aliasId, exists, holds }) {
    const map = into[kind];
    let entry = map.get(key);
    if (entry) {
      entry.rowCount += 1;
      return entry;
    }
    const { decision, invalid } = decisionFor(decisions, kind, key);
    const status =
      candidates.length === 0 ? 'none' : candidates.length === 1 ? 'match' : 'ambiguous';

    /** @type {PracticeMappingEntry['proposals']} */
    const proposals = [];
    /** @type {PracticeMappingEntry['ignoredProposals']} */
    const ignoredProposals = [];
    if (status === 'match') proposals.push({ source: 'exact', id: candidates[0].id });
    /** @param {'alias' | 'previous'} source @param {string} id */
    const propose = (source, id) => {
      if (holds(id)) proposals.push({ source, id });
      else ignoredProposals.push({ source, id, why: exists(id) ? 'other-parent' : 'unknown-id' });
    };
    if (aliasId !== null) propose('alias', aliasId);
    const earlier = decisionFor(previous, kind, key);
    if (earlier.invalid) ignoredProposals.push({ source: 'previous', id: null, why: 'unreadable' });
    else if (earlier.decision?.action === 'map') propose('previous', earlier.decision.id);

    const ids = [...new Set(proposals.map((p) => p.id))];
    const conflict = ids.length > 1;
    const agreed = ids.length === 1 ? ids[0] : null;
    const proposed =
      agreed === null
        ? null
        : {
            action: /** @type {const} */ ('map'),
            id: agreed,
            sources: proposals.map((p) => p.source),
          };
    // Only an exact single match is in effect on its own, and only when nothing disagrees with it.
    const auto = agreed !== null && proposals.some((p) => p.source === 'exact');
    entry = {
      kind,
      key,
      label,
      ...extra,
      rowCount: 1,
      status,
      candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
      proposals,
      ignoredProposals,
      conflict,
      proposed,
      decision,
      effective: invalid
        ? null
        : (decision ?? (auto ? { action: 'map', id: agreed, source: 'exact' } : null)),
      options: [...ACTIONS],
      ...(invalid ? { problem: /** @type {const} */ ('invalid-decision') } : {}),
    };
    map.set(key, entry);
    return entry;
  }

  /**
   * The reference an entry's effective decision gives, or null when the label is unresolved.
   * @param {PracticeMappingEntry} entry
   * @param {(id: string) => boolean} holds  does the league hold this id, in this parent
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
   * two labels the admin maps to one division, and a team created under each, are one team to create
   * (`UNIQUE (division_id, name)`), and the slot step must see it as one team. Decisions stay keyed by
   * label; only what is created is coalesced.
   *
   * @param {'division' | 'location' | 'field' | 'subunit' | 'team'} kind
   * @param {PracticeMappingEntry} entry
   * @param {string[]} parents  the ids of the records it lives under, outermost first (a created parent’s
   *   id is its own placeholder, so a created team under a created division coalesces too)
   * @param {Record<string, string>} extra
   * @param {(nameKey: string) => Array<{ isExternal?: boolean }>} existingNamed  the records of this kind
   *   already under the parent with that name, whatever they are (an outside club too): creating one
   *   more would meet `UNIQUE (parent, name)` in the writer
   */
  function createdRef(kind, entry, parents, extra, existingNamed) {
    const name = entry.effective?.name ?? entry.label;
    const key = practiceLabelKey(name);
    const taken = existingNamed(key);
    if (taken.length > 0) {
      // a name held only by an outside club is told apart: mapping to it is not on offer
      entry.problem = taken.every((t) => t.isExternal === true)
        ? 'name-taken-by-outside-club'
        : 'name-exists';
      return null;
    }
    return { type: 'create', id: `new:${kind}:${tuple(...parents, key)}`, key, name, ...extra };
  }

  /**
   * The five passes over some rows, into some entries and some references.
   * @param {Array<any>} list
   * @param {typeof entries} into
   * @param {typeof refs} book
   */
  function runPasses(list, into, book) {
    const asking = list;
    const placing = list.filter((r) => r.status === 'placement');
    // Divisions (a team has one), then locations, then fields (judged in their location), then subunits
    // (in their field), then teams (in their division).
    for (const r of placing) {
      const key = practiceLabelKey(r.divisionLabel);
      if (key === '') continue;
      const entry = entryFor(into, 'division', {
        key,
        label: r.divisionLabel,
        extra: {},
        candidates: world.divisionsByName.get(tuple('', key)) ?? [],
        aliasId: null,
        exists: (id) => world.divisionsById.has(id),
        holds: (id) => world.divisionsById.has(id),
      });
      if (!book.division.has(key)) {
        book.division.set(
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

    for (const r of asking) {
      const key = practiceLabelKey(r.locationLabel);
      if (key === '') continue;
      const target = aliasOf(aliases?.locations, key);
      const entry = entryFor(into, 'location', {
        key,
        label: r.locationLabel,
        extra: {},
        candidates: world.locationsByName.get(tuple('', key)) ?? [],
        aliasId: typeof target?.locationId === 'string' ? target.locationId : null,
        exists: (id) => world.locationsById.has(id),
        holds: (id) => world.locationsById.has(id),
      });
      if (!book.location.has(key)) {
        book.location.set(
          key,
          refOf(
            entry,
            (id) => world.locationsById.has(id),
            (id) => ({ type: 'existing', id }),
            () =>
              createdRef(
                'location',
                entry,
                [],
                {},
                (k) => world.locationsByName.get(tuple('', k)) ?? []
              )
          )
        );
      }
    }

    for (const r of asking) {
      const locationKey = practiceLabelKey(r.locationLabel);
      const fieldKey = practiceLabelKey(r.fieldLabel);
      const loc = book.location.get(locationKey);
      if (locationKey === '' || fieldKey === '' || !loc || loc === SKIP) continue;
      const key = practiceFieldDecisionKey(r.locationLabel, r.fieldLabel);
      const target = aliasOf(aliases?.fields, fieldKey);
      const entry = entryFor(into, 'field', {
        key,
        label: r.fieldLabel,
        extra: { locationLabel: r.locationLabel },
        candidates:
          loc.type === 'existing' ? (world.fieldsByName.get(tuple(loc.id, fieldKey)) ?? []) : [],
        aliasId:
          loc.type === 'existing' && typeof target?.fieldId === 'string' ? target.fieldId : null,
        exists: (id) => world.fieldsById.has(id),
        holds: (id) => world.fieldsById.get(id)?.locationId === loc.id,
      });
      if (!book.field.has(key)) {
        book.field.set(
          key,
          refOf(
            entry,
            (id) => world.fieldsById.get(id)?.locationId === loc.id,
            (id) => ({ type: 'existing', id }),
            () =>
              createdRef('field', entry, [loc.id], { locationId: loc.id }, (k) =>
                loc.type === 'existing' ? (world.fieldsByName.get(tuple(loc.id, k)) ?? []) : []
              )
          )
        );
      }
    }

    for (const r of asking) {
      const subunitKey = practiceLabelKey(r.subunitLabel);
      if (subunitKey === '') continue; // the whole field
      const loc = book.location.get(practiceLabelKey(r.locationLabel));
      const fld = book.field.get(practiceFieldDecisionKey(r.locationLabel, r.fieldLabel));
      if (!loc || loc === SKIP || !fld || fld === SKIP) continue;
      const key = practiceSubunitDecisionKey(r.locationLabel, r.fieldLabel, r.subunitLabel);
      const target = aliasOf(aliases?.subunits, subunitKey);
      const entry = entryFor(into, 'subunit', {
        key,
        label: r.subunitLabel,
        extra: { locationLabel: r.locationLabel, fieldLabel: r.fieldLabel },
        candidates:
          fld.type === 'existing'
            ? (world.subunitsByName.get(tuple(fld.id, subunitKey)) ?? [])
            : [],
        aliasId:
          fld.type === 'existing' && typeof target?.subunitId === 'string'
            ? target.subunitId
            : null,
        exists: (id) => world.subunitsById.has(id),
        holds: (id) => world.subunitsById.get(id)?.fieldId === fld.id,
      });
      if (!book.subunit.has(key)) {
        book.subunit.set(
          key,
          refOf(
            entry,
            (id) => world.subunitsById.get(id)?.fieldId === fld.id,
            (id) => ({ type: 'existing', id }),
            () =>
              createdRef('subunit', entry, [fld.id], { fieldId: fld.id }, (k) =>
                fld.type === 'existing' ? (world.subunitsByName.get(tuple(fld.id, k)) ?? []) : []
              )
          )
        );
      }
    }

    for (const r of placing) {
      const teamKey = practiceLabelKey(r.teamLabel);
      const div = book.division.get(practiceLabelKey(r.divisionLabel));
      if (teamKey === '' || !div || div === SKIP) continue;
      const key = practiceTeamDecisionKey(r.divisionLabel, r.teamLabel);
      const named = (/** @type {string} */ k) =>
        div.type === 'existing' ? (world.teamsByName.get(tuple(div.id, k)) ?? []) : [];
      const taken = (/** @type {string} */ k) =>
        div.type === 'existing' ? (world.allTeamsByName.get(tuple(div.id, k)) ?? []) : [];
      const holds = (/** @type {string} */ id) => {
        const t = world.teamsById.get(id);
        return t !== undefined && t.divisionId === div.id && t.isExternal !== true;
      };
      const entry = entryFor(into, 'team', {
        key,
        label: r.teamLabel,
        extra: { divisionLabel: r.divisionLabel },
        candidates: named(teamKey),
        aliasId: null,
        exists: (id) => world.teamsById.has(id),
        holds,
      });
      if (book.team.has(key)) continue;
      book.team.set(
        key,
        refOf(
          entry,
          holds,
          (id) => ({ type: 'existing', id }),
          () => createdRef('team', entry, [div.id], { divisionId: div.id }, taken)
        )
      );
    }
  }

  runPasses(asking, entries, refs);

  // A hold asks for no mapping and creates nothing, but it names ground, and ground the league already
  // has must be found even when no slot names it (a half only the hold mentions). The hold reads the
  // references the other rows made, so the admin's decisions hold for it too, and adds only what they
  // did not; its entries are not shown and its references create no record.
  const holdRefs = layered(refs);
  runPasses(
    rows.filter((r) => r.status === 'hold'),
    {
      division: new Map(),
      location: new Map(),
      field: new Map(),
      subunit: new Map(),
      team: new Map(),
    },
    holdRefs
  );

  return { world, refs, holdRefs, entries };
}

/** @param {Map<string, PracticeMappingEntry>} map */
const sortedEntries = (map) =>
  [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/**
 * For every distinct label of the file: what the organization has that it could mean, what is proposed
 * (and by whom), what the admin decided, and what is therefore in effect.
 *
 * @param {Object} input
 * @param {Array<any>} input.rows  the parse's rows; only the ones that ask for ground are asked about
 * @param {PracticeLeagueView} input.league
 * @param {Record<string, any>} [input.decisions]
 * @param {import('./aliases.js').PracticeAliases} [input.aliases]  from `readPracticeAliases`
 * @param {Record<string, any>} [input.previous]  the previous completed import's decisions
 * @returns {{ divisions: PracticeMappingEntry[], locations: PracticeMappingEntry[], fields: PracticeMappingEntry[], subunits: PracticeMappingEntry[], teams: PracticeMappingEntry[] }}
 */
export function proposePracticeMapping({ rows, league, decisions = {}, aliases, previous }) {
  const { entries } = analyse({ rows, league, decisions, aliases, previous });
  return {
    divisions: sortedEntries(entries.division),
    locations: sortedEntries(entries.location),
    fields: sortedEntries(entries.field),
    subunits: sortedEntries(entries.subunit),
    teams: sortedEntries(entries.team),
  };
}

/**
 * @typedef {Object} PracticeSlot  one slot the file names, new or found (the database decides which)
 * @property {string} key  `practiceSlotKey` of the slot
 * @property {string} locationId
 * @property {string} fieldId
 * @property {string | null} subunitId  null is the whole field
 * @property {string} day
 * @property {string} startTime
 * @property {string} endTime
 * @property {string} validFrom
 * @property {string} validUntil
 * @property {number} capacity
 * @property {number[]} rowNumbers  the rows of the file that name it, in file order
 * @property {number} placements  how many of them place a team
 */

/**
 * Resolve every row of a parse against the league and the admin's decisions, make the slots, and flag
 * what this module judges.
 *
 * Order within a row: division (a placement), location, field, subunit, team. The first to fail is the row's
 * reason; a label the admin skipped makes the row `skipped`. A `hold` row is never refused here: it makes
 * no slot and asks for no mapping, and is compared with the slots by the ground found for it (the
 * references the other rows made, else existing records by their exact names; `ids` is null when the
 * league has no such ground).
 *
 * @param {Object} input
 * @param {Array<any>} input.rows  the parse's rows (not changed)
 * @param {PracticeLeagueView} input.league
 * @param {Record<string, any>} [input.decisions]
 * @param {import('./aliases.js').PracticeAliases} [input.aliases]
 * @param {Record<string, any>} [input.previous]
 * @returns {{
 *   rows: Array<any>,
 *   holds: Array<any>,
 *   creations: { divisions: any[], locations: any[], fields: any[], subunits: any[], teamShells: any[], slots: PracticeSlot[] },
 *   counts: { rows: number, placements: number, open: number, holds: number, refused: number, skipped: number, slots: number, byReason: Record<string, number>, flags: Record<string, { rows: number, teams?: number }> },
 * }}
 */
export function resolvePracticeRows({ rows, league, decisions = {}, aliases, previous }) {
  const { refs, holdRefs, entries } = analyse({ rows, league, decisions, aliases, previous });

  /**
   * Why a label is unresolved, in words: a decision that cannot be read, a name that is taken, or
   * proposals that disagree say so, instead of the generic "not one of yours".
   * @param {keyof typeof GROUP_OF} kind
   */
  const whyNot = (kind, key, label, fallback) => {
    const entry = entries[kind].get(key);
    const quoted = JSON.stringify(label);
    if (entry?.problem === 'invalid-decision') {
      return `The decision saved for the ${kind} ${quoted} is not one this step can read. Decide again.`;
    }
    if (entry?.problem === 'unknown-id') {
      return `The record chosen for the ${kind} ${quoted} is not one of yours. Decide again.`;
    }
    if (entry?.problem === 'name-taken-by-outside-club') {
      const name = JSON.stringify(entry.effective?.name ?? label);
      return `An outside club named ${name} is already in this division, and a team cannot share its name. Create ${quoted} under another name.`;
    }
    if (entry?.problem === 'name-exists') {
      const name = JSON.stringify(entry.effective?.name ?? label);
      return `A ${kind} named ${name} already exists here. Map ${quoted} to it instead of creating another.`;
    }
    if (entry?.conflict && !entry.effective) {
      const who = entry.proposals.map((p) => p.source).join(' and ');
      return `The ${who} proposals for the ${kind} ${quoted} disagree. Decide which one it is.`;
    }
    return fallback;
  };

  /** @type {Array<{ row: any, refs?: any }>} */
  const resolved = rows.map((row) => {
    const keep = (changes) => ({
      ...row,
      flags: [...(row.flags ?? [])],
      ids: null,
      skippedBecause: null,
      slotKey: null,
      ...changes,
    });
    if (row.status === 'refused') return { row: keep({}) };

    if (row.status === 'hold') {
      // A hold is never refused here and asks for no mapping: it uses the ground found for it (the
      // references the other rows made, else existing records by their exact names). `ids` is null
      // when its ground is nowhere to be found, and no flag is possible then.
      const loc = holdRefs.location.get(practiceLabelKey(row.locationLabel));
      const fld = holdRefs.field.get(practiceFieldDecisionKey(row.locationLabel, row.fieldLabel));
      const whole = practiceLabelKey(row.subunitLabel) === '';
      const sub = whole
        ? null
        : holdRefs.subunit.get(
            practiceSubunitDecisionKey(row.locationLabel, row.fieldLabel, row.subunitLabel)
          );
      const usable = (ref) => ref && ref !== SKIP;
      const known = usable(loc) && usable(fld) && (whole || usable(sub));
      return {
        row: keep({
          ids: known
            ? {
                division: null,
                team: null,
                location: loc.id,
                field: fld.id,
                subunit: sub ? sub.id : null,
              }
            : null,
        }),
      };
    }

    const refuse = (reason, message) => ({
      row: keep({ status: 'refused', reason, message, flags: [] }),
    });
    const skip = (kind, label) => ({
      row: keep({
        status: 'skipped',
        reason: null,
        message: null,
        flags: [],
        skippedBecause: { kind, label },
      }),
    });
    const placement = row.status === 'placement';

    let division = null;
    if (placement) {
      const divisionKey = practiceLabelKey(row.divisionLabel);
      if (divisionKey === '') return refuse(R.UNKNOWN_DIVISION, 'The Division is blank.');
      division = refs.division.get(divisionKey);
      if (division === SKIP) return skip('division', row.divisionLabel);
      if (!division) {
        return refuse(
          R.UNKNOWN_DIVISION,
          whyNot(
            'division',
            divisionKey,
            row.divisionLabel,
            `The division ${JSON.stringify(row.divisionLabel)} is not one of yours. Map it to a division, create it, or skip its rows.`
          )
        );
      }
    }

    const locationKey = practiceLabelKey(row.locationLabel);
    if (locationKey === '') return refuse(R.UNKNOWN_LOCATION, 'The Location is blank.');
    const location = refs.location.get(locationKey);
    if (location === SKIP) return skip('location', row.locationLabel);
    if (!location) {
      return refuse(
        R.UNKNOWN_LOCATION,
        whyNot(
          'location',
          locationKey,
          row.locationLabel,
          `The location ${JSON.stringify(row.locationLabel)} is not one of yours. Map it to a location, create it, or skip its rows.`
        )
      );
    }

    const fieldKey = practiceFieldDecisionKey(row.locationLabel, row.fieldLabel);
    if (practiceLabelKey(row.fieldLabel) === '')
      return refuse(R.UNKNOWN_FIELD, 'The Field is blank.');
    const field = refs.field.get(fieldKey);
    if (field === SKIP) return skip('field', row.fieldLabel);
    if (!field) {
      return refuse(
        R.UNKNOWN_FIELD,
        whyNot(
          'field',
          fieldKey,
          row.fieldLabel,
          `The field ${JSON.stringify(row.fieldLabel)} is not one of ${JSON.stringify(row.locationLabel)}'s. Map it to a field, create it, or skip its rows.`
        )
      );
    }

    /** @type {any} */
    let subunit = null;
    if (practiceLabelKey(row.subunitLabel) !== '') {
      const subunitKey = practiceSubunitDecisionKey(
        row.locationLabel,
        row.fieldLabel,
        row.subunitLabel
      );
      subunit = refs.subunit.get(subunitKey);
      if (subunit === SKIP) return skip('subunit', row.subunitLabel);
      if (!subunit) {
        return refuse(
          R.UNKNOWN_SUBUNIT,
          whyNot(
            'subunit',
            subunitKey,
            row.subunitLabel,
            `The half or side ${JSON.stringify(row.subunitLabel)} is not one of ${JSON.stringify(row.fieldLabel)}'s. Map it to one, create it, or skip its rows. Leave Subunit blank for the whole field.`
          )
        );
      }
    }

    let team = null;
    if (placement) {
      const teamKey = practiceTeamDecisionKey(row.divisionLabel, row.teamLabel);
      team = refs.team.get(teamKey);
      if (team === SKIP) return skip('team', row.teamLabel);
      if (!team) {
        return refuse(
          R.UNKNOWN_TEAM,
          whyNot(
            'team',
            teamKey,
            row.teamLabel,
            `The team ${JSON.stringify(row.teamLabel)} is not one of your teams in ${JSON.stringify(row.divisionLabel)}. Map it to a team, create it, or skip its rows.`
          )
        );
      }
    }
    return {
      row: keep({
        ids: {
          division: division ? division.id : null,
          team: team ? team.id : null,
          location: location.id,
          field: field.id,
          subunit: subunit ? subunit.id : null,
        },
      }),
      refs: { division, location, field, subunit, team },
    };
  });

  /** Turn a row into a refusal in place, as the slot step and the repeat step do. */
  const refuseRow = (item, reason, message) => {
    Object.assign(item.row, {
      status: 'refused',
      reason,
      message,
      flags: [],
      ids: null,
      slotKey: null,
    });
    item.refs = undefined;
  };

  // The same practice twice by the admin's own mapping (two labels mapped onto one team): the first
  // wins, as in the parse, which compared the labels as typed.
  const seen = new Set();
  for (const item of resolved) {
    const r = item.row;
    if (!r.ids || (r.status !== 'placement' && r.status !== 'open')) continue;
    const key = tuple(
      r.status,
      r.ids.team,
      r.ids.field,
      r.ids.subunit,
      r.day,
      r.startTime,
      r.endTime,
      r.validFrom,
      r.validUntil,
      r.capacity
    );
    if (seen.has(key)) {
      refuseRow(
        item,
        R.DUPLICATE_ROW,
        'After mapping, this is the same practice as an earlier row; the earlier row is the one imported.'
      );
    } else {
      seen.add(key);
    }
  }

  // ---- Slots ----------------------------------------------------------------------------------------
  /** @type {PracticeSlot[]} */
  const slots = [];
  /** @type {Map<string, PracticeSlot>} */
  const slotByKey = new Map();
  /** @type {Map<string, number>} the slot keys refused, and the row they clashed with */
  const refusedKey = new Map();
  /** @type {Map<string, PracticeSlot[]>} accepted slots by ground and weekday, so a new one meets few */
  const onGround = new Map();
  for (const item of resolved) {
    const r = item.row;
    if (!r.ids || (r.status !== 'placement' && r.status !== 'open')) continue;
    const key = practiceSlotKey({
      field: r.ids.field,
      subunit: r.ids.subunit,
      day: r.day,
      startTime: r.startTime,
      validFrom: r.validFrom,
    });
    const candidate = {
      key,
      locationId: r.ids.location,
      fieldId: r.ids.field,
      subunitId: r.ids.subunit,
      day: r.day,
      startTime: r.startTime,
      endTime: r.endTime,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      capacity: r.capacity,
      rowNumbers: [r.rowNumber],
      placements: r.status === 'placement' ? 1 : 0,
    };
    const same = slotByKey.get(key);
    if (same) {
      if (
        same.endTime === candidate.endTime &&
        same.validUntil === candidate.validUntil &&
        same.capacity === candidate.capacity
      ) {
        same.rowNumbers.push(r.rowNumber);
        same.placements += candidate.placements;
        r.slotKey = key;
      } else {
        refuseRow(
          item,
          R.SLOT_OVERLAPS_ANOTHER,
          `This is the same slot as row ${same.rowNumbers[0]} with a different End, Valid Until or Capacity. A slot is one of each: make the rows agree.`
        );
      }
      continue;
    }
    const earlier = refusedKey.get(key);
    if (earlier !== undefined) {
      refuseRow(
        item,
        R.SLOT_OVERLAPS_ANOTHER,
        `This is the same slot as row ${earlier}'s clash: it overlaps another slot on the same ground and is not written.`
      );
      continue;
    }
    const groundKey = tuple(candidate.fieldId, candidate.day);
    const clash = (onGround.get(groundKey) ?? []).find((s) => practiceSlotsOverlap(s, candidate));
    if (clash) {
      refusedKey.set(key, r.rowNumber);
      refuseRow(
        item,
        R.SLOT_OVERLAPS_ANOTHER,
        `This slot overlaps the slot of row ${clash.rowNumbers[0]} on the same ground at the same time. Two slots cannot claim one ground; the earlier row is the one imported.`
      );
      continue;
    }
    slots.push(candidate);
    slotByKey.set(key, candidate);
    onGround.set(groundKey, [...(onGround.get(groundKey) ?? []), candidate]);
    r.slotKey = key;
  }

  // ---- Flags judged here -------------------------------------------------------------------------------
  // A team on two halves of one field at one time.
  /** @type {Map<string, any[]>} */
  const byTeam = new Map();
  for (const { row: r } of resolved) {
    if (r.status === 'placement' && r.ids)
      byTeam.set(r.ids.team, [...(byTeam.get(r.ids.team) ?? []), r]);
  }
  /** @type {Set<string>} */
  const teamsOnBothHalves = new Set();
  for (const [teamId, list] of byTeam) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const bothHalves =
          a.ids.field === b.ids.field &&
          a.ids.subunit !== null &&
          b.ids.subunit !== null &&
          a.ids.subunit !== b.ids.subunit;
        if (!bothHalves || !practiceWindowsOverlap(a, b)) continue;
        teamsOnBothHalves.add(teamId);
        for (const [x, y] of [
          [a, b],
          [b, a],
        ]) {
          if (x.flags.some((f) => f.code === R.TEAM_ON_BOTH_HALVES)) continue;
          x.flags.push({
            code: R.TEAM_ON_BOTH_HALVES,
            message: `The team is on both halves of this field at the same time (row ${y.rowNumber}). That is the whole field: leave Subunit blank for the whole field.`,
            details: { withRow: y.rowNumber },
          });
        }
      }
    }
  }
  // A hold over a slot of the same file.
  for (const { row: r } of resolved) {
    if (r.status !== 'hold' || !r.ids) continue;
    const held = {
      fieldId: r.ids.field,
      subunitId: r.ids.subunit,
      day: r.day,
      startTime: r.startTime,
      endTime: r.endTime,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
    };
    const over = (onGround.get(tuple(held.fieldId, held.day)) ?? []).find((s) =>
      practiceSlotsOverlap(s, held)
    );
    if (!over) continue;
    r.flags.push({
      code: R.HOLD_OVER_OPEN_SLOT,
      message:
        over.placements === 0
          ? `This cell is held for a non-team activity, but row ${over.rowNumbers[0]} makes an open slot there. The hold makes no slot and does not remove it.`
          : `This cell is held for a non-team activity, but row ${over.rowNumbers[0]} places a team there. The hold makes no slot and does not move the team.`,
      details: { withRow: over.rowNumbers[0], used: over.placements > 0 },
    });
  }

  // ---- What a confirmed import would create, from the rows that survive ----------------------------------
  const creations = {
    divisions: new Map(),
    locations: new Map(),
    fields: new Map(),
    subunits: new Map(),
    teamShells: new Map(),
  };
  /** @param {Map<string, any>} map @param {any} ref @param {Record<string, string>} [parent] */
  const note = (map, ref, parent = {}) => {
    if (!map.has(ref.id)) map.set(ref.id, { id: ref.id, ...parent, key: ref.key, name: ref.name });
  };
  for (const { row, refs: used } of resolved) {
    if (!used || (row.status !== 'placement' && row.status !== 'open')) continue;
    if (used.division?.type === 'create') note(creations.divisions, used.division);
    if (used.location.type === 'create') note(creations.locations, used.location);
    if (used.field.type === 'create')
      note(creations.fields, used.field, { locationId: used.field.locationId });
    if (used.subunit?.type === 'create')
      note(creations.subunits, used.subunit, { fieldId: used.subunit.fieldId });
    if (used.team?.type === 'create')
      note(creations.teamShells, used.team, { divisionId: used.team.divisionId });
  }
  /** Sorted by parent then name, as tuples, so the order does not depend on a delimiter. */
  const listed = (map) => {
    const order = (x) => JSON.stringify([x.divisionId ?? x.locationId ?? x.fieldId ?? '', x.key]);
    return [...map.values()].sort((x, y) =>
      order(x) < order(y) ? -1 : order(x) > order(y) ? 1 : 0
    );
  };

  const out = resolved.map((x) => x.row);
  const counts = {
    rows: out.length,
    placements: 0,
    open: 0,
    holds: 0,
    refused: 0,
    skipped: 0,
    slots: slots.length,
    byReason: /** @type {Record<string, number>} */ ({}),
    flags: /** @type {Record<string, { rows: number, teams?: number }>} */ ({}),
  };
  for (const r of out) {
    if (r.status === 'placement') counts.placements += 1;
    else if (r.status === 'open') counts.open += 1;
    else if (r.status === 'hold') counts.holds += 1;
    else if (r.status === 'skipped') counts.skipped += 1;
    else counts.refused += 1;
    if (r.status === 'refused' && r.reason)
      counts.byReason[r.reason] = (counts.byReason[r.reason] ?? 0) + 1;
    if (r.status === 'refused' || r.status === 'skipped') continue;
    for (const f of r.flags) {
      counts.flags[f.code] = { rows: (counts.flags[f.code]?.rows ?? 0) + 1 };
    }
  }
  if (teamsOnBothHalves.size > 0) {
    counts.flags[R.TEAM_ON_BOTH_HALVES].teams = teamsOnBothHalves.size;
  }
  return {
    rows: out,
    holds: out.filter((r) => r.status === 'hold'),
    creations: {
      divisions: listed(creations.divisions),
      locations: listed(creations.locations),
      fields: listed(creations.fields),
      subunits: listed(creations.subunits),
      teamShells: listed(creations.teamShells),
      slots,
    },
    counts,
  };
}

/* -------------------------------------------------------------------------- */
/* Division practice settings (decision 26)                                    */
/* -------------------------------------------------------------------------- */

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const {
  MIN_PRACTICES_PER_WEEK,
  MAX_PRACTICES_PER_WEEK,
  MIN_PRACTICE_MINUTES,
  MAX_PRACTICE_MINUTES,
} = PRACTICE_IMPORT_LIMITS;

/**
 * For each division in the file, the practice settings the file suggests, beside what is stored:
 *
 * - `practicesPerWeek`: the **most common count of rows per team** (a team is what its rows resolve to,
 *   so stray whitespace or a mapped alias does not split one); **a tie proposes nothing**.
 * - `practiceMinutes`: the slot length when every placement of the division has one length, else `'any'`
 *   (`NULL` in the column).
 *
 * Only placements count: an open slot, a hold, a refused row and a skipped one are nobody's practice.
 * A proposal is applied only for a ticked division ({@link divisionSettingsToApply}). A division at one a
 * week with no length is the column default and cannot be told from "unset", so the stored value is
 * shown beside the proposal and the screen asks.
 *
 * @param {Object} input
 * @param {Array<any>} input.rows  from {@link resolvePracticeRows}
 * @param {PracticeLeagueView} input.league
 */
export function proposeDivisionSettings({ rows, league }) {
  requireArray(rows, 'rows');
  const world = indexLeague(league);
  /** @type {Map<string, { divisionId: string, label: string, labelKey: string, teams: Map<string, number>, lengths: Set<number> }>} */
  const byDivision = new Map();
  for (const r of rows) {
    if (r.status !== 'placement' || !r.ids?.division || !r.ids.team) continue;
    let d = byDivision.get(r.ids.division);
    if (!d) {
      d = {
        divisionId: r.ids.division,
        label: r.divisionLabel,
        labelKey: practiceLabelKey(r.divisionLabel),
        teams: new Map(),
        lengths: new Set(),
      };
      byDivision.set(r.ids.division, d);
    }
    d.teams.set(r.ids.team, (d.teams.get(r.ids.team) ?? 0) + 1);
    d.lengths.add(minutesOf(r.endTime) - minutesOf(r.startTime));
  }

  return [...byDivision.values()]
    .sort((a, b) => (a.labelKey < b.labelKey ? -1 : a.labelKey > b.labelKey ? 1 : 0))
    .map((d) => {
      const stored = world.divisionsById.get(d.divisionId);
      const storedPerWeek = stored?.practicesPerWeek ?? null;
      const storedMinutes = stored?.practiceMinutes ?? null;

      /** @type {Record<number, number>} teams holding N rows */
      const histogram = {};
      for (const n of d.teams.values()) histogram[n] = (histogram[n] ?? 0) + 1;
      const top = Math.max(...Object.values(histogram));
      const modal = Object.keys(histogram)
        .map(Number)
        .filter((n) => histogram[n] === top)
        .sort((a, b) => a - b);
      const tie = modal.length > 1;
      const perWeek = tie ? null : modal[0];

      const lengths = [...d.lengths].sort((a, b) => a - b);
      const minutes = lengths.length === 0 ? null : lengths.length === 1 ? lengths[0] : 'any';
      // a proposal the RPC would refuse is shown, and never offered as a change (`storable`)
      const minutesStorable =
        minutes === null ||
        minutes === 'any' ||
        (minutes >= MIN_PRACTICE_MINUTES && minutes <= MAX_PRACTICE_MINUTES);
      const perWeekStorable =
        perWeek === null ||
        (perWeek >= MIN_PRACTICES_PER_WEEK && perWeek <= MAX_PRACTICES_PER_WEEK);
      return {
        divisionId: d.divisionId,
        label: d.label,
        isNew: d.divisionId.startsWith('new:'),
        teams: d.teams.size,
        rows: [...d.teams.values()].reduce((a, b) => a + b, 0),
        practicesPerWeek: {
          proposed: perWeek,
          tie,
          tied: tie ? modal : [],
          histogram,
          stored: storedPerWeek,
          differs: perWeek !== null && perWeek !== storedPerWeek,
          storable: perWeekStorable,
        },
        practiceMinutes: {
          proposed: minutes,
          lengths,
          stored: storedMinutes,
          // NULL in the column means any slot length
          differs: minutes !== null && minutes !== (storedMinutes ?? 'any'),
          storable: minutesStorable,
        },
      };
    });
}

/**
 * The settings to apply for the divisions the admin ticked: only the values the file proposes, that
 * differ from what is stored, **and that the database would accept**, and nothing for a division left
 * unticked (decision 26: never silent). A proposal outside what `admin_upsert_division_settings` takes
 * (0 to 7 practices a week; a length of 15 to 240 minutes) is **withheld, not emitted**: it is listed
 * in the division's `withheld` with its range, so the screen can say why it was not offered, and a
 * division with only withheld values is still in the answer. `'any'` is the proposal's word for "no
 * length"; how it reaches the RPC is PR 10's.
 *
 * @param {ReturnType<typeof proposeDivisionSettings>} proposals
 * @param {Iterable<string>} ticked  division ids
 * @returns {Array<{
 *   divisionId: string,
 *   isNew: boolean,
 *   practicesPerWeek?: number,
 *   practiceMinutes?: number | 'any',
 *   withheld?: Array<{ setting: 'practicesPerWeek' | 'practiceMinutes', proposed: number, why: 'out-of-range', min: number, max: number }>,
 * }>}
 * @throws {TypeError} on a ticked id that is not among the proposals
 */
export function divisionSettingsToApply(proposals, ticked) {
  const wanted = new Set(ticked);
  const known = new Set(proposals.map((p) => p.divisionId));
  for (const id of wanted) {
    if (!known.has(id)) {
      throw new TypeError(
        `divisionSettingsToApply: ${JSON.stringify(id)} is not a division of the proposals`
      );
    }
  }
  const out = [];
  for (const p of proposals) {
    if (!wanted.has(p.divisionId)) continue;
    /** @type {any} */
    const patch = { divisionId: p.divisionId, isNew: p.isNew };
    /** @type {Array<{ setting: string, proposed: number, why: 'out-of-range', min: number, max: number }>} */
    const withheld = [];
    if (p.practicesPerWeek.differs) {
      if (p.practicesPerWeek.storable) patch.practicesPerWeek = p.practicesPerWeek.proposed;
      else {
        withheld.push({
          setting: 'practicesPerWeek',
          proposed: /** @type {number} */ (p.practicesPerWeek.proposed),
          why: 'out-of-range',
          min: MIN_PRACTICES_PER_WEEK,
          max: MAX_PRACTICES_PER_WEEK,
        });
      }
    }
    if (p.practiceMinutes.differs) {
      if (p.practiceMinutes.storable) patch.practiceMinutes = p.practiceMinutes.proposed;
      else {
        withheld.push({
          setting: 'practiceMinutes',
          proposed: /** @type {number} */ (p.practiceMinutes.proposed),
          why: 'out-of-range',
          min: MIN_PRACTICE_MINUTES,
          max: MAX_PRACTICE_MINUTES,
        });
      }
    }
    if (withheld.length > 0) patch.withheld = withheld;
    if (
      patch.practicesPerWeek !== undefined ||
      patch.practiceMinutes !== undefined ||
      withheld.length > 0
    ) {
      out.push(patch);
    }
  }
  return out;
}
