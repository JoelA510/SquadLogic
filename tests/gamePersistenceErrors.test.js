/**
 * PR 1 task A2 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md): the Edge half of the
 * Published switch.
 *
 * - `gamePublishedErrorResponse`: the two refusals map to 409 `GAME_PUBLISHED` with the games named, and EVERY
 *   other error is left as it is (null, so the handler's existing 500 stands);
 * - source pins on `game-persistence/index.ts` (vitest cannot load the Deno function): the mapping runs after the
 *   audit-write check and before the failure log, and the existing 500 is still the last word for everything else.
 *
 * The database half (the guard, the omission refusal and their DETAIL text) is supabase/tests/game_published.sql and
 * docs/sql/20261119010000_smoke.sql; this file holds the text the Edge parses to the text the migration writes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { gamePublishedErrorResponse } from '../supabase/functions/_shared/game-persistence-errors.ts';

const ROOT = process.cwd();
const INDEX = readFileSync(path.join(ROOT, 'supabase/functions/game-persistence/index.ts'), 'utf8');
const MIGRATION = readFileSync(
  path.join(ROOT, 'supabase/migrations/20261119010000_game_published.sql'),
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
});
