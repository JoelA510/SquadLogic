/**
 * PR 1 task A2 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md): the Edge half of the
 * Published switch.
 *
 * - `gamePublishedErrorResponse`: the two refusals map to 409 `GAME_PUBLISHED` with the games named, and EVERY
 *   other error is left as it is (null, so the handler's existing 500 stands);
 * - source pins on `game-persistence/index.ts` (vitest cannot load the Deno function): the mapping runs after the
 *   audit-write check and before the failure log, and the existing 500 is still the last word for everything else.
 *
 * F11-1 (docs/changes/2026-11-06-games-table-source-of-truth.md) adds `gameIdentityErrorResponse`: the refusals of a
 * save that names games by id (an id that is not a uuid, a game named twice, a game that is not there, a game of
 * another season, two games at one place, and a game removed while the save was being checked) are the same kind of
 * outcome as a Published game: caused by what the admin sent, or by another admin's act a moment before, so a 409 with
 * the database's words and not a failure that pages anyone. Every other error still falls through.
 *
 * The database half (the guard, the omission refusal and their DETAIL text) is supabase/tests/game_published.sql and
 * docs/sql/20261119010000_smoke.sql; this file holds the text the Edge parses to the text the migration writes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  gameIdentityErrorResponse,
  gamePublishedErrorResponse,
} from '../supabase/functions/_shared/game-persistence-errors.ts';

const ROOT = process.cwd();
const INDEX = readFileSync(path.join(ROOT, 'supabase/functions/game-persistence/index.ts'), 'utf8');
const MIGRATION = readFileSync(
  path.join(ROOT, 'supabase/migrations/20261119010000_game_published.sql'),
  'utf8'
);
const IDENTITY_MIGRATION = readFileSync(
  path.join(ROOT, 'supabase/migrations/20261120010000_game_identity.sql'),
  'utf8'
);

const A = 'a1111111-1111-1111-1111-0000000c0e01';
const B = 'a1111111-1111-1111-1111-0000000c0e02';

describe('gamePublishedErrorResponse', () => {
  it('maps the trigger refusal to a 409 naming the game, and keeps the database message', () => {
    const message = `Game ${A} is Published and cannot be moved: allow changes to it first`;
    const mapped = gamePublishedErrorResponse({
      code: '22023',
      details: 'game_published',
      message,
    });
    expect(mapped).toEqual({
      status: 409,
      body: {
        status: 'error',
        code: 'GAME_PUBLISHED',
        reason: 'game_published',
        message,
        ids: [A],
        count: 1,
      },
    });
  });

  it('maps the omission refusal to a 409 with the ids and the count the database gave', () => {
    const message =
      'this save leaves out 2402 Published game(s): a save carries every Published game';
    const mapped = gamePublishedErrorResponse({
      code: '22023',
      details: `game_published_omitted count=2402 ids=${A},${B}`,
      message,
    });
    expect(mapped?.status).toBe(409);
    expect(mapped?.body).toEqual({
      status: 'error',
      code: 'GAME_PUBLISHED',
      reason: 'game_published_omitted',
      message,
      ids: [A, B],
      count: 2402,
    });
  });

  it('leaves every other error as it is', () => {
    const others = [
      { code: '22023', details: 'season_completed', message: 'Season s is completed' },
      { code: '22023', details: null, message: 'assignment end must be after start' },
      { code: '22023', details: 'game_published_other', message: 'x' },
      { code: '42501', details: 'game_published', message: 'caller is not an admin' },
      { code: '23503', details: 'game_published', message: 'x' },
      { code: 'SLA01', details: '23503', message: 'audit write failed' },
      { code: undefined, message: 'network down' },
      new Error('boom'),
      null,
      undefined,
    ];
    for (const error of others) expect(gamePublishedErrorResponse(error)).toBeNull();
  });

  it('reads the text the migration writes (the DETAIL formats are held to the SQL)', () => {
    expect(MIGRATION).toMatch(/DETAIL = 'game_published'/);
    expect(MIGRATION).toMatch(
      /format\('game_published_omitted count=%s ids=%s', v_omitted_count, array_to_string\(v_omitted_ids, ','\)\)/
    );
    // Both refusals are 22023, the code the mapper keys on.
    const refusals = MIGRATION.split('\n').filter(
      (line) => line.includes('DETAIL = ') && /game_published/.test(line)
    );
    expect(refusals.length).toBeGreaterThanOrEqual(4);
  });
});

describe('gamePublishedErrorResponse: a game held by its score (20261122010000, F11-2)', () => {
  const SCORES_MIGRATION = readFileSync(
    path.join(ROOT, 'supabase/migrations/20261122010000_game_scores.sql'),
    'utf8'
  );

  it('maps the scored refusals to the same 409 as the Published pair, with their own reason', () => {
    const moved = gamePublishedErrorResponse({
      code: '22023',
      details: 'game_scored',
      message: `Game ${A} has a score and cannot be moved: clear its score first`,
    });
    expect(moved).toMatchObject({
      status: 409,
      body: { code: 'GAME_PUBLISHED', reason: 'game_scored', ids: [A], count: 1 },
    });
    expect(moved?.body.message).toContain('clear its score first');
    const omitted = gamePublishedErrorResponse({
      code: '22023',
      details: `game_scored_omitted count=3 ids=${A},${B}`,
      message: 'this save leaves out 3 game(s) that have a score',
    });
    expect(omitted).toMatchObject({
      status: 409,
      body: { code: 'GAME_PUBLISHED', reason: 'game_scored_omitted', ids: [A, B], count: 3 },
    });
  });

  it('CONTROL: a detail that only looks like one is not mapped', () => {
    expect(
      gamePublishedErrorResponse({ code: '22023', details: 'game_scoredx', message: 'x' })
    ).toBe(null);
    expect(
      gamePublishedErrorResponse({
        code: '22023',
        details: `game_score_omitted count=1 ids=${A}`,
        message: 'x',
      })
    ).toBe(null);
  });

  it('reads the text the migration writes', () => {
    expect(SCORES_MIGRATION).toMatch(/DETAIL = 'game_scored'/);
    expect(SCORES_MIGRATION).toMatch(
      /format\('game_scored_omitted count=%s ids=%s', v_scored_omitted_count, array_to_string\(v_scored_omitted_ids, ','\)\)/
    );
    // Every DETAIL the migration raises with a game_* held code is one the mapper knows.
    const details = [
      ...SCORES_MIGRATION.matchAll(/DETAIL = (?:format\()?'(game_(?:scored|published)[a-z_]*)/g),
    ].map((m) => m[1]);
    expect(new Set(details)).toEqual(
      new Set(['game_scored', 'game_published', 'game_scored_omitted', 'game_published_omitted'])
    );
  });
});

const C = 'a1111111-1111-1111-1111-0000000c0e03';
const REMOVED =
  'a game was removed while this save was being checked: nothing was saved, try again';

describe('gameIdentityErrorResponse', () => {
  /** @type {Array<[string, any, { reason: string, ids: string[], logged: boolean }]>} */
  const CASES = [
    [
      'an id that is not a uuid',
      {
        code: '22023',
        details: 'game_identity_invalid',
        message: 'assignment id "review-0" is not a game id (a uuid)',
      },
      { reason: 'game_identity_invalid', ids: [], logged: true },
    ],
    [
      'a game named twice',
      {
        code: '22023',
        details: 'game_identity_repeated',
        message: `game ${A} is named more than once in this save`,
      },
      { reason: 'game_identity_repeated', ids: [A], logged: true },
    ],
    [
      'a game that is not there (and one of another organization, in the same words)',
      {
        code: '23503',
        details: 'game_not_found',
        message: `game ${B} does not exist in this organization`,
      },
      { reason: 'game_not_found', ids: [B], logged: false },
    ],
    [
      'a game of another season',
      {
        code: '22023',
        details: `game_identity_season ids=${C}`,
        message: `game ${C} is a game of another season: a save names only games of its own season`,
      },
      { reason: 'game_identity_season', ids: [C], logged: false },
    ],
    [
      'two games at one place',
      {
        code: '22023',
        details: `game_identity_conflict ids=${A},${B}`,
        message: `game ${A} would end where ${B} already is: one place holds one game of a pair (the unique matchup, slot and week)`,
      },
      { reason: 'game_identity_conflict', ids: [A, B], logged: false },
    ],
    [
      'a game at the place of a new game of the same save (one id)',
      {
        code: '22023',
        details: `game_identity_conflict ids=${A}`,
        message: `game ${A} would end where a new game of this save already is: one place holds one game of a pair (the unique matchup, slot and week)`,
      },
      { reason: 'game_identity_conflict', ids: [A], logged: false },
    ],
    [
      'a game removed while the save was being checked',
      { code: '40001', details: null, message: REMOVED },
      { reason: 'game_removed', ids: [], logged: false },
    ],
  ];

  it.each(CASES)('maps %s to a 409 that keeps the database message', (_label, error, want) => {
    const mapped = gameIdentityErrorResponse(error);
    expect(mapped).toEqual({
      status: 409,
      body: {
        status: 'error',
        code: 'GAME_IDENTITY',
        reason: want.reason,
        message: error.message,
        ids: want.ids,
      },
      logAsFailure: want.logged,
    });
  });

  it('asks for the failure log for exactly the two refusals the page itself must never cause', () => {
    // An id that is not a uuid and a game named twice are not an admin's doing or a race: the page never sends a
    // placeholder id (only saved games carry one) and the matcher throws on a duplicate, so either signals a page
    // regression and stays visible in the failure log. The other four are caused by what the admin sent or by another
    // admin a moment before, and are not logged. The answer (409, the database's message) is the same for all six.
    const logged = CASES.filter(
      ([, error]) => gameIdentityErrorResponse(error)?.logAsFailure === true
    )
      .map(([, , want]) => want.reason)
      .sort();
    const quiet = CASES.filter(
      ([, error]) => gameIdentityErrorResponse(error)?.logAsFailure === false
    )
      .map(([, , want]) => want.reason)
      .sort();
    expect(logged).toEqual(['game_identity_invalid', 'game_identity_repeated']);
    expect(quiet).toEqual([
      'game_identity_conflict',
      'game_identity_conflict',
      'game_identity_season',
      'game_not_found',
      'game_removed',
    ]);
    // Every case is in one list or the other: a mapper that forgot the flag (undefined) fills neither.
    expect(logged.length + quiet.length).toBe(CASES.length);
  });

  it('answers a refusal with no message with words of its own', () => {
    const mapped = gameIdentityErrorResponse({ code: '22023', details: 'game_identity_invalid' });
    expect(mapped?.status).toBe(409);
    expect(mapped?.body.message).toMatch(/game id|uuid|identity/i);
    expect(mapped?.body.message.length).toBeGreaterThan(10);
  });

  it('leaves every other error as it is (the existing 500 stands, and it is logged)', () => {
    const others = [
      { code: '22023', details: 'season_completed', message: 'Season s is completed' },
      { code: '22023', details: null, message: 'assignment end must be after start' },
      { code: '22023', details: 'game_published', message: `Game ${A} is Published` },
      { code: '22023', details: 'game_identity_other', message: 'x' },
      { code: '22023', details: 'game_identity_conflict_extra ids=x', message: 'x' },
      { code: '22023', details: `game_identity_conflict ids=${A};${B}`, message: 'x' },
      { code: '22023', details: 'game_identity_season', message: 'x' },
      { code: '42501', details: 'game_identity_invalid', message: 'caller is not an admin' },
      { code: '42501', details: 'game_not_found', message: 'x' },
      { code: '23503', details: null, message: 'home team x does not exist' },
      { code: '23503', details: 'game_identity_invalid', message: 'x' },
      { code: '23505', details: 'game_not_found', message: 'duplicate key' },
      {
        code: '40001',
        details: null,
        message: 'could not serialize access due to concurrent update',
      },
      { code: '40001', details: 'game_not_found', message: 'x' },
      { code: '40P01', details: null, message: REMOVED },
      { code: 'SLA01', details: '23503', message: 'audit write failed' },
      { code: undefined, message: 'network down' },
      new Error('boom'),
      null,
      undefined,
    ];
    for (const error of others) expect(gameIdentityErrorResponse(error)).toBeNull();
  });

  it('is disjoint from the Published mapping: neither answers the other', () => {
    for (const [, error] of CASES) expect(gamePublishedErrorResponse(error)).toBeNull();
    expect(
      gameIdentityErrorResponse({
        code: '22023',
        details: 'game_published',
        message: `Game ${A} is Published and cannot be moved: allow changes to it first`,
      })
    ).toBeNull();
    expect(
      gameIdentityErrorResponse({
        code: '22023',
        details: `game_published_omitted count=1 ids=${A}`,
        message: 'x',
      })
    ).toBeNull();
  });

  it('reads the text the migration writes (the DETAIL formats and the message are held to the SQL)', () => {
    expect(IDENTITY_MIGRATION).toMatch(/DETAIL = 'game_identity_invalid'/);
    expect(IDENTITY_MIGRATION).toMatch(/DETAIL = 'game_identity_repeated'/);
    expect(IDENTITY_MIGRATION).toMatch(/DETAIL = 'game_not_found'/);
    expect(IDENTITY_MIGRATION).toMatch(/format\('game_identity_conflict ids=%s', /);
    expect(IDENTITY_MIGRATION).toMatch(/format\('game_identity_season ids=%s', /);
    // The codes the mapper keys on: 22023 for four, 23503 for the unknown game, 40001 for the removed one.
    const raise = (detail) =>
      IDENTITY_MIGRATION.split('USING ERRCODE = ').filter((chunk) => chunk.includes(detail));
    for (const detail of [
      "DETAIL = 'game_identity_invalid'",
      "DETAIL = 'game_identity_repeated'",
      'game_identity_conflict ids=%s',
      'game_identity_season ids=%s',
    ]) {
      const chunks = raise(detail);
      expect(chunks.length, detail).toBeGreaterThan(0);
      expect(chunks[0], detail).toMatch(/^'22023'/);
    }
    expect(raise("DETAIL = 'game_not_found'")[0]).toMatch(/^'23503'/);
    // The removed-game message is word for word the SQL's, and its SQLSTATE is 40001.
    const at = IDENTITY_MIGRATION.indexOf(`'${REMOVED}'`);
    expect(at).toBeGreaterThan(0);
    expect(IDENTITY_MIGRATION.slice(at, at + 160)).toMatch(/ERRCODE = '40001'/);
  });
});

