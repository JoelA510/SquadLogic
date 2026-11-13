/**
 * F11-4a task A3 (docs/changes/2026-11-13-settings-scope.md; lesson 77: a twin is held to the original over one input
 * that reaches every outcome). The database's resolver, `scoped_setting_value`, is the source of truth; the core twin
 * `resolveScopedSetting` must give the same answer for every row of the case table in
 * `supabase/tests/scoped_settings.sql` (the eight set/unset combinations of the three levels under two value
 * patterns). The rows are read OUT OF the pgTAP file, so neither side chooses its own cases.
 *
 * And the registry: `SCOPED_SETTING_KEYS` equals `public.scoped_setting_keys` as the migrations leave it, every
 * statement that touches the table applied in migration order, and any statement on it the reader cannot read failing
 * the test (lesson 108: all the migrations, not one named file, so a later key is checked the day it lands).
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

/**
 * Splits SQL into top-level statements, the way PostgreSQL reads them: quoted strings, comments and dollar-quoted bodies
 * are not split on. Each statement comes back with its strings blanked (`text`, for finding a table name that is not
 * inside a literal), as written (`raw`, for reading values) and with its dollar-quoted bodies set aside (`bodies`).
 * @param {string} sql
 */
function statements(sql) {
  const out = [];
  let raw = '';
  let text = '';
  let bodies = [];
  let i = 0;
  const flush = () => {
    if (raw.trim()) out.push({ raw: raw.trim(), text, bodies });
    raw = '';
    text = '';
    bodies = [];
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('an unterminated block comment');
      i = end + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      if (j >= sql.length) throw new Error('an unterminated string');
      raw += sql.slice(i, j + 1);
      text += "''";
      i = j + 1;
      continue;
    }
    const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
    if (ch === '$' && tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      if (end < 0) throw new Error(`an unterminated ${tag[0]} body`);
      bodies.push(sql.slice(i + tag[0].length, end));
      raw += '$BODY$';
      text += '$BODY$';
      i = end + tag[0].length;
      continue;
    }
    if (ch === ';') {
      flush();
      i += 1;
      continue;
    }
    raw += ch;
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

/** A value literal: NULL, or a quoted string with an optional cast. */
function valueLiteral(textIn) {
  const trimmed = textIn.trim().replace(/::\s*\w+\s*$/, '');
  return literal(trimmed);
}

/** The groups of a VALUES list: `( ... ), ( ... )`, honouring quotes. */
function tuples(valuesText) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of valuesText) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') {
      depth += 1;
      if (depth === 1) {
        current = '';
        continue;
      }
    }
    if (!quoted && ch === ')') {
      depth -= 1;
      if (depth === 0) {
        out.push(current);
        continue;
      }
    }
    if (depth >= 1) current += ch;
    else if (!/[\s,]/.test(ch)) throw new Error(`not a VALUES list: ${valuesText.trim()}`);
  }
  if (depth !== 0 || quoted) throw new Error(`not a VALUES list: ${valuesText.trim()}`);
  return out;
}

const COLUMNS = {
  key: 'key',
  value_type: 'type',
  allowed_values: 'allowed',
  default_value: 'defaultValue',
  label: 'label',
};
const IGNORED_DDL =
  /^\s*(?:CREATE\s+TABLE\s+(?:public\.)?scoped_settings?(?:_keys)?\b|COMMENT\s+ON\s+(?:TABLE|COLUMN)\s+(?:public\.)?scoped_setting_keys\b|ALTER\s+TABLE\s+(?:public\.)?scoped_setting_keys\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\s*$|CREATE\s+POLICY\s+"[^"]*"\s+ON\s+(?:public\.)?scoped_setting_keys\b|(?:REVOKE|GRANT)\s+[\w\s,]+\s+ON\s+(?:TABLE\s+)?(?:public\.)?scoped_setting_keys\b|DROP\s+TABLE\s+(?:public\.)?scoped_setting_keys\s*$)/i;
const WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:public\.)?scoped_setting_keys\b/i;
const MENTION = /\bscoped_setting_keys\b/i;

/**
 * The registry as the migrations leave it: every statement that touches `public.scoped_setting_keys`, applied in
 * migration order. An INSERT (any column order, `ON CONFLICT ... DO NOTHING` allowed), an UPDATE ... SET ... WHERE key =
 * '...', and a DELETE ... WHERE key = '...' are read; the table's own DDL is skipped; ANY OTHER statement that names
 * the table, or a write to it inside a function or DO body, fails the reader (a statement it cannot read is not a
 * statement it may skip).
 * @param {Array<{ name: string, sql: string }>} files
 */
