/**
 * The deploy-migrations safety guard (scripts/ci/migrationGuard.mjs).
 *
 * Fixture shapes are the pinned CLI's (2.118.0) real `--output-format json`
 * output, captured against a local production-shaped ledger on 2026-09-28 --
 * see docs/operations/migration-ledger-normalisation.md.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PENDING,
  GuardError,
  evaluate,
  parseMax,
  verifyApplied,
} from '../scripts/ci/migrationGuard.mjs';

const APPLIED = ['20260920000000', '20260923000000', '20260924000000'];

/** `supabase migration list --output-format json`, as the CLI prints it. */
function listJson({ applied = APPLIED, pending = [], remoteOnly = [] } = {}) {
  const row = (local, remote) => ({ local, remote, time: '2026-09-24 00:00:00' });
  return JSON.stringify({
    migrations: [
      ...applied.map((v) => row(v, v)),
      ...remoteOnly.map((v) => row('', v)),
      ...pending.map((v) => row(v, '')),
    ],
    message: 'Migrations listed',
  });
}

/** `supabase db push --dry-run --output-format json`, as the CLI prints it. */
function dryJson(pending = [], extra = {}) {
  return JSON.stringify({
    upToDate: pending.length === 0,
    dryRun: true,
    migrations: pending.map((v) => `${v}_some_change.sql`),
    seeds: [],
    roles: [],
    message: pending.length === 0 ? 'Remote database is up to date.' : 'Finished supabase db push.',
    ...extra,
  });
}

const run = (pending, opts = {}) =>
  evaluate({
    listText: listJson({ pending, ...opts }),
    dryRunText: dryJson(pending),
    maxPending: opts.maxPending,
  });

describe('migration guard: pre-push decision', () => {
  it('passes the normal case: only new files, above the highest applied', () => {
    expect(run(['20260927000000', '20260928000000'])).toEqual({
      pending: ['20260927000000', '20260928000000'],
      highestApplied: '20260924000000',
    });
  });

  it('accepts the verbatim dry-run output captured from CLI 2.118.0', () => {
    const captured =
      '{"upToDate":false,"dryRun":true,"migrations":["20260927000000_coach_practice_preferences.sql"],' +
      '"seeds":[],"roles":[],"message":"Finished supabase db push."}\n';
    expect(
      evaluate({ listText: listJson({ pending: ['20260927000000'] }), dryRunText: captured })
        .pending
    ).toEqual(['20260927000000']);
  });

  it('passes an empty pending set (production up to date)', () => {
    expect(run([]).pending).toEqual([]);
  });

  it('fails an out-of-order pending version (below the highest applied)', () => {
    expect(() => run(['20260921000000'])).toThrow(/out-of-order migration\(s\) 20260921000000/);
  });

  it('fails a pending version EQUAL to the highest applied', () => {
    // The CLI would not list it (same key), but a ledger/dir mismatch could.
    expect(() =>
      evaluate({
        listText: JSON.stringify({
          migrations: [
            { local: '20260924000000', remote: '20260924000000', time: '' },
            { local: '20260924000000', remote: '', time: '' },
          ],
        }),
        dryRunText: dryJson(['20260924000000']),
      })
    ).toThrow(/out-of-order/);
  });

  it(`fails more than the default limit (${DEFAULT_MAX_PENDING}) pending`, () => {
    const six = [1, 2, 3, 4, 5, 6].map((d) => `2026093000000${d}`);
    expect(() => run(six)).toThrow(/6 migrations pending .* more than the limit of 5/);
    expect(run(six.slice(0, 5)).pending).toHaveLength(5);
  });

  it('honours a raised limit', () => {
    const six = [1, 2, 3, 4, 5, 6].map((d) => `2026093000000${d}`);
    expect(run(six, { maxPending: 6 }).pending).toHaveLength(6);
  });

  it('fails when the dry-run and migration list disagree about what is pending', () => {
    expect(() =>
      evaluate({
        listText: listJson({ pending: ['20260927000000'] }),
        dryRunText: dryJson(['20260927000000', '20260928000000']),
      })
    ).toThrow(/two CLI views disagree/);
  });

  it('fails an empty remote ledger (a push would replay everything)', () => {
    expect(() =>
      evaluate({
        listText: listJson({ applied: [], pending: ['20240405180000', '20260927000000'] }),
        dryRunText: dryJson(['20240405180000', '20260927000000']),
      })
    ).toThrow(/no applied migrations/);
  });

  it('fails remote-only versions (the apply-time ledger shape) and warns off repair', () => {
    expect(() => run(['20260927000000'], { remoteOnly: ['20260927155035'] })).toThrow(
      /20260927155035.*Do NOT run "migration repair --status reverted"/
    );
  });

  it('fails when the dry-run would push seed data', () => {
    expect(() =>
      evaluate({
        listText: listJson({ pending: ['20260927000000'] }),
        dryRunText: dryJson(['20260927000000'], { seeds: ['supabase/seed.sql'] }),
      })
    ).toThrow(/seed data/);
  });
});

