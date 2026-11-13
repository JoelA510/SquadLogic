/**
 * The census of everything that still names the legacy `games` table (F11-3, task C4 of
 * `docs/changes/2026-11-06-games-table-source-of-truth.md`).
 *
 * A saved game is a row of `game_assignments` and its score a row of `game_scores` (F11-1, F11-2). The legacy `games`
 * table is kept, unread by the product, until F11-5 drops it on the owner's word. This file is what "unread" means:
 *
 * - **The subject set is found by scan, never listed by hand**: every product source (`frontend/src`,
 *   `packages/core/src`, `supabase/functions`, outside their tests) that reads the table, the mock client's files that
 *   keep its rows, the LATEST definition of every SQL function and view in `supabase/migrations` that names it, the
 *   policies and triggers the catalogue snapshot of a real build shows on it, and the seeds, pgTAP files, harness
 *   scripts, E2E steps and vitest files that put a row in it or read one.
 * - **Every subject is classified** in {@link REGISTRY}: `reader` (the product reads the table: NOT allowed since
 *   F11-3), `writer` (the product writes it: not allowed either; there is none), `legacy-kept` (an arm that goes with
 *   the table: the four SQL functions, the table's own policies and triggers, the mock's rows behind those arms) and
 *   `test-seed` (a seed or a test of a `legacy-kept` arm). Every allowed entry is removed by F11-5 with the table.
 * - **Both directions fail**: a subject nobody classified, and an entry whose subject no longer names the table.
 * - **A class is checked**: a `reader` or `writer` entry fails the census by being there.
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

/** @typedef {'reader' | 'writer' | 'legacy-kept' | 'test-seed'} GamesClass */
const ALLOWED = new Set(['legacy-kept', 'test-seed']);

