/**
 * The saved schedule uses game_assignments and game_scores. After F11-5 there are no allowed readers
 * of the retired games table. Scan product sources, the mock, the effective SQL definitions and
 * catalogue, and current seeds and tests. Check that sources from each group were actually read.
 *
 * **Blind spots, declared.** A read through a variable (`.from(TABLE)`) is invisible to the scan. The historical
 * revert and smoke scripts under `docs/sql/` name the table as it was when each was written and are not subjects.
 * A vitest file that builds a mock database with a `games: [...]` key and never reads the table is not a subject
 * (the key is too common a word to scan for); a vitest file that reads the table (`from('games')`) is.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------------------------
// The scanners (pure over sources, so the tests below can run them on constructed text).
// ---------------------------------------------------------------------------------------------------------------

/** @param {string} src */
const stripJsComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
/** @param {string} src */
const stripSqlComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

const JS_READS = {
  from: /\bfrom\(\s*['"`]games['"`]\s*\)/,
  helper:
    /\b(?:countRows|countOf|read|readAll|readAllPages|fetchTable|fetchAll)\(\s*['"`]games['"`]/,
  embed: /(?:[:\s'"`,(]games(?:!\w+)?\(|:\s*games(?:!\w+)?\s+\()/,
};
/** What the mock's files call the table's rows. */
const MOCK_READS = {
  ...JS_READS,
  rows: /\bdb\.games\b/,
  named:
    /\b(?:getMockData|owned|destroy|reported|cascadeDoomed)\(\s*['"`]games['"`]|table === ['"`]games['"`]|\bgame:\s*['"`]games['"`]/,
};
const TEST_READS = {
  from: JS_READS.from,
  rows: MOCK_READS.rows,
  tableHelper: /\b(?:getMockData|setMockData|write)\(\s*['"`]games['"`]/,
};
const SQL_READ = /(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+(?:ONLY\s+)?(?:public\.)?games\b/i;
const SQL_DEFINITION =
  /\b(CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|(?:MATERIALIZED\s+)?VIEW)|DROP\s+(?:FUNCTION|VIEW))\s+(?:IF\s+EXISTS\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)/gi;

/**
 * The kinds of read of `games` a source makes, or none.
 * @param {string} source
 * @param {Record<string, RegExp>} [patterns]
 * @returns {string[]}
 */
export function gamesReads(source, patterns = JS_READS) {
  const src = stripJsComments(source);
  return Object.entries(patterns)
    .filter(([, re]) => re.test(src))
    .map(([kind]) => kind);
}

/**
 * The latest definition of every SQL function and view that names the table, migrations in version order.
 * @param {Array<{ name: string, sql: string }>} files
 * @returns {Map<string, string>} `sql:fn:<name>` or `sql:view:<name>` -> the file of its latest definition
 */
export function sqlGamesReaders(files) {
  /** @type {Map<string, { file: string, text: string }>} */
  const latest = new Map();
  for (const { name: file, sql } of files) {
    const src = stripSqlComments(sql);
    const defs = [...src.matchAll(SQL_DEFINITION)];
    defs.forEach((m, i) => {
      const kind = /VIEW/i.test(m[1]) ? 'view' : 'fn';
      const name = m[2]
        .replace(/"/g, '')
        .replace(/\s+/g, '')
        .toLowerCase()
        .replace(/^public\./, '');
      const key = `sql:${kind}:${name}`;
      if (/^DROP/i.test(m[1])) {
        latest.delete(key);
        return;
      }
      const end = i + 1 < defs.length ? defs[i + 1].index : src.length;
      latest.set(key, { file, text: src.slice(m.index, end) });
    });
  }
  return new Map(
    [...latest].filter(([, def]) => SQL_READ.test(def.text)).map(([key, def]) => [key, def.file])
  );
}

/**
 * The policies and triggers ON the table, from the catalogue snapshot of a real build.
 * @param {{ policies: string[], triggers: string[] }} snapshot
 * @returns {string[]}
 */
export function catalogueGamesObjects(snapshot) {
  return [
    ...snapshot.policies
      .filter((line) => line.split('|')[0] === 'games')
      .map((line) => `sql:policy:${line.split('|')[1]}`),
    ...snapshot.triggers
      .filter((line) => /\bON public\.games\b/.test(line))
      .map((line) => `sql:trigger:${/CREATE TRIGGER (\w+)/.exec(line)?.[1]}`),
  ];
}

const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
/** @param {string} dir @param {(file: string) => boolean} keep @param {string[]} [out] */
function walk(dir, keep, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && !entry.startsWith('.')) walk(full, keep, out);
    } else if (keep(full)) out.push(full);
  }
  return out;
}
const rel = (file) => path.relative(REPO, file).split(path.sep).join('/');
const isJs = (file) => JS_EXTENSIONS.has(path.extname(file));
const IS_TEST = /\/(_?tests?|__tests__)\/|_test\.ts$|\.test\.[jt]sx?$/;
const IS_MOCK = /frontend\/src\/lib\/mock\w*\.js$/;

/** Read the source manifest even when there are no findings. */
function scan() {
  /** @type {Map<string, string>} */
  const found = new Map();
  const examined = new Set();
  function read(file) {
    const content = readFileSync(file, 'utf8');
    examined.add(rel(file));
    return content;
  }
  // 1. Product sources, and the mock client's files.
  for (const root of ['frontend/src', 'packages/core/src', 'supabase/functions']) {
    for (const file of walk(path.join(REPO, root), isJs)) {
      const key = rel(file);
      if (IS_TEST.test(key)) continue;
      const kinds = gamesReads(read(file), IS_MOCK.test(key) ? MOCK_READS : JS_READS);
      if (kinds.length > 0) found.set(key, kinds.join(','));
    }
  }
  // 2. The live catalogue.
  const migrations = path.join(REPO, 'supabase/migrations');
  const files = readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: read(path.join(migrations, name)) }));
  for (const [key, file] of sqlGamesReaders(files)) found.set(key, file);
  const snapshot = JSON.parse(read(path.join(REPO, 'supabase/catalog-snapshot.json')));
  for (const key of catalogueGamesObjects(snapshot)) found.set(key, 'catalog-snapshot.json');
  // 3. Seeds, pgTAP, the harness and E2E: SQL that names the table, or a step that seeds its rows.
  const sqlish = [
    path.join(REPO, 'supabase/seed.sql'),
    ...walk(path.join(REPO, 'supabase/tests'), (f) => f.endsWith('.sql')),
    ...walk(path.join(REPO, 'scripts'), (f) => /\.(sql|py|sh|mjs|js)$/.test(f)),
    ...walk(path.join(REPO, 'tests/e2e'), (f) => f.endsWith('.sql')),
  ];
  for (const file of sqlish) {
    if (SQL_READ.test(stripSqlComments(read(file)))) found.set(rel(file), 'sql');
  }
  for (const file of walk(path.join(REPO, 'tests'), isJs)) {
    const key = rel(file);
    if (key === 'tests/gamesTableReaders.test.js') continue;
    const kinds = gamesReads(read(file), TEST_READS);
    if (kinds.length > 0) found.set(key, kinds.join(','));
  }
  return { found, examined };
}

describe('the retired games table has no current readers or writers', () => {
  const { found, examined } = scan();

  it('reads independent subjects in every source group, even with an empty result', () => {
    for (const file of [
      'frontend/src/utils/gameImportClient.js',
      'frontend/src/lib/mockSupabaseClient.js',
      'packages/core/src/scheduleImport/parseRows.js',
      'supabase/functions/import-validation/index.ts',
      'supabase/migrations/20261122010000_game_scores.sql',
      'supabase/catalog-snapshot.json',
      'supabase/seed.sql',
      'supabase/tests/field_delete_booking_guard.sql',
      'scripts/dbharness/scenarios.py',
      'tests/e2e/real-backend/seed.sql',
      'tests/fieldDeleteGuard.test.js',
    ])
      expect(examined.has(file), file).toBe(true);
  });

  it('allows no SQL, mock, app, seed or test subject to read the retired table', () => {
    expect([...found.keys()].sort()).toEqual([]);
  });
});

describe('the scanners find each kind of read, and only reads', () => {
  it('finds a read of each JS kind', () => {
    expect(gamesReads("supabase.from('games').select('*')")).toEqual(['from']);
    expect(gamesReads('await read("games", columns)')).toEqual(['helper']);
    expect(gamesReads("select('id, games(id)')")).toEqual(['embed']);
    expect(gamesReads("select('id, legacy:games!game_slot_id (id)')")).toEqual(['embed']);
    expect(gamesReads('const rows = db.games || [];', MOCK_READS)).toEqual(['rows']);
    expect(gamesReads("owned('games').some(Boolean)", MOCK_READS)).toEqual(['named']);
    expect(gamesReads("await write('games', update)", TEST_READS)).toEqual(['tableHelper']);
    expect(gamesReads("getMockData('games')", TEST_READS)).toEqual(['tableHelper']);
  });

  it('does not find a comment, a longer name, another table or the import type', () => {
    expect(gamesReads("// supabase.from('games')\nsupabase.from('game_assignments')")).toEqual([]);
    expect(gamesReads("select('plays_games, saved_games(id)')")).toEqual([]);
    expect(gamesReads("supabase.from('game_scores')")).toEqual([]);
    expect(
      gamesReads("const types = ['registration', 'games', 'practice_schedule'];", MOCK_READS)
    ).toEqual([]);
    expect(gamesReads("if (importType === 'games') apply();", MOCK_READS)).toEqual([]);
  });

  it('finds SQL readers by their latest definition only, and the objects on the table', () => {
    const files = [
      {
        name: '1.sql',
        sql: 'CREATE FUNCTION public.a() RETURNS int AS $$ SELECT 1 FROM public.games $$;\nCREATE VIEW public.v AS SELECT * FROM games;',
      },
      {
        name: '2.sql',
        sql: 'CREATE OR REPLACE FUNCTION public.a() RETURNS int AS $$ SELECT 1 FROM public.game_assignments $$;\n-- FROM public.games\nCREATE FUNCTION public.b() RETURNS int AS $$ DELETE FROM public.games $$;',
      },
    ];
    expect([...sqlGamesReaders(files)]).toEqual([
      ['sql:view:v', '1.sql'],
      ['sql:fn:b', '2.sql'],
    ]);
    expect(
      catalogueGamesObjects({
        policies: ['games|p1|SELECT|x', 'game_assignments|p2|SELECT|x'],
        triggers: [
          'CREATE TRIGGER t1 BEFORE UPDATE ON public.games FOR EACH ROW EXECUTE FUNCTION f()',
          'CREATE TRIGGER t2 BEFORE UPDATE ON public.game_slots FOR EACH ROW EXECUTE FUNCTION f()',
        ],
      })
    ).toEqual(['sql:policy:p1', 'sql:trigger:t1']);
  });
});
