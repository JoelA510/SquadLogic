/**
 * The core `day_of_week` lists, pinned to their outside definitions (task #69).
 *
 * - The Postgres enum, read from the migrations that create it -- not from
 *   core, so a drifted core list cannot vouch for itself.
 * - The Edge twin `DAY_MAP` (`_shared/calendar/icsFeed.ts`), which stays an
 *   import-free Deno copy.
 * - Every inline weekday literal in `frontend/src` and `packages/core/src`,
 *   which must be exactly one of the two core orders. The mock client's copy
 *   stays a literal on purpose: an import would cost main-entry bytes.
 *
 * Core holds two orders of the same seven values and this file does not pick
 * one: `DAY_OF_WEEK_ENUM` (`utils/practiceOccurrences.js`) is indexed by
 * `getUTCDay()` (sun..sat); `ISO_DAY_NAMES` (`fieldAdmin/consequences.js`) by
 * ISO weekday - 1 (mon..sun). Both are pinned, each in its own order.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DAY_OF_WEEK_ENUM } from '@squadlogic/core/utils/practiceOccurrences.js';
import { ISO_DAY_NAMES } from '@squadlogic/core/fieldAdmin/consequences.js';
import { DAY_MAP } from '../supabase/functions/_shared/calendar/icsFeed.ts';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const CREATE_ENUM = /create\s+type\s+(?:public\.)?day_of_week\s+as\s+enum\s*\(([^)]*)\)/gi;
const ALTER_ENUM = /alter\s+type\s+(?:public\.)?day_of_week\b/i;

/** Source roots whose inline weekday literals must follow a core order. */
const SCAN_ROOTS = ['frontend/src', 'packages/core/src'];
/** The inline copies the census found; the scan must find at least these. */
const KNOWN_INLINE = [
  'frontend/src/lib/mockSupabaseClient.js',
  'frontend/src/pages/FieldManagementPage.jsx',
];
const DAY_CODES = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
/**
 * An array literal of five or more short lowercase strings. Kept when at least
 * four of them are day codes, so a copy with one corrupted value ('fr') is
 * still found and reported, not silently skipped.
 */
const SHORT_WORD_LITERAL = /\[\s*(?:(['"])[a-z]{1,9}\1\s*,\s*){4,}(['"])[a-z]{1,9}\2\s*,?\s*\]/g;

function walk(dir, acc = []) {
  // A missing root yields nothing, so the meta-assertion below is what fails.
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(?:js|jsx|mjs|ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('day_of_week enum: core pinned to the DB and the Edge twin', () => {
  it('DAY_OF_WEEK_ENUM is indexed by getUTCDay()', () => {
    // 2026-11-01 is a Sunday; index i must name the day getUTCDay() calls i.
    for (let i = 0; i < 7; i += 1) {
      const date = new Date(Date.UTC(2026, 10, 1 + i));
      expect(date.getUTCDay()).toBe(i);
      expect(DAY_OF_WEEK_ENUM[i]).toBe(
        date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toLowerCase()
      );
    }
  });

  it('holds exactly the values of every migration that creates the Postgres enum', () => {
    const definitions = [];
    for (const name of readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql'))) {
      const sql = readFileSync(path.join(MIGRATIONS, name), 'utf8');
      // A later ADD VALUE would widen the DB without touching a CREATE TYPE.
      expect(ALTER_ENUM.test(sql), `${name} alters day_of_week`).toBe(false);
      for (const match of sql.matchAll(CREATE_ENUM)) {
        definitions.push({ name, values: [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]) });
      }
    }
    // Meta: the migration that actually creates the type was found and parsed.
    // Both definitions sit behind IF NOT EXISTS; the earliest is the one that runs.
    expect(definitions.map((d) => d.name)).toContain('20251208000000_consolidated_schema.sql');
    for (const { name, values } of definitions) {
      expect(values, name).toHaveLength(7);
      // Postgres declares mon..sun. Neither core list relies on the enum's
      // ordinal, so the pin is on the set.
      expect([...values].sort(), name).toEqual([...DAY_OF_WEEK_ENUM].sort());
      expect([...values].sort(), name).toEqual([...ISO_DAY_NAMES].sort());
    }
  });

  it('matches the Edge twin DAY_MAP key for key and offset for offset', () => {
    expect(Object.keys(DAY_MAP)).toEqual([...DAY_OF_WEEK_ENUM]);
    expect(Object.values(DAY_MAP)).toEqual(DAY_OF_WEEK_ENUM.map((_, index) => index));
    // ISO weekday - 1 -> getUTCDay(): Monday is 1, Sunday is 0.
    expect(ISO_DAY_NAMES.map((day) => DAY_MAP[day])).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it('every inline weekday literal in frontend/src and packages/core/src is one of the two core orders', () => {
    const canonical = [DAY_OF_WEEK_ENUM, ISO_DAY_NAMES].map((list) => list.join(','));
    const found = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(path.join(process.cwd(), root))) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(SHORT_WORD_LITERAL)) {
          const values = [...match[0].matchAll(/['"]([a-z]+)['"]/g)].map((m) => m[1]);
          if (values.filter((value) => DAY_CODES.has(value)).length < 4) continue;
          const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
          const line = source.slice(0, match.index).split('\n').length;
          found.push({ file: rel, where: `${rel}:${line}`, values });
        }
      }
    }
    // Meta: the scan reached the known inline copies, by file.
    expect(found.map((hit) => hit.file)).toEqual(expect.arrayContaining(KNOWN_INLINE));
    const offenders = found
      .filter((hit) => !canonical.includes(hit.values.join(',')))
      .map((hit) => `${hit.where} [${hit.values.join(', ')}]`);
    expect(offenders).toEqual([]);
  });
});