describe('game-persistence/index.ts', () => {
  it('maps the refusal after the audit-write check and before the failure log', () => {
    const audit = INDEX.indexOf('isAuditWriteFailure(error)');
    const mapped = INDEX.indexOf('gamePublishedErrorResponse(error)');
    const logged = INDEX.indexOf("logFailure(logCtx, 'Game persistence failed', error)");
    expect(audit).toBeGreaterThan(0);
    expect(mapped).toBeGreaterThan(audit);
    expect(logged).toBeGreaterThan(mapped);
  });

  it('answers with the mapped body and status, and keeps the 500 for everything else', () => {
    expect(INDEX).toMatch(
      /if \(published\) return jsonResponse\(published\.body, published\.status\);/
    );
    expect(INDEX).toMatch(
      /message: \(error as Error\)\?\.message \|\| 'Failed to persist game snapshot\.',\s*\},\s*500/
    );
  });
  it('maps the identity refusals after the Published mapping and before the generic failure log, logging only when the mapper says so', () => {
    const published = INDEX.indexOf('gamePublishedErrorResponse(error)');
    const identity = INDEX.indexOf('gameIdentityErrorResponse(error)');
    const generic = INDEX.lastIndexOf("logFailure(logCtx, 'Game persistence failed', error)");
    expect(identity).toBeGreaterThan(published);
    expect(generic).toBeGreaterThan(identity);
    // The identity branch logs, with the generic path's call, only for a refusal the mapper marks, and before it answers.
    expect(INDEX).toMatch(
      /if \(identity\) \{\s*if \(identity\.logAsFailure\) await logFailure\(logCtx, 'Game persistence failed', error\);\s*return jsonResponse\(identity\.body, identity\.status\);\s*\}/
    );
    expect(INDEX).toMatch(
      /import \{[^}]*gameIdentityErrorResponse[^}]*\} from '\.\.\/_shared\/game-persistence-errors\.ts'/
    );
  });
});
