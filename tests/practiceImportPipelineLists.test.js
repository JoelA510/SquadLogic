/**
 * The lists the practice schedule import joins, enumerated from the code and the catalogue (schedule expansion plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.11.8, lesson 73; PR 10, task K2). The sibling of
 * `tests/gameImportPipelineLists.test.js`, for `practice_schedule`:
 *
 * - **The subject set is the places an existing type is named** (`evaluations`, the type the games census used, so this
 *   reads the same lists without depending on the word "games", which the code uses for much else): the latest
 *   definition of every CHECK on the three import tables, every SQL function whose body names it, and every production
 *   file that names the type or its allowlist. A list the plan forgot is a list this finds.
 * - **Each is classified**: `ready` (it holds `practice_schedule` now), `deferred` (PR 11 owns it and it must NOT hold the
 *   type yet; when PR 11 adds it the entry moves), or `not-a-list` (it names the type for another reason, said).
 * - **Both directions fail**: a list nobody classified, and an entry that no longer names the type.
 *
 * Retention is checked in the games census (its RETENTION_EXEMPT carries `practice_schedule`, with its reason); this file
 * requires the decision to be said where an operator reads it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as browserAllowlist from '../frontend/src/utils/importAllowlist.js';
import * as edgeAllowlist from '../supabase/functions/_shared/import-allowlist.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(REPO, file), 'utf8');
const JS_ROOTS = ['frontend/src', 'packages/core/src', 'supabase/functions'];
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const NOT_PRODUCTION = /\/(_?tests?|__tests__)\/|_test\.ts$/;
const NEWEST = 'evaluations';
const TYPE = 'practice_schedule';
const TABLES = ['import_jobs', 'staging_import_rows', 'import_application_records'];

const stripSqlComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

function migrationFiles() {
  const dir = path.join(REPO, 'supabase/migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }));
}

/** The latest `ADD CONSTRAINT <name> CHECK (...)` on each import table that lists import types or target tables. */
function latestChecks(files) {
  const latest = new Map();
  for (const { name: file, sql } of files) {
    for (const statement of stripSqlComments(sql).split(';')) {
      const m =
        /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?(\w+)\s+ADD\s+CONSTRAINT\s+(\w+)\s+CHECK\s*\(([\s\S]*)\)\s*$/i.exec(
          statement
        );
      if (m && TABLES.includes(m[1]) && /'(?:coaches|fields)'/.test(m[3])) {
        latest.set(`${m[1]}.${m[2]}`, { table: m[1], file, text: m[3] });
      }
    }
  }
  return latest;
}

const FN_DEFINITION =
  /\b(CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|DROP\s+FUNCTION)\s+(?:IF\s+EXISTS\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)/gi;

/** The latest body of every SQL function, migrations in version order. */
function latestFunctions(files) {
  const latest = new Map();
  for (const { name: file, sql } of files) {
    const src = stripSqlComments(sql);
    const defs = [...src.matchAll(FN_DEFINITION)];
    defs.forEach((m, i) => {
      const name = m[2]
        .replace(/"/g, '')
        .replace(/\s+/g, '')
        .toLowerCase()
        .replace(/^public\./, '');
      if (/^DROP/i.test(m[1])) {
        latest.delete(name);
        return;
      }
      const end = i + 1 < defs.length ? defs[i + 1].index : src.length;
      latest.set(name, { file, text: src.slice(m.index, end) });
    });
  }
  return latest;
}

/** @param {string} dir @param {string[]} [out] */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walk(full, out);
    } else if (JS_EXTENSIONS.has(path.extname(full))) out.push(full);
  }
  return out;
}

function codeLists() {
  const found = new Map();
  const naming = new RegExp(`['"\`]${NEWEST}['"\`]|\\bEVALUATION_IMPORT_KEYS\\b`);
  for (const root of JS_ROOTS) {
    for (const file of walk(path.join(REPO, root))) {
      const rel = path.relative(REPO, file);
      if (NOT_PRODUCTION.test(rel)) continue;
      const source = readFileSync(file, 'utf8');
      if (naming.test(source)) found.set(rel, source);
    }
  }
  return found;
}