function registryFromMigrations(files) {
  const registry = new Map();
  for (const { name, sql } of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    for (const st of statements(sql)) {
      for (const body of st.bodies) {
        if (WRITE.test(body))
          throw new Error(
            `${name}: a write to scoped_setting_keys inside a function or DO body cannot be read`
          );
      }
      if (!MENTION.test(st.text)) continue;
      const insert =
        /^\s*INSERT\s+INTO\s+(?:public\.)?scoped_setting_keys\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*?)(?:\s+ON\s+CONFLICT\s*(?:\([^)]*\))?\s+DO\s+(NOTHING|UPDATE[\s\S]*))?\s*$/i.exec(
          st.raw
        );
      const update =
        /^\s*UPDATE\s+(?:public\.)?scoped_setting_keys\s+SET\s+([\s\S]+?)\s+WHERE\s+key\s*=\s*('(?:[^']|'')*')\s*$/i.exec(
          st.raw
        );
      const del =
        /^\s*DELETE\s+FROM\s+(?:public\.)?scoped_setting_keys\s+WHERE\s+key\s*=\s*('(?:[^']|'')*')\s*$/i.exec(
          st.raw
        );
      if (insert) {
        if (insert[3] && !/^NOTHING$/i.test(insert[3]))
          throw new Error(`${name}: ON CONFLICT DO UPDATE cannot be read`);
        const columns = insert[1].split(',').map((c) => c.trim().toLowerCase());
        for (const c of columns) {
          if (!(c in COLUMNS)) throw new Error(`${name}: unknown column ${c}`);
        }
        for (const tuple of tuples(insert[2])) {
          const values = fields(tuple).map(valueLiteral);
          if (values.length !== columns.length)
            throw new Error(
              `${name}: a row of ${values.length} values for ${columns.length} columns`
            );
          const row = Object.fromEntries(columns.map((c, k) => [COLUMNS[c], values[k]]));
          if (registry.has(row.key)) {
            if (insert[3]) continue;
            throw new Error(`${name}: key ${row.key} inserted twice`);
          }
          registry.set(row.key, row);
        }
      } else if (update) {
        const key = literal(update[2]);
        const row = registry.get(key);
        if (!row)
          throw new Error(`${name}: an UPDATE of key ${key}, which no earlier migration inserted`);
        for (const assignment of fields(update[1])) {
          const m = /^\s*(\w+)\s*=\s*([\s\S]+)$/.exec(assignment);
          if (!m || !(m[1].toLowerCase() in COLUMNS) || m[1].toLowerCase() === 'key') {
            throw new Error(
              `${name}: an UPDATE assignment that cannot be read: ${assignment.trim()}`
            );
          }
          row[COLUMNS[m[1].toLowerCase()]] = valueLiteral(m[2]);
        }
      } else if (del) {
        const key = literal(del[1]);
        if (!registry.delete(key))
          throw new Error(`${name}: a DELETE of key ${key}, which is not there`);
      } else if (!IGNORED_DDL.test(st.text)) {
        throw new Error(
          `${name}: a statement on scoped_setting_keys this reader cannot read: ${st.raw.slice(0, 120)}`
        );
      }
    }
  }
  return Object.fromEntries(
    [...registry].map(([key, row]) => [
      key,
      {
        type: row.type,
        allowed: json(row.allowed),
        defaultValue: json(row.defaultValue),
        label: row.label,
      },
    ])
  );
}

const MIGRATIONS = readdirSync(path.join(ROOT, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((name) => ({
    name,
    sql: readFileSync(path.join(ROOT, 'supabase/migrations', name), 'utf8'),
  }));

describe('scoped settings :: the core registry equals the migrations’ registry', () => {
  it('has the same keys, types, allowed values, defaults and labels', () => {
    const fromSql = registryFromMigrations(MIGRATIONS);
    expect(Object.keys(fromSql).length).toBeGreaterThan(0);
    const fromCore = Object.fromEntries(
      Object.entries(SCOPED_SETTING_KEYS).map(([key, entry]) => [key, { ...entry }])
    );
    expect(fromCore).toEqual(fromSql);
  });

  it('PLANT: a scratch migration inserting a key in another column order is read', () => {
    const scratch = {
      name: '99990101000000_scratch.sql',
      sql: `-- a later key, columns reordered
INSERT INTO public.scoped_setting_keys (label, key, default_value, value_type, allowed_values)
VALUES ('Paired practice days', 'practice_pairs', '[]'::jsonb, 'text_set', '["mon-wed", "tue-thu"]'::jsonb)
ON CONFLICT (key) DO NOTHING;`,
    };
    const read = registryFromMigrations([...MIGRATIONS, scratch]);
    expect(read.practice_pairs).toEqual({
      type: 'text_set',
      allowed: ['mon-wed', 'tue-thu'],
      defaultValue: [],
      label: 'Paired practice days',
    });
    // So the core mirror, which does not have it, would be held unequal: the test above would fail.
    expect(Object.keys(read)).not.toEqual(Object.keys(SCOPED_SETTING_KEYS));
  });

  it('PLANT: an UPDATE and a DELETE in later migrations are applied in order', () => {
    const read = registryFromMigrations([
      ...MIGRATIONS,
      {
        name: '99990101000001_scratch.sql',
        sql: "UPDATE public.scoped_setting_keys SET label = 'Count outside results', default_value = 'true' WHERE key = 'standings_count_outside_results';",
      },
    ]);
    expect(read.standings_count_outside_results).toMatchObject({
      label: 'Count outside results',
      defaultValue: true,
    });
    const gone = registryFromMigrations([
      ...MIGRATIONS,
      {
        name: '99990101000002_scratch.sql',
        sql: "DELETE FROM public.scoped_setting_keys WHERE key = 'standings_count_outside_results';",
      },
    ]);
    expect(gone).toEqual({});
  });

  it('PLANT: a statement it cannot read fails the reader instead of being skipped', () => {
    for (const sql of [
      "INSERT INTO public.scoped_setting_keys SELECT 'x', 'boolean', NULL, 'false', 'X';",
      'UPDATE public.scoped_setting_keys SET label = lower(label);',
      "DO $$ BEGIN INSERT INTO public.scoped_setting_keys (key, value_type, default_value, label) VALUES ('y', 'boolean', 'false', 'Y'); END $$;",
      'ALTER TABLE public.scoped_setting_keys ADD COLUMN extra text;',
    ]) {
      expect(() =>
        registryFromMigrations([...MIGRATIONS, { name: '99990101000003_scratch.sql', sql }])
      ).toThrow();
    }
  });
});
