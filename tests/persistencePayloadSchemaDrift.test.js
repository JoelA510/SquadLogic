/**
 * M4.4 (audit finding 2.3): the persistence clients check each body against
 * core's copy of the schema its Edge Function parses it with, before the
 * network call. That check is only right while the copy refuses exactly what
 * the server refuses: stricter, and the client blocks a save the server would
 * take; laxer, and the "validated" body still comes back a 400.
 *
 * So each Edge `PersistencePayloadSchema` is evaluated from its own source,
 * under zod 3 (the Deno Edge's major, `deno.land/x/zod@v3.22.4`), and held to
 * the same verdict as core's schema over a mutation product of valid bodies:
 * every path removed, nulled, and replaced by a value of each other JSON type.
 * The precedent is `tests/practiceRepairAdapter.test.js`'s `edgeRepairSchema`.
 *
 * The practice block names `PracticeRepairSchema` and `PracticeEnactSchema`,
 * which the client does not check (the schemas' note says why); they are bound
 * to `z.unknown()` here, so the comparison is of the snapshot, the part both
 * sides validate.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z as z3 } from 'zod/v3';

import {
  GamePersistencePayloadSchema,
  PersistencePayloadSchema,
  PracticePersistencePayloadSchema,
} from '../packages/core/src/schemas/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The Edge Function's `PersistencePayloadSchema`, evaluated from its source. */
function edgeSchema(functionName) {
  const source = readFileSync(
    path.join(REPO_ROOT, 'supabase/functions', functionName, 'index.ts'),
    'utf8'
  );
  const start = source.indexOf('const PersistencePayloadSchema = z.object({');
  const end = source.indexOf('\n});\n', start);
  expect(
    start,
    `${functionName}: the schema block was not found; this test is stale`
  ).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end + '\n});'.length);
  return new Function(
    'z',
    'PracticeRepairSchema',
    'PracticeEnactSchema',
    `${block}\nreturn PersistencePayloadSchema;`
  )(z3, z3.unknown(), z3.unknown());
}

const CASES = {
  'team-persistence': {
    core: PersistencePayloadSchema,
    valid: [
      {
        snapshot: {
          payload: {
            teamRows: [{ id: 'team-1', name: 'Comets' }],
            teamPlayerRows: [{ team_id: 'team-1', player_id: 'player-1' }],
          },
          lastRunId: 'run-1',
          runId: null,
        },
        overrides: [{ status: 'applied' }],
        runMetadata: { runId: 'run-1' },
      },
    ],
  },
  'game-persistence': {
    core: GamePersistencePayloadSchema,
    valid: [
      {
        snapshot: {
          payload: {
            assignmentRows: [
              {
                home_team_id: 'team-1',
                homeTeamId: 'team-1',
                away_team_id: 'team-2',
                awayTeamId: 'team-2',
                slot_id: 'slot-1',
                slotId: 'slot-1',
                game_slot_id: 'slot-1',
                gameSlotId: 'slot-1',
                division: 'U10',
              },
            ],
          },
          lastRunId: null,
          runId: 'run-1',
        },
        overrides: [],
        runMetadata: { organizationId: 'org-1' },
      },
      // The legacy spelling: `gameRows` instead of `assignmentRows` (the refine
      // takes either), so removing one list is judged with and without the other.
      {
        snapshot: { payload: { gameRows: [{ id: 'game-1', week_index: 1 }] } },
      },
    ],
  },
  'practice-persistence': {
    core: PracticePersistencePayloadSchema,
    valid: [
      {
        snapshot: {
          payload: {
            assignmentRows: [
              {
                team_id: 'team-1',
                practice_slot_id: 'slot-1',
                effective_date_range: '[2026-09-01,2026-11-30]',
              },
            ],
          },
          lastRunId: 'run-0',
          runId: 'run-1',
        },
        overrides: [],
        runMetadata: { seasonSettingsId: 'season-1' },
        repair: { unlock: [] },
      },
    ],
  },
};

const REPLACEMENTS = [null, 7, 'x', true, [], {}];

/** Every path in a JSON value, with the value at it. */
function* paths(value, at = []) {
  yield at;
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) yield* paths(value[key], [...at, key]);
  }
}

/** A deep copy of `value` with the node at `at` removed or replaced. */
function mutate(value, at, replacement, remove) {
  const copy = structuredClone(value);
  if (at.length === 0) return replacement;
  const parent = at.slice(0, -1).reduce((node, key) => node[key], copy);
  const key = at[at.length - 1];
  if (remove) {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete parent[key];
  } else {
    parent[key] = replacement;
  }
  return copy;
}

describe('persistence payload schemas: core (client) and Edge (server) agree', () => {
  for (const [functionName, { core, valid }] of Object.entries(CASES)) {
    it(`${functionName}: the same verdict on every mutation of a valid body`, () => {
      const edge = edgeSchema(functionName);
      const verdicts = { accepted: 0, refused: 0 };
      const disagreements = [];
      for (const body of valid) {
        expect(edge.safeParse(body).success, 'the valid body must pass the Edge').toBe(true);
        expect(core.safeParse(body).success, 'the valid body must pass core').toBe(true);
        for (const at of paths(body)) {
          const variants = [
            ['removed', mutate(body, at, undefined, true)],
            ...REPLACEMENTS.map((r) => [JSON.stringify(r), mutate(body, at, r, false)]),
          ];
          for (const [label, variant] of variants) {
            const server = edge.safeParse(variant).success;
            const client = core.safeParse(variant).success;
            verdicts[server ? 'accepted' : 'refused'] += 1;
            if (server !== client) {
              disagreements.push(
                `${at.join('.') || '(body)'} ${label}: edge ${server}, core ${client}`
              );
            }
          }
        }
      }
      expect(disagreements).toEqual([]);
      // Meta: the product reached both verdicts, so agreement is not two
      // schemas that accept (or refuse) everything.
      expect(verdicts.accepted).toBeGreaterThan(10);
      expect(verdicts.refused).toBeGreaterThan(10);
    });
  }

  it('covers every Edge function that parses a PersistencePayloadSchema (enumerated from disk)', () => {
    const dir = path.join(REPO_ROOT, 'supabase/functions');
    const found = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        const file = path.join(dir, name, 'index.ts');
        return (
          existsSync(file) &&
          readFileSync(file, 'utf8').includes('const PersistencePayloadSchema = z.object({')
        );
      })
      .sort();
    expect(
      found.length,
      'no Edge function found: the enumeration examined nothing'
    ).toBeGreaterThan(0);
    expect(found).toEqual(Object.keys(CASES).sort());
  });
});