/** @type {Record<string, { class: GamesClass, why: string }>} */
const REGISTRY = {
  // --- The live catalogue: functions (latest definition) that name the table.
  'sql:fn:admin_delete_team': {
    class: 'legacy-kept',
    why: "counts and deletes the team's legacy rows in its cascade (reads nothing while the table is empty); F11-5 removes the arm",
  },
  'sql:fn:field_bookings': {
    class: 'legacy-kept',
    why: 'a legacy game books its slot, so a field delete is refused while one stands; F11-5 removes the arm',
  },
  'sql:fn:rollback_field_import_job': {
    class: 'legacy-kept',
    why: 'refuses to roll a field import back under a legacy game; F11-5 removes the arm',
  },
  'sql:fn:copy_legacy_game_scores': {
    class: 'legacy-kept',
    why: "F11-2's copy-or-refuse of legacy scores, kept internal so it can be tested; F11-5 drops it with the table",
  },
  // --- The table's own policies and triggers (from the catalogue snapshot).
  'sql:policy:games_select_member': { class: 'legacy-kept', why: "the table's own RLS" },
  'sql:policy:games_insert_admin': { class: 'legacy-kept', why: "the table's own RLS" },
  'sql:policy:games_update_admin': { class: 'legacy-kept', why: "the table's own RLS" },
  'sql:policy:games_delete_admin': { class: 'legacy-kept', why: "the table's own RLS" },
  'sql:trigger:games_readonly_when_completed': {
    class: 'legacy-kept',
    why: "the table's own completed-season trigger",
  },
  'sql:trigger:games_set_timestamp': { class: 'legacy-kept', why: "the table's own timestamp" },
  // --- The mock client: the rows behind the legacy-kept SQL arms.
  'frontend/src/lib/mockSupabaseClient.js': {
    class: 'legacy-kept',
    why: 'mirrors the kept SQL arms (the field delete guard, the field import rollback, the team delete cascade, the completed-season refusal); it seeds no legacy row and scores none',
  },
  'frontend/src/lib/mockSeasons.js': {
    class: 'legacy-kept',
    why: "mirrors the table's completed-season trigger (games_readonly_when_completed)",
  },
  // --- Seeds, pgTAP, the harness, E2E and the vitest files that read the table.
  'supabase/seed.sql': { class: 'test-seed', why: 'the local seed inserts legacy rows' },
  'tests/e2e/real-backend/seed.sql': {
    class: 'test-seed',
    why: 'one legacy game on a slot, so the real-backend field delete is refused by the kept arm',
  },
  'scripts/dbharness/scenarios.py': {
    class: 'test-seed',
    why: 'harness scenarios seed legacy rows for the kept arms and the legacy score copy',
  },
  'scripts/dbharness/run.sh': {
    class: 'test-seed',
    why: 'harness probes of the kept arms and the legacy score copy',
  },
  'supabase/tests/admin_delete_team_exceptions.sql': {
    class: 'test-seed',
    why: 'pgTAP of the team delete cascade over a legacy row',
  },
  'supabase/tests/facility_permits.sql': {
    class: 'test-seed',
    why: 'pgTAP seeds a legacy game',
  },
  'supabase/tests/field_delete_booking_guard.sql': {
    class: 'test-seed',
    why: 'pgTAP of field_bookings over a legacy game',
  },
  'supabase/tests/game_scores.sql': {
    class: 'test-seed',
    why: 'pgTAP of the legacy score copy (matches, refuses, does nothing on an empty table)',
  },
  'supabase/tests/rls_policy_matrix.sql': {
    class: 'test-seed',
    why: "pgTAP of the table's own policies",
  },
  'supabase/tests/rsvp_and_team_chat_removed.sql': {
    class: 'test-seed',
    why: 'pgTAP seeds a legacy game',
  },
  'supabase/tests/season_schedule_readonly.sql': {
    class: 'test-seed',
    why: "pgTAP of the table's completed-season trigger",
  },
  'supabase/tests/storage_facility_permits_bucket.sql': {
    class: 'test-seed',
    why: 'pgTAP seeds a legacy game',
  },
  'tests/fieldDeleteGuard.test.js': {
    class: 'test-seed',
    why: "vitest of the mock's field delete guard over a legacy game",
  },
  'tests/fieldLifecycleRpcs.test.js': {
    class: 'test-seed',
    why: "vitest of the mock's field delete cascade over a legacy game",
  },
};

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
    /\b(?:getMockData|owned|destroy|reported|cascadeDoomed)\(\s*['"`]games['"`]|,\s*['"`]games['"`]\s*,|table === ['"`]games['"`]|\bgame:\s*['"`]games['"`]/,
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
const rel = (file) => path.relative(REPO, file);
const isJs = (file) => JS_EXTENSIONS.has(path.extname(file));
const IS_TEST = /\/(_?tests?|__tests__)\/|_test\.ts$|\.test\.[jt]sx?$/;
const IS_MOCK = /frontend\/src\/lib\/mock\w*\.js$/;

/** Every subject, by scan. @returns {Map<string, string>} key -> what it was found as */
function scan() {
  /** @type {Map<string, string>} */
  const found = new Map();
  // 1. Product sources, and the mock client's files.
  for (const root of ['frontend/src', 'packages/core/src', 'supabase/functions']) {
    for (const file of walk(path.join(REPO, root), isJs)) {
      const key = rel(file);
      if (IS_TEST.test(key)) continue;
      const kinds = gamesReads(
        readFileSync(file, 'utf8'),
        IS_MOCK.test(key) ? MOCK_READS : JS_READS
      );
      if (kinds.length > 0) found.set(key, kinds.join(','));
    }
  }
  // 2. The live catalogue.
  const migrations = path.join(REPO, 'supabase/migrations');
  const files = readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(migrations, name), 'utf8') }));
  for (const [key, file] of sqlGamesReaders(files)) found.set(key, file);
  const snapshot = JSON.parse(
    readFileSync(path.join(REPO, 'supabase/catalog-snapshot.json'), 'utf8')
  );
  for (const key of catalogueGamesObjects(snapshot)) found.set(key, 'catalog-snapshot.json');
  // 3. Seeds, pgTAP, the harness and E2E: SQL that names the table, or a step that seeds its rows.
  const sqlish = [
    path.join(REPO, 'supabase/seed.sql'),
    ...walk(path.join(REPO, 'supabase/tests'), (f) => f.endsWith('.sql')),
    ...walk(path.join(REPO, 'scripts'), (f) => /\.(sql|py|sh|mjs|js)$/.test(f)),
    ...walk(path.join(REPO, 'tests/e2e'), (f) => f.endsWith('.sql')),
  ];
  for (const file of sqlish) {
    if (SQL_READ.test(stripSqlComments(readFileSync(file, 'utf8')))) found.set(rel(file), 'sql');
  }
  for (const file of walk(path.join(REPO, 'tests'), isJs)) {
    const key = rel(file);
    if (key === 'tests/gamesTableReaders.test.js') continue;
    const patterns = key.startsWith('tests/e2e/')
      ? { from: JS_READS.from, rows: MOCK_READS.rows }
      : { from: JS_READS.from };
    const kinds = gamesReads(readFileSync(file, 'utf8'), patterns);
    if (kinds.length > 0) found.set(key, kinds.join(','));
  }
  return found;
}

