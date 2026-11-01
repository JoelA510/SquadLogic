/**
 * The auto-scheduler's solver input as bytes, and a digest of it (Phase D PR D; plan
 * `docs/changes/2026-10-27-phase-d-scheduling.md`, section D).
 *
 * `auto-scheduler`'s `prepare` mode loads every input of a run as the caller (through RLS, exactly
 * as `solve` does) and answers with {@link encodeSolverInput} of it plus {@link digestEncodedInput};
 * the browser's Web Worker {@link reviveSolverInput}s it and searches; the `verify` mode loads
 * everything again, itself, encodes it the same way and refuses (409 `INPUT_CHANGED`) when the
 * digest it computes is not the one the browser holds. The digest is therefore a check that the
 * worker searched the inputs the server now holds, never a credential: a body can claim any digest
 * and the server compares it with its own.
 *
 * **The encoding is canonical.** `Date`, `Map` and `Set`, which the solver's input is made of,
 * become tagged JSON (`{ "$date": iso }`, `{ "$map": [[key, value], ...] }`, `{ "$set": [...] }`);
 * object keys, map entries and set members are written in code-unit order, so two reads of the same
 * data encode to the same text whatever order a loader happened to produce them in. Array order is
 * kept: it is meaningful (the slots' order is the greedy seed's order). The solver never iterates a
 * map or a set (it looks values up), so the canonical order changes no answer; `tests/
 * practiceOptimizerWorker.test.js` runs the solver over an input and over its round trip and
 * requires equal placements.
 *
 * **A verdict that says nothing is left out.** The preference gate holds a verdict per constrained
 * team per slot; one with no `must_keep` breach, no `prefer_keep` breach and no dimension is what
 * the solver assumes of a slot the map does not name, so it is not written. That is the whole of
 * the compaction, and the digest is over the compact form.
 *
 * Imports are types only: the module is bundled into the browser worker, which must not pull in the
 * rest of the engines for it.
 */
import type { PreferenceGate, SlotVerdict } from './coach-preference-load.ts';
import type { PracticeSolverInput } from './auto-scheduler-solver.ts';

/** The refusal `verify` answers (409) when the server's reload no longer matches the digest. */
export const INPUT_CHANGED = 'INPUT_CHANGED';

/**
 * What `prepare` answers (422) when the input it loaded cannot be written down (a value the
 * encoding refuses, such as a number that is not finite). The page then runs the server's own
 * search, which reads the same input without encoding it: a league the encoding cannot describe is
 * still a league the server can schedule.
 */
export const SOLVER_INPUT_UNENCODABLE = 'SOLVER_INPUT_UNENCODABLE';

/** The encoding's version: a worker refuses an input of a version it does not know. */
export const SOLVER_INPUT_VERSION = 1;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A solver input as `prepare` sends it. */
export interface EncodedSolverInput {
  version: typeof SOLVER_INPUT_VERSION;
  /** The run's organization and season: a digest from another season never matches. */
  organizationId: string;
  seasonSettingsId: string;
  input: Json;
}

const TAGS = ['$date', '$map', '$set'] as const;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encodeValue(value: unknown, path: string): Json {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path}: ${String(value)} is not JSON`);
      return value;
    case 'undefined':
      // Only reachable inside an array (an object's undefined keys are skipped below).
      return null;
    case 'object':
      break;
    default:
      throw new TypeError(`${path}: a ${typeof value} cannot be encoded`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${path}: an invalid date`);
    return { $date: value.toISOString() };
  }
  if (value instanceof Map) {
    const entries: Array<[string, Json]> = [];
    for (const [key, entry] of value) {
      if (typeof key !== 'string') throw new TypeError(`${path}: a map key is not a string`);
      entries.push([key, encodeValue(entry, `${path}[${key}]`)]);
    }
    entries.sort(([a], [b]) => byCodeUnit(a, b));
    return { $map: entries };
  }
  if (value instanceof Set) {
    const members: string[] = [];
    for (const member of value) {
      if (typeof member !== 'string') throw new TypeError(`${path}: a set member is not a string`);
      members.push(member);
    }
    members.sort(byCodeUnit);
    return { $set: members };
  }
  if (Array.isArray(value)) return value.map((entry, i) => encodeValue(entry, `${path}[${i}]`));
  if (!isPlainObject(value))
    throw new TypeError(`${path}: an object of a kind that cannot be encoded`);
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort(byCodeUnit)) {
    if ((TAGS as readonly string[]).includes(key)) {
      throw new TypeError(`${path}: a key named ${key} would read as an encoding tag`);
    }
    if (value[key] === undefined) continue;
    out[key] = encodeValue(value[key], `${path}.${key}`);
  }
  return out;
}

