/**
 * The lists a new import type joins, enumerated from the code and the catalogue (schedule expansion plan
 * `docs/changes/2026-11-03-schedule-expansion.md`, 4.10, lesson 73; PR 5, task E2).
 *
 * A new member of a pipeline is a member of every list the pipeline keeps, and the evaluations import (the newest
 * type before `games`) needed eight lists the plan had not named, each found by a test that enumerates its subject
 * set rather than by the plan. This is that test for `games`:
 *
 * - **The subject set is the places the newest existing type is named**, found in the migrations (the latest
 *   definition of every CHECK on the three import tables, and of every SQL function whose body names `evaluations`) and
 *   in the code (every production file that names the type or its allowlist). A list is not found by reading the plan,
 *   so a list the plan forgot is a list this finds.
 * - **Each is classified**: `ready` (it holds `games` now), `deferred` (PR 6 owns it: the Edge function
 *   `import-validation` and the Import panel; it must NOT hold `games` yet, so PR 6 has to move the entry), or
 *   `not-a-list` (it names the type for another reason, said).
 * - **Both directions fail**: a list nobody classified, and an entry that no longer names the type.
 *
 * The allowlist's copies are held equal by `tests/importAllowlistParity.test.js`; this file requires only that each
 * copy has the games arm.
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
/** The newest type before games: where it is named, a new type has to be named. */
const NEWEST = 'evaluations';
const TABLES = ['import_jobs', 'staging_import_rows', 'import_application_records'];

const stripSqlComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

