/**
 * F11-4a task A3 (docs/changes/2026-11-13-settings-scope.md; lesson 77: a twin is held to the original over one input
 * that reaches every outcome). The database's resolver, `scoped_setting_value`, is the source of truth; the core twin
 * `resolveScopedSetting` must give the same answer for every row of the case table in
 * `supabase/tests/scoped_settings.sql` (the eight set/unset combinations of the three levels under two value
 * patterns). The rows are read OUT OF the pgTAP file, so neither side chooses its own cases.
 *
 * And the registry: `SCOPED_SETTING_KEYS` equals the union of every `INSERT INTO public.scoped_setting_keys` across
 * `supabase/migrations/` (lesson 108: the union of the migrations, not one named file, so a later key is checked the
 * day it lands).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCOPED_SETTING_KEYS, resolveScopedSetting } from '../packages/core/src/scopedSettings.js';

const ROOT = process.cwd();
const PGTAP = readFileSync(path.join(ROOT, 'supabase/tests/scoped_settings.sql'), 'utf8');

/** A SQL literal of the case table: NULL, or a quoted string. */
function literal(text) {
  const trimmed = text.trim();
  if (trimmed === 'NULL') return null;
  const match = /^'((?:[^']|'')*)'$/.exec(trimmed);
  if (!match) throw new Error(`not a literal: ${trimmed}`);
  return match[1].replace(/''/g, "'");
}

/** Splits a tuple's inside on commas outside quotes. */
function fields(inside) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const ch of inside) {
    if (ch === "'") quoted = !quoted;
    if (ch === ',' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** The case rows between the file's markers: (n, label, organization, program, division, expected). */
function precedenceCases(sql) {
  const begin = sql.indexOf('-- precedence-cases:begin');
  const end = sql.indexOf('-- precedence-cases:end');
  if (begin < 0 || end < begin) throw new Error('the case table markers are missing');
  const rows = [];
  for (const line of sql.slice(begin, end).split('\n')) {
    if (line.startsWith('--') || line.trim() === '') continue;
    // Every other line is one assertion: SELECT is(pg_temp.resolve(o, p, d), 'e', 'precedence n: label');
    const match =
      /^SELECT is\(pg_temp\.resolve\(([^)]*)\), (.*), 'precedence (\d+): ([^']*)'\);$/.exec(line);
    if (!match) throw new Error(`not a case line: ${line}`);
    const [o, p, d] = fields(match[1]).map(literal);
    rows.push({ n: Number(match[3]), label: match[4], o, p, d, e: literal(match[2]) });
  }
  return rows;
}

const json = (text) => (text === null ? null : JSON.parse(text));

describe('scoped settings :: the core twin gives the database resolver’s answer for every case', () => {
  const cases = precedenceCases(PGTAP);

  it('reads the whole case table: 16 rows, the 8 combinations of 3 levels under each of 2 value patterns', () => {
    expect(cases).toHaveLength(16);
    const combinations = new Set(cases.map((c) => [c.o, c.p, c.d].map((v) => v !== null).join('')));
    expect(combinations.size).toBe(8);
    expect(cases.map((c) => c.n)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it('a malformed row is not silently skipped: the reader fails on it (meta-assertion)', () => {
    const broken = PGTAP.replace(
      "SELECT is(pg_temp.resolve(NULL, 'false', NULL), 'false', 'precedence 3: T/F/T: program only');",
      "SELECT is(pg_temp.resolve(NUL, 'false', NULL), 'false', 'precedence 3: T/F/T: program only');"
    );
    expect(broken).not.toBe(PGTAP);
    expect(() => precedenceCases(broken)).toThrow(/not a literal/);
  });

  for (const c of precedenceCases(PGTAP)) {
    it(`case ${c.n}: ${c.label}`, () => {
      const { value } = resolveScopedSetting(
        { organization: json(c.o), program: json(c.p), division: json(c.d) },
        'standings_count_outside_results'
      );
      expect(JSON.stringify(value)).toBe(c.e);
    });
  }
});

/** Every registry row the migrations insert, in order, the later one winning for a key. */
function migrationRegistry(root) {
  const dir = path.join(root, 'supabase/migrations');
  const registry = {};
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const pattern =
      /INSERT INTO public\.scoped_setting_keys \(key, value_type, allowed_values, default_value, label\) VALUES([\s\S]*?);/g;
    for (const match of sql.matchAll(pattern)) {
      for (const tuple of match[1].matchAll(/\(([^()]*)\)/g)) {
        const [key, type, allowed, defaultValue, label] = fields(tuple[1]).map(literal);
        registry[key] = {
          type,
          allowed: json(allowed),
          defaultValue: json(defaultValue),
          label,
        };
      }
    }
  }
  return registry;
}

describe('scoped settings :: the core registry equals the migrations’ registry', () => {
  it('has the same keys, types, allowed values, defaults and labels', () => {
    const fromSql = migrationRegistry(ROOT);
    expect(Object.keys(fromSql).length).toBeGreaterThan(0);
    const fromCore = Object.fromEntries(
      Object.entries(SCOPED_SETTING_KEYS).map(([key, entry]) => [key, { ...entry }])
    );
    expect(fromCore).toEqual(fromSql);
  });
});
