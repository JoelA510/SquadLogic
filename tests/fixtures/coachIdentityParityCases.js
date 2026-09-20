/**
 * **The one case table the core and the Deno mirror are both held to.**
 *
 * `packages/core/src/people/coachList.js` derives a coach's identity key by one
 * rule — id, else email, else name, else nothing — and hands the solvers only
 * the id-keyed coaches. `supabase/functions/_shared/engines/practice-coaches.ts`
 * mirrors the clash half of that rule for the Edge Function. Two
 * implementations of one rule drift by exactly the branch nobody tested: the
 * first mirror keyed a `coaches` entry by `displayName` where the core keyed it
 * by list index, so Team A `[{ displayName: 'Ada' }]` against Team B
 * `[{ displayName: 'Bo' }]` was a clash in the core and none in the mirror.
 *
 * Every fallback branch is a row here. `tests/coachModel.test.js` asserts the
 * core's `listTeamCoachIds()` against `clashKeys`; the Deno test asserts the
 * mirror's against the same rows. Parity is therefore transitive through this
 * file rather than claimed by a comment in either.
 *
 * Plain ESM with no imports, because Deno loads it by relative path. It used
 * to say "and `deno test` runs with no read permission"; that stopped being
 * true when the mirror job moved to `scripts/deno-mirror-tests.sh`, which
 * passes `--allow-read=.` to every file. The no-imports shape is still worth
 * keeping -- it is what lets both runtimes load this table unchanged -- but
 * the permission is no longer the reason.
 *
 * @typedef {Object} CoachIdentityParityCase
 * @property {string} label - names the branch, so a failure says which one drifted
 * @property {Object} team - the row as either engine receives it
 * @property {string[]} clashKeys - the keys the solvers may compare, order-free
 * @property {string} side - which side the branch lands on (`id`, `email`, `name`, `nothing`, `nobody`), a colon, and why
 */

/** @type {ReadonlyArray<CoachIdentityParityCase>} */
export const COACH_IDENTITY_PARITY_CASES = Object.freeze([
  {
    label: 'coaches[].personId',
    team: { id: 'T', coaches: [{ personId: 'c1', slot: 1 }] },
    clashKeys: ['c1'],
    side: 'id: corroborated',
  },
  {
    label: 'coaches[].id',
    team: { id: 'T', coaches: [{ id: 'c1', slot: 1 }] },
    clashKeys: ['c1'],
    side: 'id: corroborated',
  },
  {
    label: 'coaches[].personId wins over coaches[].id when both are present',
    team: { id: 'T', coaches: [{ personId: 'p1', id: 'c1', slot: 1 }] },
    clashKeys: ['p1'],
    side: 'id: corroborated',
  },
  {
    label: 'coaches[].displayName only',
    team: { id: 'T', coaches: [{ displayName: 'Ada', slot: 1 }] },
    clashKeys: [],
    side: 'name: uncorroborated, so never a clash key',
  },
  {
    label: 'coaches[].name only',
    team: { id: 'T', coaches: [{ name: 'Ada', slot: 1 }] },
    clashKeys: [],
    side: 'name: uncorroborated, so never a clash key',
  },
  {
    label: 'coaches[].email only',
    team: { id: 'T', coaches: [{ email: 'ada@example.test', slot: 1 }] },
    clashKeys: [],
    side: 'email: uncorroborated, so never a clash key',
  },
  {
    label: 'coaches[].displayName and email, no id',
    team: { id: 'T', coaches: [{ displayName: 'Ada', email: 'ada@example.test', slot: 1 }] },
    clashKeys: [],
    side: 'email: uncorroborated, so never a clash key',
  },
  {
    label: 'coaches[] entry with nothing to key on',
    team: { id: 'T', coaches: [{ slot: 1 }] },
    clashKeys: [],
    side: 'nothing: dropped, never keyed by its list index',
  },
  {
    label: 'coaches[] entry with blank id and a name',
    team: { id: 'T', coaches: [{ personId: '', displayName: 'Ada', slot: 1 }] },
    clashKeys: [],
    side: 'name: a blank id is an absent id',
  },
  {
    label: 'a reconciled entry read back in keeps its declared kind',
    team: { id: 'T', coaches: [{ personId: 'ada@example.test', keyKind: 'email', slot: 1 }] },
    clashKeys: [],
    side: 'email: the declared kind is honoured, never promoted to id by a second pass',
  },
  {
    label: 'a reconciled entry declaring keyKind id',
    team: { id: 'T', coaches: [{ personId: 'c1', keyKind: 'id', slot: 1 }] },
    clashKeys: ['c1'],
    side: 'id: corroborated',
  },
  {
    label: 'legacy coachId',
    team: { id: 'T', coachId: 'h1' },
    clashKeys: ['h1'],
    side: 'id: corroborated',
  },
  {
    label: 'legacy assistantCoachIds',
    team: { id: 'T', coachId: null, assistantCoachIds: ['a1', 'a2'] },
    clashKeys: ['a1', 'a2'],
    side: 'id: corroborated',
  },
  {
    label: 'legacy assistant_coach_ids (the teams-column spelling)',
    team: { id: 'T', coachId: 'h1', assistant_coach_ids: ['a1'] },
    clashKeys: ['h1', 'a1'],
    side: 'id: corroborated',
  },
  {
    label: 'legacy ids deduplicated, blanks dropped',
    team: { id: 'T', coachId: 'h1', assistantCoachIds: ['a1', 'h1', '', 'a1'] },
    clashKeys: ['h1', 'a1'],
    side: 'id: corroborated; the same id twice is one person',
  },
  {
    label: 'legacy coachName with no coachId',
    team: { id: 'T', coachId: null, coachName: 'Coach Mike' },
    clashKeys: [],
    side: 'name: uncorroborated, so never a clash key',
  },
  {
    label: 'legacy assistantCoaches names with no ids',
    team: { id: 'T', coachId: 'h1', assistantCoaches: ['Ada', 'Bo'] },
    clashKeys: ['h1'],
    side: 'id: the named assistants are name-keyed and excluded; the id stays',
  },
  {
    label: 'both shapes, overlapping: union of the id-keyed, deduplicated',
    team: {
      id: 'T',
      coachId: 'c1',
      assistantCoachIds: ['a1'],
      coaches: [
        { personId: 'c1', slot: 1 },
        { personId: 'c2', slot: 2 },
        { displayName: 'Named Only', slot: 3 },
      ],
    },
    clashKeys: ['c1', 'c2', 'a1'],
    side: 'id: keys from either shape; the name-only entry is excluded',
  },
  {
    label: 'no coach fields at all',
    team: { id: 'T' },
    clashKeys: [],
    side: 'nobody: an uncoached team',
  },
]);

/**
 * The derivation the first mirror used, kept so a parity test can prove the
 * table discriminates: at least one row must fail under it, or the table would
 * pass any implementation and prove nothing.
 *
 * @param {any} team
 * @returns {string[]}
 */
export function firstMirrorClashKeys(team) {
  const ids = new Set();
  for (const coach of team.coaches ?? []) {
    const key = coach?.personId ?? coach?.id ?? coach?.displayName ?? coach?.name;
    if (key) ids.add(String(key));
  }
  if (team.coachId) ids.add(team.coachId);
  for (const id of team.assistantCoachIds ?? team.assistant_coach_ids ?? []) {
    if (id) ids.add(id);
  }
  return [...ids];
}
