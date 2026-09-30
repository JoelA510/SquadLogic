/**
 * The practice-reader census, made enforceable (8.6 3b PR 12a, plan §1.1, W16).
 *
 * The PR 12 plan counted ten readers that turn stored `practice_assignments`
 * rows into dated practices, and every one of them must apply saved practice
 * exceptions (`utils/practiceExceptions.js`) or say why it does not. A census
 * written in a document goes stale the day a new reader lands, so this file
 * re-takes it from disk on every run, following the `scripts/deno-mirror-tests.sh`
 * EXCLUDED precedent:
 *
 * - **The subject set is enumerated from source**, never from the registry:
 *   every production file (`frontend/src`, `packages/core/src`,
 *   `supabase/functions` outside its Deno tests) that selects from the table
 *   -- `.from('practice_assignments')`, or a `practice_assignments(...)` embed
 *   -- plus the LATEST definition of every SQL function or view in
 *   `supabase/migrations` whose body names the table.
 * - **Every subject is classified** in {@link REGISTRY}: `applies` (it calls
 *   the helper), `pending` (a named PR 12 sub-PR adopts it), `series-only`
 *   (declared: it reads the series and makes no dated practice a family sees
 *   as changed), or `writer`.
 * - **Both directions fail**: an unclassified reader, and a registry entry
 *   whose file or function no longer reads the table.
 * - **`applies` and `pending` are checked, not trusted**: an `applies` file
 *   must import `practiceExceptions`, and a `pending` one must not yet -- so
 *   the sub-PR that adopts it has to move it to `applies`, and a registry
 *   claiming adoption that never happened goes red.
 *
 * **Blind spots, declared.** A reader naming the table through a variable
 * (`.from(TABLE)`) is invisible to this scan, as is a SQL function whose body
 * builds the name dynamically. The mock client
 * (`frontend/src/lib/mockSupabaseClient.js`, plan R7) SERVES the table rather
 * than selecting from it, so it is not a subject here; 12c and 12d adopt it.
 * Overloaded SQL functions are keyed by name, so the last definition of any
 * overload stands for all of them.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const JS_ROOTS = ['frontend/src', 'packages/core/src', 'supabase/functions'];
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const JS_SKIPPED = ['supabase/functions/_shared/tests/'];
const MIGRATIONS = 'supabase/migrations';

/**
 * Every classified reader. Keys are repo-relative files, or `sql:<name>` for
 * the latest definition of a migration function or view.
 *
 * @type {Record<string, { class: 'applies' | 'pending' | 'series-only' | 'writer', pr?: string, why: string }>}
 */
const REGISTRY = {
  // --- JavaScript and TypeScript readers (plan §1.2 / §1.3).
  // R2, adopted in 12c: a second read of `practice_exceptions`, and
  // `expandPractices(rows, exceptions)` runs the helper.
  'frontend/src/hooks/useTeamPortal.js': {
    class: 'applies',
    why: 'R2: the team portal expands rows and saved exceptions into dated practices',
  },
  // R4/R5, adopted in 12b. The feed's reads moved out of `calendar-feed/index.ts`
  // into this seam (the handler injects the client), so this is the file that
  // selects the table; `tests/calendarFeed.test.js` pins that the handler reads
  // only `teams` itself and hands over to `composeTeamFeed`.
  'supabase/functions/_shared/calendar/teamFeed.ts': {
    class: 'applies',
    why: 'R4/R5: the calendar feed reads rows and exceptions; buildFeedEvents runs the twin',
  },
  'frontend/src/hooks/usePracticeAssignments.js': {
    class: 'series-only',
    why: 'R9: exports (CSV, coach email drafts) stay series-level (Q6, D4)',
  },
  'frontend/src/pages/PlayerRecordPage.jsx': {
    class: 'series-only',
    why: 'R10: the player record lists weekday and time only (Q6, D4)',
  },
  'frontend/src/components/preferences/AdminPreferenceReview.jsx': {
    class: 'series-only',
    why: 'X7: judges a placement in force on a date, makes no dates',
  },
  'frontend/src/hooks/usePracticeLightingOverrides.js': {
    class: 'series-only',
    why: 'X8: slot membership for lighting overrides, not dates',
  },
  'packages/core/src/practiceSupabase.js': {
    class: 'series-only',
    why: "X1: the lock's and the writer's series cross-check; makes no dates",
  },
  'supabase/functions/_shared/engines/practice-lock.ts': {
    class: 'series-only',
    why: 'X2: auto-scheduler lock load; already reads live time_tbd exceptions',
  },

  // --- SQL: the latest definition of each function or view (plan §1.1 G6).
  // R6, adopted in 12d (20261005000000): the RSVP validator reads the live
  // exceptions on the assignment and mirrors the helper's rules in SQL.
  'sql:upsert_team_event_rsvp': {
    class: 'applies',
    why: 'R6: the RSVP validator accepts a date only as the applied practice calendar shows it',
  },
  'sql:field_bookings': {
    class: 'series-only',
    why: "X13: a booking is judged per row by its last day; relocated targets are 11d's gap (D5)",
  },
  'sql:view_facility_usage': {
    class: 'series-only',
    why: 'X11: counts rows per slot and field, makes no dates',
  },
  'sql:practice_schedule_fingerprint': {
    class: 'series-only',
    why: 'X9: a hash of the schedule; it already covers exception ids and withdrawn_at',
  },
  'sql:caller_coaches_practice_slot': {
    class: 'series-only',
    why: 'Found by this census, not in the plan: slot membership for lighting overrides (as X8)',
  },
  'sql:rollback_field_import_job': {
    class: 'series-only',
    why: 'X12: an existence check before a field-import rollback',
  },
  'sql:persist_practice_schedule': { class: 'writer', why: 'X10: the practice writer (v3)' },
  'sql:enact_practice_recommendation': { class: 'writer', why: 'X10: the repair enact wrapper' },
  'sql:admin_cancel_practice_assignment': {
    class: 'writer',
    why: 'X10: closes an assignment on an admin cancel',
  },
};