/**
 * @param {Map<string, string>} found
 * @param {Record<string, { class: string, why: string }>} registry
 */
export function judge(found, registry) {
  return {
    unclassified: [...found.keys()].filter((key) => !(key in registry)).sort(),
    stale: Object.keys(registry)
      .filter((key) => !found.has(key))
      .sort(),
    notAllowed: Object.entries(registry)
      .filter(([, entry]) => !ALLOWED.has(entry.class))
      .map(([key, entry]) => `${key}: classed ${entry.class}, which F11-3 does not allow`)
      .sort(),
  };
}

describe('everything that names the legacy `games` table is classified, from the code', () => {
  const found = scan();

  it('finds the subjects (a census that examined nothing is a failure)', () => {
    const keys = [...found.keys()];
    expect(keys.filter((k) => k.startsWith('sql:fn:')).length).toBeGreaterThanOrEqual(4);
    expect(keys.filter((k) => k.startsWith('sql:policy:')).length).toBeGreaterThanOrEqual(1);
    expect(keys.filter((k) => k.startsWith('supabase/tests/')).length).toBeGreaterThanOrEqual(5);
    expect(keys).toContain('frontend/src/lib/mockSupabaseClient.js');
  });

  it('has no unclassified subject, no stale entry, and no reader or writer left', () => {
    expect(judge(found, REGISTRY)).toEqual({ unclassified: [], stale: [], notAllowed: [] });
  });

  it('no product source reads the table (the readers are on game_assignments and game_scores)', () => {
    const product = [...found.keys()].filter(
      (key) =>
        /^(frontend\/src|packages\/core\/src|supabase\/functions)\//.test(key) && !IS_MOCK.test(key)
    );
    expect(product).toEqual([]);
  });

  it('every entry says why', () => {
    for (const [key, entry] of Object.entries(REGISTRY)) {
      expect(entry.why.length, key).toBeGreaterThan(15);
    }
  });

  it('PLANT: a subject taken out of the registry is reported, and a reader entry is refused', () => {
    const { 'sql:fn:field_bookings': dropped, ...rest } = REGISTRY;
    expect(dropped.class).toBe('legacy-kept');
    expect(judge(found, rest).unclassified).toEqual(['sql:fn:field_bookings']);
    expect(
      judge(found, { ...REGISTRY, 'sql:fn:field_bookings': { class: 'reader', why: 'planted' } })
        .notAllowed
    ).toEqual(['sql:fn:field_bookings: classed reader, which F11-3 does not allow']);
    expect(judge(found, { ...REGISTRY, 'frontend/src/pages/Gone.jsx': dropped }).stale).toEqual([
      'frontend/src/pages/Gone.jsx',
    ]);
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
  });

  it('does not find a comment, a longer name, another table or the import type', () => {
    expect(gamesReads("// supabase.from('games')\nsupabase.from('game_assignments')")).toEqual([]);
    expect(gamesReads("select('plays_games, saved_games(id)')")).toEqual([]);
    expect(gamesReads("supabase.from('game_scores')")).toEqual([]);
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
