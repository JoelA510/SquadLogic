/**
 * `timezone('utc', now())` stays out of new migrations (plan
 * docs/changes/2026-10-20-utc-now-idiom.md; migration 20261021040000).
 *
 * The idiom is a `timestamp` without a zone: the UTC wall clock. Written into a
 * `timestamptz` it is read in the session's TimeZone, so a caller that sets
 * its zone shifts what is stored. 20261021040000 pinned every function using
 * it and changed every default to `now()`; this guard keeps a later migration
 * from bringing it back. It matches the spellings, not one literal: any case,
 * any spacing, with or without `::text`, and `now() AT TIME ZONE 'utc'`. The
 * deliberate UTC calendar date, the same expression cast `::date`, is allowed,
 * and SQL comments are not read.
 *
 * The migration harness's smoke for 20261021040000 checks the catalogue the
 * same way (a pinned function, no default), so a body that reaches the
 * database by another route is caught there.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(REPO, 'supabase/migrations');
const CUTOFF = '20261021040000';

const IDIOM =
  /(timezone\s*\(\s*'utc'(?:\s*::\s*text)?\s*,\s*now\s*\(\s*\)\s*\)|now\s*\(\s*\)\s+at\s+time\s+zone\s+'utc')(?!\)?\s*::\s*date)/gi;

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

/** @param {string} sql */
const timestampUses = (sql) => [...stripComments(sql).matchAll(IDIOM)].map((m) => m[0]);

const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const versionOf = (name) => name.slice(0, 14);

describe('utc now idiom :: no migration after the pin uses it as a timestamp', () => {
  it('reads the migrations, the cutoff among them, and finds the idiom where it is', () => {
    expect(
      files.some((name) => versionOf(name) === CUTOFF),
      'the cutoff migration is missing'
    ).toBe(true);
    // The detector on real files: the definitive schema uses it in defaults.
    const before = files.filter((name) => versionOf(name) < CUTOFF);
    const hits = before.filter(
      (name) => timestampUses(readFileSync(path.join(MIGRATIONS, name), 'utf8')).length > 0
    );
    expect(hits.length, 'the detector found the idiom in no earlier migration').toBeGreaterThan(10);
  });

  it('finds no timestamp use in any migration after the cutoff', () => {
    const offenders = files
      .filter((name) => versionOf(name) > CUTOFF)
      .map((name) => ({
        name,
        uses: timestampUses(readFileSync(path.join(MIGRATIONS, name), 'utf8')),
      }))
      .filter(({ uses }) => uses.length > 0);
    expect(offenders).toEqual([]);
  });

  it('POSITIVE CONTROL: catches each spelling, and leaves the date form and comments alone', () => {
    expect(timestampUses("updated_at = timezone('utc', now())")).toHaveLength(1);
    expect(timestampUses("DEFAULT timezone('utc'::text, now())")).toHaveLength(1);
    expect(timestampUses("v := TIMEZONE( 'UTC' , NOW( ) );")).toHaveLength(1);
    expect(timestampUses("v := now() AT TIME ZONE 'utc';")).toHaveLength(1);
    expect(timestampUses("v_today := timezone('utc', now())::date;")).toHaveLength(0);
    expect(timestampUses("v_today := (now() AT TIME ZONE 'UTC')::date;")).toHaveLength(0);
    expect(timestampUses("-- not timezone('utc', now()) here\nSELECT 1;")).toHaveLength(0);
    expect(timestampUses("/* timezone('utc', now()) */ SELECT 1;")).toHaveLength(0);
  });
});