// ------------------------------------------------------------- the scanners

const toPosix = (p) => p.split(path.sep).join('/');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * SQL comments are stripped: migrations narrate the table in `--` lines, and
 * a commented-out `DROP FUNCTION` must not delete a live definition. JS is
 * scanned **unstripped**: a regex cannot tell a `/*` inside a string (a glob,
 * say) from a comment, and stripping one would hide real code. A commented
 * mention is therefore counted as a reader -- a false positive the registry
 * must answer, which fails loud, rather than a false negative, which would not.
 */
const stripSqlComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');

/** The JS patterns: a select from the table, or an embed of it. */
const JS_READS = [
  /\.from\(\s*(['"`])practice_assignments\1\s*\)/,
  /\bpractice_assignments\s*(?:!\s*\w+\s*)?\(/,
];

/** @param {string} src */
const jsReadsTable = (src) => JS_READS.some((re) => re.test(src));

/** An import statement of either arm of the helper. */
const IMPORTS_HELPER = /\bfrom\s+(['"])[^'"]*\/practiceExceptions(?:\.js|\.ts)?\1/;

function jsSubjects() {
  const files = JS_ROOTS.flatMap((root) => walk(path.join(REPO, root)))
    .map((f) => toPosix(path.relative(REPO, f)))
    .filter((f) => JS_EXTENSIONS.has(path.extname(f)))
    .filter((f) => !JS_SKIPPED.some((skip) => f.startsWith(skip)));
  return {
    scanned: files.length,
    readers: files.filter((f) => jsReadsTable(readFileSync(path.join(REPO, f), 'utf8'))).sort(),
  };
}

const DEFINITION =
  /\b(CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|(?:MATERIALIZED\s+)?VIEW)|DROP\s+(?:FUNCTION|(?:MATERIALIZED\s+)?VIEW))\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)/gi;

const normalName = (raw) =>
  raw
    .replace(/"/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/^public\./, '');

/**
 * The latest body of every SQL function and view, migrations in version
 * order, statements in file order. A function body is its dollar-quoted block;
 * a view's is its text to the next `;`.
 *
 * @param {Array<{ name: string, sql: string }>} files - sorted
 */
function latestSqlBodies(files) {
  const latest = new Map();
  let definitions = 0;
  for (const { sql } of files) {
    const src = stripSqlComments(sql);
    for (const m of src.matchAll(DEFINITION)) {
      const verb = m[1].toUpperCase();
      const name = normalName(m[2]);
      if (verb.startsWith('DROP')) {
        latest.delete(name);
        continue;
      }
      const after = src.slice(m.index + m[0].length);
      let body;
      if (/FUNCTION/.test(verb)) {
        const open = /\$(\w*)\$/.exec(after);
        if (open === null) continue;
        const rest = after.slice(open.index + open[0].length);
        const close = rest.indexOf(open[0]);
        body = close < 0 ? rest : rest.slice(0, close);
      } else {
        const end = after.indexOf(';');
        body = end < 0 ? after : after.slice(0, end);
      }
      definitions += 1;
      latest.set(name, body);
    }
  }
  return { latest, definitions };
}

function sqlSubjects() {
  const dir = path.join(REPO, MIGRATIONS);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }));
  const { latest, definitions } = latestSqlBodies(files);
  const readers = [...latest]
    .filter(([, body]) => /\bpractice_assignments\b/i.test(body))
    .map(([name]) => `sql:${name}`)
    .sort();
  return { files: files.length, definitions, readers, latest };
}

/**
 * The SQL form of "imports the helper": a function cannot import it, so an
 * `applies` SQL reader must read `practice_exceptions` in its LATEST body
 * (comments stripped) and a `pending` one must not yet.
 */
const READS_EXCEPTIONS = /\bpractice_exceptions\b/i;

// ----------------------------------------------------------------- the tests

const JS = jsSubjects();
const SQL = sqlSubjects();
const SUBJECTS = [...JS.readers, ...SQL.readers];

describe('practice-reader census (W16)', () => {
  it('scanned real source (a scan of nothing would pass every check below)', () => {
    expect(JS.scanned).toBeGreaterThan(300);
    expect(SQL.files).toBeGreaterThan(50);
    expect(SQL.definitions).toBeGreaterThan(100);
    // The two readers the plan found only through SQL (R6) and the feed (R4).
    expect(SUBJECTS).toContain('sql:upsert_team_event_rsvp');
    expect(SUBJECTS).toContain('supabase/functions/_shared/calendar/teamFeed.ts');
  });

  it('every reader of practice_assignments is classified', () => {
    const unclassified = SUBJECTS.filter((s) => !(s in REGISTRY));
    expect(unclassified).toEqual([]);
  });

  it('every registry entry still reads the table (no stale entries)', () => {
    const stale = Object.keys(REGISTRY).filter((k) => !SUBJECTS.includes(k));
    expect(stale).toEqual([]);
  });

  it('applies means it imports the helper; pending means it does not yet, and names its PR', () => {
    for (const [key, entry] of Object.entries(REGISTRY)) {
      expect(['applies', 'pending', 'series-only', 'writer'], key).toContain(entry.class);
      expect(entry.why.length, key).toBeGreaterThan(10);
      if (entry.class === 'pending') expect(entry.pr, key).toMatch(/^12[bcd]$/);
      // A SQL function cannot import the helper: it must read the exceptions
      // table instead, and 12d states its rule in pgTAP and the harness smoke.
      if (key.startsWith('sql:')) {
        const body = SQL.latest.get(key.slice('sql:'.length)) ?? '';
        const reads = READS_EXCEPTIONS.test(body);
        if (entry.class === 'applies') expect(reads, `${key} reads practice_exceptions`).toBe(true);
        if (entry.class === 'pending') {
          expect(reads, `${key} reads practice_exceptions: move it to applies`).toBe(false);
        }
        continue;
      }
      const imports = IMPORTS_HELPER.test(readFileSync(path.join(REPO, key), 'utf8'));
      if (entry.class === 'applies') expect(imports, key).toBe(true);
      if (entry.class === 'pending') {
        expect(imports, `${key} imports the helper: move it to applies`).toBe(false);
      }
    }
  });

  it('the scanners fire on the spellings they claim to catch, and not on others', () => {
    expect(jsReadsTable(`await supabase.from('practice_assignments').select('id');`)).toBe(true);
    expect(jsReadsTable('db.from("practice_assignments")')).toBe(true);
    expect(jsReadsTable("select('id, practice_assignments!team_id(id)')")).toBe(true);
    // A read behind a glob string is still seen; a commented read is counted (fails loud).
    expect(jsReadsTable("const g = 'src/**/*.js';\ndb.from('practice_assignments');")).toBe(true);
    expect(jsReadsTable("// .from('practice_assignments')")).toBe(true);
    expect(jsReadsTable("const msg = 'practice_assignments';")).toBe(false);
    expect(
      IMPORTS_HELPER.test("import { a } from '@squadlogic/core/utils/practiceExceptions.js';")
    ).toBe(true);
    expect(
      IMPORTS_HELPER.test("import { a } from '../_shared/calendar/practiceExceptions.ts';")
    ).toBe(true);
    expect(IMPORTS_HELPER.test("import { a } from './practiceOccurrences.js';")).toBe(false);
    const { latest } = latestSqlBodies([
      {
        name: '1.sql',
        sql: 'CREATE FUNCTION public.f() RETURNS int AS $$ SELECT 1 FROM public.practice_assignments $$ LANGUAGE sql;',
      },
      {
        name: '2.sql',
        sql: 'CREATE OR REPLACE FUNCTION f() RETURNS int AS $body$ SELECT 2 $body$ LANGUAGE sql; CREATE VIEW v AS SELECT * FROM practice_assignments; -- practice_assignments',
      },
      {
        name: '3.sql',
        sql: 'CREATE FUNCTION g() RETURNS int AS $$ SELECT 1 FROM practice_assignments $$; DROP FUNCTION IF EXISTS public.g();',
      },
    ]);
    // The SQL `applies` test: a body naming the table counts; a comment does not.
    const read = (sql) =>
      READS_EXCEPTIONS.test(latestSqlBodies([{ name: '1.sql', sql }]).latest.get('h') ?? '');
    expect(
      read('CREATE FUNCTION h() RETURNS int AS $$ SELECT 1 FROM practice_exceptions $$;')
    ).toBe(true);
    expect(
      read('CREATE FUNCTION h() RETURNS int AS $$ SELECT 1 -- practice_exceptions\n $$;')
    ).toBe(false);
    expect([...latest.keys()].sort()).toEqual(['f', 'v']);
    expect(/practice_assignments/.test(latest.get('f'))).toBe(false);
    expect(/practice_assignments/.test(latest.get('v'))).toBe(true);
  });
});