describe('migration guard: unparseable output fails, never passes', () => {
  const ok = listJson({ pending: ['20260927000000'] });
  const okDry = dryJson(['20260927000000']);
  /** @type {Record<string, [string, string, RegExp]>} */
  const cases = {
    'empty dry-run file': [ok, '', /dry-run: output is not JSON/],
    'empty list file': ['', okDry, /list: output is not JSON/],
    'text-mode table instead of JSON': [
      '   Local            | Remote           | Time (UTC)\n   `20260924000000` | `20260924000000` |',
      okDry,
      /not JSON/,
    ],
    'the CLI error object': [
      ok,
      '{"_tag":"Error","error":{"code":"DbPushMissingLocalError","message":"Remote migration versions not found in local migrations directory."}}',
      /the CLI reported an error: Remote migration versions not found/,
    ],
    'JSON without a migrations array': [
      '{"message":"Migrations listed"}',
      okDry,
      /no "migrations" array/,
    ],
    'a list with zero rows': ['{"migrations":[]}', okDry, /zero rows/],
    'a list row that is not a version': [
      JSON.stringify({ migrations: [{ local: 'abc', remote: 'abc', time: '' }] }),
      okDry,
      /"abc" is not a migration version/,
    ],
    'a dry-run without dryRun: true': [
      ok,
      okDry.replace('"dryRun":true', '"dryRun":false'),
      /does not say dryRun: true/,
    ],
    'a dry-run without upToDate': [
      ok,
      okDry.replace('"upToDate":false,', ''),
      /missing "upToDate"/,
    ],
    'a dry-run whose upToDate contradicts its list': [
      ok,
      okDry.replace('"upToDate":false', '"upToDate":true'),
      /upToDate=true contradicts 1 pending/,
    ],
    'a dry-run entry that is not a migration file': [
      ok,
      okDry.replace('20260927000000_some_change.sql', 'README.md'),
      /"README.md" is not a migration file name/,
    ],
  };
  it('names the out-of-order file even when the CLI dry run itself refused (real shape)', () => {
    // Captured from CLI 2.118.0: exit 1, and a suggestion to use --include-all.
    const refused =
      '{"_tag":"Error","error":{"code":"DbPushMissingRemoteError","message":"Found local ' +
      'migration files to be inserted before the last migration on remote database."}}';
    expect(() =>
      evaluate({
        listText: listJson({ pending: ['20260921000000'] }),
        dryRunText: refused,
        dryRunExit: 1,
      })
    ).toThrow(/out-of-order migration\(s\) 20260921000000.*Rename each/);
  });

  it('fails a non-zero dry-run exit even when its output looks well formed', () => {
    expect(() => evaluate({ listText: ok, dryRunText: okDry, dryRunExit: '1' })).toThrow(
      /exited 1/
    );
  });

  it('fails a missing dry-run exit status rather than reading it as success', () => {
    expect(() => evaluate({ listText: ok, dryRunText: okDry, dryRunExit: '' })).toThrow(
      /is not a number/
    );
  });

  for (const [name, [listText, dryRunText, message]] of Object.entries(cases)) {
    it(`fails on ${name}, for that reason`, () => {
      expect(() => evaluate({ listText, dryRunText })).toThrow(GuardError);
      expect(() => evaluate({ listText, dryRunText })).toThrow(message);
    });
  }
});

describe('migration guard: limit parsing and post-push verification', () => {
  it('defaults the limit and rejects nonsense', () => {
    expect(parseMax(undefined)).toBe(5);
    expect(parseMax('')).toBe(5);
    expect(parseMax('8')).toBe(8);
    expect(() => parseMax('0')).toThrow(GuardError);
    expect(() => parseMax('five')).toThrow(GuardError);
  });

  it('verifies a fully applied ledger, and fails one with anything pending', () => {
    expect(verifyApplied(listJson())).toEqual({ applied: 3 });
    expect(() => verifyApplied(listJson({ pending: ['20260927000000'] }))).toThrow(
      /still pending after the push: 20260927000000/
    );
    expect(() => verifyApplied('not json')).toThrow(GuardError);
  });
});