function migrationFiles() {
  const dir = path.join(REPO, 'supabase/migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }));
}

/**
 * The latest `ADD CONSTRAINT <name> CHECK (...)` on each import table, by constraint name.
 * @param {Array<{ name: string, sql: string }>} files
 * @returns {Map<string, { table: string, file: string, text: string }>}
 */
export function latestChecks(files) {
  const latest = new Map();
  for (const { name: file, sql } of files) {
    for (const statement of stripSqlComments(sql).split(';')) {
      const m =
        /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?(\w+)\s+ADD\s+CONSTRAINT\s+(\w+)\s+CHECK\s*\(([\s\S]*)\)\s*$/i.exec(
          statement
        );
      // A list of import types or of target tables (the status and other CHECKs of these tables are not lists of either).
      if (m && TABLES.includes(m[1]) && /'(?:coaches|fields)'/.test(m[3])) {
        latest.set(`${m[1]}.${m[2]}`, { table: m[1], file, text: m[3] });
      }
    }
  }
  return latest;
}

const FN_DEFINITION =
  /\b(CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|DROP\s+FUNCTION)\s+(?:IF\s+EXISTS\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)/gi;

/**
 * The latest body of every SQL function, migrations in version order.
 * @param {Array<{ name: string, sql: string }>} files
 * @returns {Map<string, { file: string, text: string }>}
 */
export function latestFunctions(files) {
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

/** The production files that name the newest type (as a quoted import type) or its allowlist. */
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
const namesGames = (text) => /['"`]games['"`]|\bGAME_IMPORT_KEYS\b/.test(text);

/** @type {Record<string, { class: 'ready' | 'deferred' | 'not-a-list', why: string }>} */
const CODE_REGISTRY = {
  'frontend/src/utils/importAllowlist.js': {
    class: 'ready',
    why: 'the browser copy of the allowlist: GAME_IMPORT_KEYS and the games arm of isAllowlistedImportType',
  },
  'supabase/functions/_shared/import-allowlist.ts': {
    class: 'ready',
    why: 'the Edge copy of the allowlist (a shared module, not the function): the same list, held equal by importAllowlistParity',
  },
  'frontend/src/lib/mockSupabaseClient.js': {
    class: 'ready',
    why: 'the mock create_import_job takes games, and the mock serves the games RPCs',
  },
  'frontend/src/lib/mockEvaluations.js': {
    class: 'not-a-list',
    why: "the evaluations finalizer's own mock: it names the type for itself, not in a list",
  },
  'frontend/src/components/ImportPanel.jsx': {
    class: 'deferred',
    why: "PR 6: the Import panel's tab list and telemetry (the Games tab)",
  },
  'frontend/src/contexts/ImportContext.jsx': {
    class: 'deferred',
    why: 'PR 6: the import state per type',
  },
  'frontend/src/utils/csvTemplates.js': {
    class: 'deferred',
    why: 'PR 6: the downloadable template (the header row of 4.3)',
  },
  'frontend/src/utils/importDeferredActions.js': {
    class: 'deferred',
    why: "PR 6: the panel's deferred-apply actions",
  },
  'supabase/functions/import-validation/index.ts': {
    class: 'deferred',
    why: "PR 6: the Edge function's import_type enum, REQUIRED_FIELDS and sensitive-type list (the function is not touched by PR 5)",
  },
};

/** @type {Record<string, { class: 'list' | 'not-a-list', why: string }>} */
const FUNCTION_REGISTRY = {
  create_import_job: { class: 'list', why: 'the type list, the job type each maps to' },
  mark_import_job_ready_to_apply: {
    class: 'list',
    why: 'the deferred-apply pair: the types it accepts',
  },
  cancel_ready_import_job: { class: 'list', why: 'the deferred-apply pair: the types it accepts' },
  import_allowed_keys: { class: 'list', why: 'the SQL copy of the allowlist' },
  finalize_evaluation_import_job: {
    class: 'not-a-list',
    why: 'the evaluations finalizer reads its own staged rows: it names the type for itself',
  },
};

/** @type {Record<string, string[]>} the members a constraint must hold for a games import */
const CONSTRAINT_REGISTRY = {
  'import_jobs.import_jobs_job_type_check': ['games'],
  'staging_import_rows.staging_import_rows_import_type_check': ['games'],
  'import_application_records.import_application_records_import_type_check': ['games'],
  'import_application_records.import_application_records_target_table_check': [
    'game_assignments',
    'teams',
    'divisions',
    'schedule_tbd',
    'game_slots',
    'locations',
    'fields',
  ],
};

/** The members a constraint's quoted list lacks, from {@link CONSTRAINT_REGISTRY}. */
export function missingMembers(text, required) {
  return required.filter((member) => !new RegExp(`'${member}'`).test(text));
}

describe('the CHECKs on the three import tables hold what a games import needs', () => {
  const checks = latestChecks(migrationFiles());

  it('finds the four constraints (a census that examined nothing is a failure)', () => {
    expect([...checks.keys()].sort()).toEqual(Object.keys(CONSTRAINT_REGISTRY).sort());
    for (const [key, check] of checks) {
      expect(check.text.length, key).toBeGreaterThan(30);
      expect(check.text, key).toMatch(/\bIN\s*\(/i);
    }
  });

  it.each(Object.entries(CONSTRAINT_REGISTRY))('%s holds its members', (key, required) => {
    expect(missingMembers(checks.get(key)?.text ?? '', required)).toEqual([]);
  });

  it('PLANT: a list without games is reported', () => {
    const planted =
      "job_type IN ('registration', 'fields', 'field_availability', 'manual', 'evaluations')";
    expect(missingMembers(planted, ['games'])).toEqual(['games']);
  });
});

describe('the SQL functions that name the newest type are classified, and the lists name games', () => {
  const functions = latestFunctions(migrationFiles());
  const naming = new Map(
    [...functions].filter(([, def]) => new RegExp(`'${NEWEST}'`).test(def.text))
  );

  it('finds them, and every one is classified', () => {
    expect([...naming.keys()].sort()).toEqual(Object.keys(FUNCTION_REGISTRY).sort());
  });

  it.each(Object.entries(FUNCTION_REGISTRY).filter(([, e]) => e.class === 'list'))(
    '%s names games',
    (name) => {
      expect(namesGames(naming.get(name)?.text ?? ''), name).toBe(true);
    }
  );

  it('create_import_job maps games to the games job type and refuses a draft season for it', () => {
    const body = naming.get('create_import_job')?.text ?? '';
    expect(body).toMatch(/WHEN\s+v_import_type\s*=\s*'games'\s+THEN\s+'games'/i);
    // The draft season is allowed only for the job types it names: games is not among them.
    expect(body).toMatch(/v_job_type\s+NOT\s+IN\s*\('registration',\s*'evaluations'\)/i);
  });

  it('import_allowed_keys has the games arm, of the length of the allowlist', () => {
    const body = naming.get('import_allowed_keys')?.text ?? '';
    const arm = /WHEN\s+'games'\s+THEN\s+ARRAY\s*\[([\s\S]*?)\]\s*::\s*text\[\]/i.exec(body);
    expect(arm).not.toBeNull();
    const keys = [...(arm?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...browserAllowlist.GAME_IMPORT_KEYS]);
  });

  it('fail_stale_import_jobs names no import type: it fails any job by status, so games joins it by default', () => {
    const body = functions.get('fail_stale_import_jobs')?.text ?? '';
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/job_type|import_type/i);
  });

  it('new functions exist and are the ones the plan names', () => {
    for (const name of [
      'apply_game_import_job',
      'rollback_game_import_job',
      'map_game_import_job',
      'ensure_game_slot',
    ]) {
      expect(functions.has(name), name).toBe(true);
    }
  });
});

describe('the code names games where the plan says it does, and not where PR 6 owns it', () => {
  const lists = codeLists();

  it('finds the production files that name the newest type, and every one is classified', () => {
    expect(lists.size).toBeGreaterThanOrEqual(8);
    const unclassified = [...lists.keys()].filter((k) => !(k in CODE_REGISTRY)).sort();
    const stale = Object.keys(CODE_REGISTRY)
      .filter((k) => !lists.has(k))
      .sort();
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it('each class holds: ready names games, deferred does not yet (PR 6 moves it)', () => {
    /** @type {string[]} */
    const wrong = [];
    for (const [file, entry] of Object.entries(CODE_REGISTRY)) {
      const has = namesGames(lists.get(file) ?? '');
      if (entry.class === 'ready' && !has)
        wrong.push(`${file}: classed ready but does not name games`);
      if (entry.class === 'deferred' && has)
        wrong.push(`${file}: classed deferred (PR 6) but already names games: move the entry`);
    }
    expect(wrong).toEqual([]);
  });

  it('PLANT: a ready file that stops naming games is reported', () => {
    const source = (lists.get('frontend/src/lib/mockSupabaseClient.js') ?? '').replace(
      /'games'/g,
      "'gamez'"
    );
    expect(namesGames(source)).toBe(false);
  });
});

describe("the allowlist's copies have the games arm and agree on its keys", () => {
  it("is a list the browser and the Edge copy hold, and not a list of the organization's declared fields", () => {
    expect(browserAllowlist.GAME_IMPORT_KEYS.length).toBe(21);
    expect([...edgeAllowlist.GAME_IMPORT_KEYS]).toEqual([...browserAllowlist.GAME_IMPORT_KEYS]);
    for (const copy of [browserAllowlist, edgeAllowlist]) {
      expect(copy.isAllowlistedImportType('games')).toBe(true);
      expect(Object.keys(copy.ALLOWLIST_ENTITY_TYPES)).not.toContain('games');
    }
  });

  it('keeps no key a games file does not carry (no coach, email, phone or note)', () => {
    for (const key of ['email', 'coach', 'coach_email', 'phone', 'notes', 'format', 'first_name']) {
      expect(browserAllowlist.isAllowedImportKey('games', key), key).toBe(false);
      expect(edgeAllowlist.isAllowedImportKey('games', key), key).toBe(false);
    }
    for (const key of ['game_id', 'home_key', 'away_team', 'start', 'end', 'week_index', 'flags']) {
      expect(browserAllowlist.isAllowedImportKey('games', key), key).toBe(true);
      expect(edgeAllowlist.isAllowedImportKey('games', key), key).toBe(true);
    }
  });
});

describe('the migration is guarded, reversible and in the harness', () => {
  const files = migrationFiles();
  const mine = files.find((f) => f.name.endsWith('_game_import.sql'));

  it('exists after the identity migration, with its revert and smoke', () => {
    expect(mine, 'a migration named *_game_import.sql').toBeTruthy();
    expect(mine && mine.name > '20261120010000').toBe(true);
    const id = mine?.name.slice(0, 14);
    expect(() => read(`docs/sql/${id}_revert.sql`)).not.toThrow();
    expect(() => read(`docs/sql/${id}_smoke.sql`)).not.toThrow();
  });

  it('is a registered revert check and has plants of its own', () => {
    const id = mine?.name.slice(0, 14) ?? '';
    expect(read('scripts/dbharness/run.sh')).toContain(id);
    const prove = read('scripts/dbharness/prove.sh');
    expect(prove).toContain(`M70="$REPO/supabase/migrations/${mine?.name}"`);
    expect((prove.match(/plant "M70 /g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the demo fence's census of client-callable functions lists the four new RPCs", () => {
    const fence = read('supabase/tests/demo_sessions.sql');
    for (const name of [
      'apply_game_import_job',
      'rollback_game_import_job',
      'map_game_import_job',
      'ensure_game_slot',
    ]) {
      // once in the allowed list and once in the control list that checks every name is still callable
      expect((fence.match(new RegExp(`'${name}'`, 'g')) ?? []).length, name).toBe(2);
    }
  });
});
