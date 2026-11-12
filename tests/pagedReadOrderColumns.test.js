/**
 * Every paged read orders by a column its table has, and every read of the score relations names real columns.
 *
 * Why (Codex on #725, P1): `useGameAssignments` read `game_scores` through `fetchAllPages`, whose default order is
 * `id`. `game_scores` has no `id` (its key is `game_id`), so PostgREST refuses `order=id.asc` and the Games page could
 * not load a saved schedule on a real database, even with the table empty. The mock answered, because its rows
 * carried an `id` of its own and it sorts by whatever key a row has. It is the "mock is not the database" class
 * (lessons 104, 106, 107, 108), so the check is of the class:
 *
 * 1. every `fetchAllPages(...)` call in `frontend/src` is found by a source scan, its table and its order column
 *    resolved (the explicit `orderBy`, else the helper's own default, read from the helper), and the column must be
 *    one of the table's, read from the migrations (views: from the catalogue snapshot of a real build);
 * 2. every read of `game_scores`, `view_league_standings` and `current_game_runs` in `frontend/src` names only
 *    columns the relation has, in its select list, its filters and its order;
 * 3. the rows the mock stores and returns for those three have exactly the database's columns.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  relationColumns,
  tableColumnsFromMigrations,
  viewColumnsFromSnapshot,
} from './helpers/sqlColumns.js';
import {
  computeScoredStandings,
  deriveCurrentGameRuns,
  mockUpdateSavedGameScore,
} from '../frontend/src/lib/mockGameScores.js';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'frontend/src');
const RELATIONS = relationColumns();

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(js|jsx)$/.test(name) ? [full] : [];
  });
}
const FILES = sourceFiles(SRC).map((file) => ({
  file: path.relative(ROOT, file),
  text: readFileSync(file, 'utf8'),
}));

/** The text of a call from its opening parenthesis to the matching one. */
function callText(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

const HELPER = readFileSync(path.join(SRC, 'lib/pagedFetch.js'), 'utf8');
/** The helper's default order column, read from the helper (so a change of default is judged too). */
const DEFAULT_ORDER = /orderBy = '(\w+)'/.exec(HELPER)?.[1];

/**
 * Every `fetchAllPages(` call: its file, line, tables and order column. A call whose builder is written at the call
 * names its table in `.from('x')`. A call that is handed its table (three hooks and the reports reader page a LIST of
 * tables with one call) is resolved from the file: the tables of its `['key', 'table', ...]` tuples and of its
 * `read('table', ...)` calls, each of which that one call pages, so each is judged.
 */
function pagedReads(files = FILES) {
  const found = [];
  for (const { file, text } of files) {
    if (file.endsWith('lib/pagedFetch.js')) continue;
    for (const match of text.matchAll(/\bfetchAllPages\(/g)) {
      const call = callText(text, match.index + 'fetchAllPages'.length);
      const literal = /\.from\(\s*['"]([\w]+)['"]\s*\)/.exec(call)?.[1];
      const tables = literal
        ? [literal]
        : [
            ...new Set(
              [
                ...text.matchAll(/\[\s*'\w+',\s*'(\w+)'/g),
                ...text.matchAll(/\bread\(\s*'(\w+)'/g),
              ].map((m) => m[1])
            ),
          ];
      const orderBy = /orderBy:\s*['"](\w+)['"]/.exec(call)?.[1] ?? DEFAULT_ORDER;
      found.push({ file, tables, orderBy, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return found;
}

function judge(reads, relations = RELATIONS) {
  const problems = [];
  for (const read of reads) {
    if (read.tables.length === 0) {
      problems.push(`${read.file}:${read.line}: the table of this paged read cannot be resolved`);
      continue;
    }
    for (const table of read.tables) {
      const columns = relations.get(table);
      if (!columns) {
        problems.push(`${read.file}:${read.line}: ${table} is not a table or view of the database`);
      } else if (!columns.includes(read.orderBy)) {
        problems.push(
          `${read.file}:${read.line}: pages ${table} ordered by "${read.orderBy}", which is not a column of it`
        );
      }
    }
  }
  return problems;
}

describe('the column lists the checks stand on', () => {
  it('the migration parser reads the tables a reader knows, as they are now', () => {
    const tables = tableColumnsFromMigrations();
    expect(tables.size).toBeGreaterThan(40);
    expect([...tables.get('game_scores')].sort()).toEqual(
      [
        'away_team_id',
        'created_at',
        'game_id',
        'home_team_id',
        'organization_id',
        'score_away',
        'score_home',
        'updated_at',
        'updated_by',
      ].sort()
    );
    // Columns added and dropped by later migrations are followed.
    expect(tables.get('game_assignments').has('season_settings_id')).toBe(true);
    expect(tables.get('teams').has('is_external')).toBe(true);
    expect(tables.get('players').has('placement_eligible')).toBe(false);
    expect(tables.get('game_assignments').has('id')).toBe(true);
  });

  it('the views come from the snapshot of a real build', () => {
    const views = viewColumnsFromSnapshot();
    expect(views.get('current_game_runs')).toEqual([
      'organization_id',
      'season_settings_id',
      'run_id',
      'completed_at',
    ]);
    expect(views.get('view_league_standings').at(-1)).toBe('results_not_counted');
  });
});

describe('every paged read orders by a column of its table', () => {
  const reads = pagedReads();

  it('finds the paged reads (a scan that found none would pass everything)', () => {
    expect(DEFAULT_ORDER).toBe('id');
    expect(reads.length).toBeGreaterThanOrEqual(40);
    expect(reads.some((read) => read.tables.includes('game_scores'))).toBe(true);
    expect(reads.some((read) => read.tables.includes('game_assignments'))).toBe(true);
    // The four calls that page a list of tables resolve to more than one each.
    expect(reads.filter((read) => read.tables.length > 1).length).toBeGreaterThanOrEqual(4);
  });

  it('none orders by a column its table does not have', () => {
    expect(judge(reads)).toEqual([]);
  });

  it('PLANT: the defect is reported by name (a paged read of game_scores with the default order)', () => {
    const planted = pagedReads([
      {
        file: 'planted.js',
        text: "await fetchAllPages(() => supabase.from('game_scores').select('game_id'));",
      },
    ]);
    expect(judge(planted)).toEqual([
      'planted.js:1: pages game_scores ordered by "id", which is not a column of it',
    ]);
    // and its fix is not
    const fixed = pagedReads([
      {
        file: 'planted.js',
        text: "await fetchAllPages(() => supabase.from('game_scores').select('game_id'), { orderBy: 'game_id' });",
      },
    ]);
    expect(judge(fixed)).toEqual([]);
  });
});

describe('every read of the score relations names real columns', () => {
  const SUBJECTS = ['game_scores', 'view_league_standings', 'current_game_runs'];
  /** Each `.from('<subject>')` chain outside the mock: the columns of its select, filters and orders. */
  function reads() {
    const found = [];
    for (const { file, text } of FILES) {
      if (/\/lib\/mock/.test(file)) continue;
      for (const match of text.matchAll(/\.from\(\s*['"](\w+)['"]\s*\)/g)) {
        if (!SUBJECTS.includes(match[1])) continue;
        // The chain: to the end of the statement, and the options of a paged read that wraps it.
        const chain = text.slice(match.index, text.indexOf(';', match.index));
        const named = [];
        for (const select of chain.matchAll(/\.select\(\s*['"]([^'"]*)['"]/g)) {
          if (select[1].trim() !== '*') named.push(...select[1].split(',').map((c) => c.trim()));
        }
        for (const use of chain.matchAll(
          /\.(?:eq|neq|in|is|gt|gte|lt|lte|order)\(\s*['"](\w+)['"]/g
        ))
          named.push(use[1]);
        for (const use of chain.matchAll(/orderBy:\s*['"](\w+)['"]/g)) named.push(use[1]);
        found.push({ file, relation: match[1], named });
      }
    }
    return found;
  }

  it('each is found, and names only columns the relation has', () => {
    const all = reads();
    expect(all.map((r) => r.relation)).toEqual(
      expect.arrayContaining(['game_scores', 'view_league_standings'])
    );
    const wrong = all.flatMap((read) =>
      read.named
        .filter((column) => !RELATIONS.get(read.relation).includes(column))
        .map((column) => `${read.file}: reads ${read.relation}.${column}, which does not exist`)
    );
    expect(wrong).toEqual([]);
    // The meta-assertion: the scan read something of each (an empty list of names would pass).
    for (const read of all) expect(read.named.length, read.file).toBeGreaterThan(0);
  });
});

describe("the mock keeps and returns the database's columns for the score relations", () => {
  const db = /** @type {any} */ ({
    organizations: [{ id: 'o', feature_flags: { score_entry: true } }],
    organization_members: [{ organization_id: 'o', profile_id: 'u', role: 'admin' }],
    season_settings: [{ id: 's', organization_id: 'o', status: 'active' }],
    divisions: [{ id: 'd', organization_id: 'o', season_settings_id: 's', name: 'D' }],
    teams: [
      { id: 't1', organization_id: 'o', division_id: 'd', name: 'One' },
      { id: 't2', organization_id: 'o', division_id: 'd', name: 'Two' },
    ],
    game_assignments: [{ id: 'g', organization_id: 'o', home_team_id: 't1', away_team_id: 't2' }],
    scheduler_runs: [
      {
        id: 'r',
        organization_id: 'o',
        season_settings_id: 's',
        run_type: 'game',
        status: 'completed',
        completed_at: '2026-01-01T00:00:00Z',
      },
    ],
    game_scores: [],
    audit_log: [],
  });
  const answer = mockUpdateSavedGameScore(
    db,
    { p_organization_id: 'o', p_game_id: 'g', p_score_home: 1, p_score_away: 0 },
    {
      currentUserId: 'u',
      isOrgAdmin: () => true,
      isOrgMember: () => true,
      seasonRefusal: () => null,
    }
  );

  it("a stored game_scores row has exactly the table's columns (no key of the mock's own)", () => {
    expect(answer.error).toBe(null);
    expect(Object.keys(db.game_scores[0]).sort()).toEqual([...RELATIONS.get('game_scores')].sort());
  });

  it("a standings row and a current-run row have the views' columns, in their order", () => {
    expect(Object.keys(computeScoredStandings(db)[0])).toEqual(
      RELATIONS.get('view_league_standings')
    );
    expect(Object.keys(deriveCurrentGameRuns(db)[0])).toEqual(RELATIONS.get('current_game_runs'));
  });
});