/** @param {string} text */
export const namesPracticeSchedule = (text) =>
  /['"`]practice_schedule['"`]|\bPRACTICE_SCHEDULE_IMPORT_KEYS\b/.test(text);

/** @type {Record<string, { class: 'ready' | 'deferred' | 'not-a-list', why: string }>} */
const CODE_REGISTRY = {
  'frontend/src/utils/importAllowlist.js': {
    class: 'ready',
    why: 'the browser copy of the allowlist: PRACTICE_SCHEDULE_IMPORT_KEYS and its arm',
  },
  'supabase/functions/_shared/import-allowlist.ts': {
    class: 'ready',
    why: 'the Edge copy of the allowlist, held equal by importAllowlistParity',
  },
  'frontend/src/lib/mockSupabaseClient.js': {
    class: 'ready',
    why: 'K3: the mock create_import_job takes practice_schedule, and the mock serves the practice import RPCs',
  },
  'frontend/src/lib/mockEvaluations.js': {
    class: 'not-a-list',
    why: "the evaluations finalizer's own mock: it names the type for itself, not in a list",
  },
  'frontend/src/components/ImportPanel.jsx': {
    class: 'ready',
    why: "PR 11 (L2): the Practices tab is a kind of PR 6's panel",
  },
  'frontend/src/contexts/ImportContext.jsx': {
    class: 'ready',
    why: 'PR 11 (L2): a practice job is left to its own panel, as a games job is',
  },
  'frontend/src/utils/csvTemplates.js': {
    class: 'not-a-list',
    why: 'holds templates under object keys and lists no import type by name (PR 11 adds the practice template)',
  },
  'frontend/src/utils/importDeferredActions.js': {
    class: 'not-a-list',
    why: 'names evaluations for its own preview; the practice import, like the games import, calls its own RPCs',
  },
  'supabase/functions/import-validation/index.ts': {
    class: 'ready',
    why: 'PR 11 (L1): import-validation accepts practice_schedule (the allowlist, Zod rows, the 2,400 cap, the header aliases)',
  },
};

/** @type {Record<string, { class: 'list' | 'not-a-list', why: string }>} */
const FUNCTION_REGISTRY = {
  create_import_job: { class: 'list', why: 'the type list, the job type each maps to' },
  mark_import_job_ready_to_apply: { class: 'list', why: 'the deferred-apply pair' },
  cancel_ready_import_job: { class: 'list', why: 'the deferred-apply pair' },
  import_allowed_keys: { class: 'list', why: 'the SQL copy of the allowlist' },
  finalize_evaluation_import_job: {
    class: 'not-a-list',
    why: 'the evaluations finalizer reads its own staged rows',
  },
};

/** @type {Record<string, string[]>} the members a constraint must hold for a practice import */
const CONSTRAINT_REGISTRY = {
  'import_jobs.import_jobs_job_type_check': [TYPE],
  'staging_import_rows.staging_import_rows_import_type_check': [TYPE],
  'import_application_records.import_application_records_import_type_check': [TYPE],
  'import_application_records.import_application_records_target_table_check': [
    'practice_assignments',
    'practice_slots',
    'field_subunits',
    'fields',
    'locations',
    'divisions',
    'teams',
  ],
};

/** The members a constraint's quoted list lacks. */
export function missingMembers(text, required) {
  return required.filter((member) => !new RegExp(`'${member}'`).test(text));
}

describe('the CHECKs on the three import tables hold what a practice import needs', () => {
  const checks = latestChecks(migrationFiles());

  it('finds the four constraints (a census that examined nothing is a failure)', () => {
    expect([...checks.keys()].sort()).toEqual(Object.keys(CONSTRAINT_REGISTRY).sort());
  });

  it.each(Object.entries(CONSTRAINT_REGISTRY))('%s holds its members', (key, required) => {
    expect(missingMembers(checks.get(key)?.text ?? '', required)).toEqual([]);
  });

  it('PLANT: a list without practice_schedule is reported', () => {
    const planted = "job_type IN ('registration', 'fields', 'evaluations', 'games')";
    expect(missingMembers(planted, [TYPE])).toEqual([TYPE]);
  });
});

describe('the SQL functions that name an existing type are classified, and the lists name practice_schedule', () => {
  const functions = latestFunctions(migrationFiles());
  const naming = new Map(
    [...functions].filter(([, def]) => new RegExp(`'${NEWEST}'`).test(def.text))
  );

  it('finds them, and every one is classified', () => {
    expect([...naming.keys()].sort()).toEqual(Object.keys(FUNCTION_REGISTRY).sort());
  });

  it.each(Object.entries(FUNCTION_REGISTRY).filter(([, e]) => e.class === 'list'))(
    '%s names practice_schedule',
    (name) => {
      expect(namesPracticeSchedule(naming.get(name)?.text ?? ''), name).toBe(true);
    }
  );

  it('create_import_job maps practice_schedule to its own job type, and a draft season is not allowed for it', () => {
    const body = naming.get('create_import_job')?.text ?? '';
    expect(body).toMatch(
      /WHEN\s+v_import_type\s*=\s*'practice_schedule'\s+THEN\s+'practice_schedule'/i
    );
    expect(body).toMatch(/v_job_type\s+NOT\s+IN\s*\('registration',\s*'evaluations'\)/i);
  });

  it('the deferred pair checks the job type of a practice_schedule job', () => {
    for (const name of ['mark_import_job_ready_to_apply', 'cancel_ready_import_job']) {
      expect(naming.get(name)?.text ?? '', name).toMatch(
        /v_import_type\s*=\s*'practice_schedule'\s+AND\s+v_job\.job_type\s*<>\s*'practice_schedule'/i
      );
    }
  });

  it('import_allowed_keys has the practice_schedule arm, equal to the allowlist', () => {
    const body = naming.get('import_allowed_keys')?.text ?? '';
    const arm = /WHEN\s+'practice_schedule'\s+THEN\s+ARRAY\s*\[([\s\S]*?)\]\s*::\s*text\[\]/i.exec(
      body
    );
    expect(arm).not.toBeNull();
    const keys = [...(arm?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...browserAllowlist.PRACTICE_SCHEDULE_IMPORT_KEYS]);
  });

  it('fail_stale_import_jobs names no import type: the practice import joins it by default', () => {
    const body = functions.get('fail_stale_import_jobs')?.text ?? '';
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/job_type|import_type/i);
  });

  it('the functions the plan names exist (K1)', () => {
    for (const name of [
      'map_practice_import_job',
      'ensure_practice_slot',
      'apply_practice_import_job',
      'rollback_practice_import_job',
    ]) {
      expect(functions.has(name), name).toBe(true);
    }
  });

  it('K1: persist_practice_schedule and its gate are not replaced by this migration', () => {
    expect(functions.get('persist_practice_schedule')?.file).toBe(
      '20261108020000_schedule_tbd.sql'
    );
    expect(functions.get('practice_new_auto_row_refusals')?.file).toBe(
      '20261105010000_practices_per_division.sql'
    );
    expect(functions.get('refresh_schedule_tbd_practices')?.file).toBe(
      '20261108020000_schedule_tbd.sql'
    );
  });
});