const isDefaultVerdict = (verdict: SlotVerdict): boolean =>
  !verdict.mustKeepViolated &&
  verdict.preferKeepBreaches === 0 &&
  (verdict.violatedDimensions?.length ?? 0) === 0;

/** The gate without the verdicts that say nothing (see the module note). */
function compactGate(gate: PreferenceGate): PreferenceGate {
  const verdicts = new Map<string, Map<string, SlotVerdict>>();
  for (const [teamId, bySlot] of gate.verdicts) {
    const kept = new Map<string, SlotVerdict>();
    for (const [slotId, verdict] of bySlot)
      if (!isDefaultVerdict(verdict)) kept.set(slotId, verdict);
    // The team stays, even with nothing left: a team named in the gate is a constrained team.
    verdicts.set(teamId, kept);
  }
  return { verdicts };
}

/**
 * The solver input as JSON-safe data, canonical (see the module note). Throws a `TypeError` naming
 * the path of a value that cannot be encoded rather than writing something the worker would read
 * differently.
 */
export function encodeSolverInput(
  input: PracticeSolverInput,
  scope: { organizationId: string; seasonSettingsId: string }
): EncodedSolverInput {
  const { preferenceGate, ...rest } = input;
  return {
    version: SOLVER_INPUT_VERSION,
    organizationId: scope.organizationId,
    seasonSettingsId: scope.seasonSettingsId,
    input: encodeValue(
      { ...rest, ...(preferenceGate ? { preferenceGate: compactGate(preferenceGate) } : {}) },
      'input'
    ),
  };
}

function reviveValue(value: Json): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(reviveValue);
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const [key] = keys;
    const payload = value[key];
    if (key === '$date' && typeof payload === 'string') {
      const date = new Date(payload);
      if (Number.isNaN(date.getTime())) throw new TypeError(`an invalid encoded date: ${payload}`);
      return date;
    }
    if (key === '$map' && Array.isArray(payload)) {
      return new Map(
        payload.map((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
            throw new TypeError('an encoded map entry is not a [key, value] pair');
          }
          return [entry[0], reviveValue(entry[1] as Json)];
        })
      );
    }
    if (key === '$set' && Array.isArray(payload)) return new Set(payload as string[]);
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = reviveValue((value as { [key: string]: Json })[key]);
  return out;
}

/**
 * The solver input an {@link EncodedSolverInput} encodes. Throws a `TypeError` for an input of
 * another version or without the parts a run cannot start without; the worker reports that and the
 * page falls back to the server.
 */
export function reviveSolverInput(encoded: unknown): PracticeSolverInput {
  const candidate = encoded as Partial<EncodedSolverInput> | null;
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('the solver input is not an object');
  }
  if (candidate.version !== SOLVER_INPUT_VERSION) {
    throw new TypeError(`the solver input is version ${String(candidate.version)}, not 1`);
  }
  const input = reviveValue(candidate.input as Json) as Partial<PracticeSolverInput> | null;
  if (
    !input ||
    !Array.isArray(input.teams) ||
    !Array.isArray(input.slots) ||
    !Array.isArray(input.locked) ||
    !Array.isArray(input.placeableTeamIds) ||
    !input.dating ||
    !(input.dating.slots instanceof Map)
  ) {
    throw new TypeError('the solver input lacks its teams, slots, locked rows or dating');
  }
  return input as PracticeSolverInput;
}

/** The digest of an encoding: SHA-256 of its text, lower-case hex. */
export async function digestEncodedInput(encoded: EncodedSolverInput): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(encoded));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `verify`'s decision: does the server's own reload digest to what the browser says it searched?
 * `claimed` is whatever the body said; it is never trusted, only compared.
 */
export async function checkSolverInputDigest(
  current: EncodedSolverInput,
  claimed: string
): Promise<
  { ok: true; digest: string } | { ok: false; code: typeof INPUT_CHANGED; digest: string }
> {
  const digest = await digestEncodedInput(current);
  return digest === claimed ? { ok: true, digest } : { ok: false, code: INPUT_CHANGED, digest };
}