describe('the code names practice_schedule where this PR says it does, and not where PR 11 owns it', () => {
  const lists = codeLists();

  it('finds the production files that name the existing type, and every one is classified', () => {
    expect(lists.size).toBeGreaterThanOrEqual(8);
    const unclassified = [...lists.keys()].filter((k) => !(k in CODE_REGISTRY)).sort();
    const stale = Object.keys(CODE_REGISTRY)
      .filter((k) => !lists.has(k))
      .sort();
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it('each class holds: ready names practice_schedule, deferred does not yet (PR 11 moves it)', () => {
    const wrong = [];
    for (const [file, entry] of Object.entries(CODE_REGISTRY)) {
      const has = namesPracticeSchedule(lists.get(file) ?? '');
      if (entry.class === 'ready' && !has) wrong.push(`${file}: ready but does not name it`);
      if (entry.class === 'deferred' && has)
        wrong.push(`${file}: deferred (PR 11) but already names it: move the entry`);
    }
    expect(wrong).toEqual([]);
  });

  it('PLANT: a ready file that stops naming the type is reported, and a deferred one that starts is too', () => {
    const mock = lists.get('frontend/src/lib/mockSupabaseClient.js') ?? '';
    expect(namesPracticeSchedule(mock)).toBe(true);
    expect(namesPracticeSchedule(mock.replace(/practice_schedule/g, 'practice_schedulx'))).toBe(
      false
    );
    expect(namesPracticeSchedule("['games', 'practice_schedule']")).toBe(true);
  });
});

describe("the allowlist's copies have the practice_schedule arm", () => {
  it('in both copies, equal, and not a list of declared fields', () => {
    expect([...edgeAllowlist.PRACTICE_SCHEDULE_IMPORT_KEYS]).toEqual([
      ...browserAllowlist.PRACTICE_SCHEDULE_IMPORT_KEYS,
    ]);
    for (const copy of [browserAllowlist, edgeAllowlist]) {
      expect(copy.isAllowlistedImportType(TYPE)).toBe(true);
      expect(Object.keys(copy.ALLOWLIST_ENTITY_TYPES)).not.toContain(TYPE);
      for (const key of ['email', 'coach', 'coach_email', 'phone', 'notes', 'first_name'])
        expect(copy.isAllowedImportKey(TYPE, key), key).toBe(false);
      for (const key of ['team_key', 'subunit', 'valid_until', 'capacity', 'flags'])
        expect(copy.isAllowedImportKey(TYPE, key), key).toBe(true);
    }
  });
});

describe('the migration is guarded, reversible and in the harness', () => {
  const files = migrationFiles();
  const mine = files.find((f) => f.name.endsWith('_practice_import.sql'));

  it('exists after the scores migration, with its revert and smoke', () => {
    expect(mine, 'a migration named *_practice_import.sql').toBeTruthy();
    expect(mine && mine.name > '20261122010000').toBe(true);
    const id = mine?.name.slice(0, 14);
    expect(() => read(`docs/sql/${id}_revert.sql`)).not.toThrow();
    expect(() => read(`docs/sql/${id}_smoke.sql`)).not.toThrow();
  });

  it('is a registered revert check and has plants of its own', () => {
    const id = mine?.name.slice(0, 14) ?? '';
    expect(read('scripts/dbharness/run.sh')).toContain(id);
    const prove = read('scripts/dbharness/prove.sh');
    expect(prove).toContain(`M80="$REPO/supabase/migrations/${mine?.name}"`);
    expect((prove.match(/plant "M80 /g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the demo fence's census lists the three new RPCs, and not the internal ensure_practice_slot", () => {
    const fence = read('supabase/tests/demo_sessions.sql');
    for (const name of [
      'apply_practice_import_job',
      'map_practice_import_job',
      'rollback_practice_import_job',
    ]) {
      expect((fence.match(new RegExp(`'${name}'`, 'g')) ?? []).length, name).toBe(2);
    }
    expect(fence).not.toContain("'ensure_practice_slot'");
  });

  it('the retention decision for practice_schedule is stated where an operator reads it', () => {
    expect(read('docs/operations/ingestion-pipeline.md')).toContain(
      'Staged practice schedule rows are not on a retention job'
    );
  });
});
