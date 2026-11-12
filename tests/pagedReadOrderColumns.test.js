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
      // A relation read as an EMBED in another table's select (`game_scores(game_id)`): the columns it names.
      for (const embed of text.matchAll(/['"`][^'"`]*\b(\w+)\s*\(([\w\s,]+)\)[^'"`]*['"`]/g)) {
        if (!SUBJECTS.includes(embed[1])) continue;
        found.push({ file, relation: embed[1], named: embed[2].split(',').map((c) => c.trim()) });
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
    game_assignments: [
      { id: 'g', organization_id: 'o', run_id: 'r', home_team_id: 't1', away_team_id: 't2' },
    ],
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

/**
 * F11-3: every read of the saved schedule names real columns and real foreign keys, embeds included (the readers
 * repointed off the legacy `games` table embed a game's slot, sides, ground and score, and the mock answers an embed
 * PostgREST refuses unless it is told the schema; lessons 104 to 108). Subjects: every `.from('<relation>')` of the
 * five relations below in `frontend/src` and `supabase/functions`, outside the mock and the tests. A select given as a
 * constant of the same file is read from that constant. Each embed must be a relation the parent reaches by a foreign
 * key: forward, through a column of the parent (named by its `!hint` where there are two), or back, from a relation
 * whose key names the parent (`game_scores` to `game_assignments`). The keys are written out here from the
 * migrations and checked against them below.
 */
describe('every read of the saved schedule names real columns and real foreign keys (F11-3)', () => {
  const SUBJECTS = [
    'game_assignments',
    'game_scores',
    'game_slots',
    'view_league_standings',
    'current_game_runs',
  ];
  /** parent -> embedded relation -> the parent's columns that reference it (forward), or 'reverse'. */
  const KEYS = {
    game_assignments: {
      game_slots: ['game_slot_id', 'slot_id'],
      teams: ['home_team_id', 'away_team_id'],
      fields: ['field_id'],
      game_scores: 'reverse',
    },
    game_slots: { fields: ['field_id'], divisions: ['division_id'] },
    fields: { locations: ['location_id'] },
    teams: { divisions: ['division_id'] },
  };
  const ALL_FILES = [
    ...FILES,
    ...sourceFiles(path.join(ROOT, 'supabase/functions')).map((file) => ({
      file: path.relative(ROOT, file),
      text: readFileSync(file, 'utf8'),
    })),
    ...readdirSync(path.join(ROOT, 'supabase/functions/_shared/calendar'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => {
        const file = path.join(ROOT, 'supabase/functions/_shared/calendar', name);
        return { file: path.relative(ROOT, file), text: readFileSync(file, 'utf8') };
      }),
  ].filter(({ file }) => !/\/lib\/mock|\/tests\/|_test\.ts$/.test(file));

  /** The text of a string constant of a file (`const NAME = '...' + '...'`), or null. */
  function constantText(text, name) {
    const match = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(text);
    if (!match) return null;
    return [...match[1].matchAll(/(['"`])((?:(?!\1)[\s\S])*)\1/g)].map((m) => m[2]).join('');
  }
  function topLevel(text) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else current += ch;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
  }
  /** Problems with a select list read against `relation`. */
  function judgeSelect(relation, select, where) {
    const problems = [];
    const columns = RELATIONS.get(relation);
    if (!columns) return [`${where}: ${relation} is not a table or view`];
    for (const part of topLevel(select)) {
      const embed = /^(?:\w+\s*:\s*)?(\w+)((?:\s*!\s*\w+)*)\s*\(([\s\S]*)\)$/.exec(part);
      if (!embed) {
        const column = part.replace(/^\w+\s*:\s*/, '').trim();
        if (column !== '*' && !columns.includes(column))
          problems.push(`${where}: ${relation}.${column} does not exist`);
        continue;
      }
      const [, child, bangs, inner] = embed;
      const hints = bangs
        .split('!')
        .map((w) => w.trim())
        .filter((w) => w && w !== 'inner' && w !== 'left');
      const key = KEYS[relation]?.[child];
      if (!key) problems.push(`${where}: ${relation} has no foreign key to or from ${child}`);
      else if (key !== 'reverse') {
        if (key.length > 1 && hints.length === 0)
          problems.push(`${where}: ${relation} -> ${child} is ambiguous without a column hint`);
        if (hints.length > 0 && !key.includes(hints[0]))
          problems.push(
            `${where}: ${relation} -> ${child} hinted by ${hints[0]}, not a key column`
          );
      }
      problems.push(...judgeSelect(child, inner, where));
    }
    return problems;
  }
  function reads(files = ALL_FILES) {
    const found = [];
    for (const { file, text } of files) {
      for (const match of text.matchAll(/\.from\(\s*['"](\w+)['"]\s*\)/g)) {
        if (!SUBJECTS.includes(match[1])) continue;
        const end = text.indexOf(';', match.index);
        const chain = text.slice(match.index, end);
        const where = `${file}:${text.slice(0, match.index).split('\n').length}`;
        const literal = /\.select\(\s*(['"`])((?:(?!\1)[\s\S])*)\1/.exec(chain)?.[2];
        const named = /\.select\(\s*([A-Z_][A-Z0-9_]*)\s*[,)]/.exec(chain)?.[1];
        const select = literal ?? (named ? constantText(text, named) : null);
        const filters = [
          ...[...chain.matchAll(/\.(?:eq|neq|in|is|gt|gte|lt|lte|order)\(\s*['"](\w+)['"]/g)].map(
            (m) => m[1]
          ),
          ...[...chain.matchAll(/orderBy:\s*['"](\w+)['"]/g)].map((m) => m[1]),
          ...[...chain.matchAll(/\.or\(\s*[`'"]([^`'"]*)[`'"]/g)].flatMap((m) =>
            m[1].split(',').map((clause) => clause.split('.')[0])
          ),
        ];
        found.push({ where, relation: match[1], select, filters });
      }
    }
    return found;
  }
  function judgeReads(found) {
    const problems = [];
    for (const read of found) {
      if (read.select === null) problems.push(`${read.where}: the select list cannot be read`);
      else problems.push(...judgeSelect(read.relation, read.select, read.where));
      for (const column of read.filters) {
        if (!RELATIONS.get(read.relation).includes(column))
          problems.push(`${read.where}: filters ${read.relation}.${column}, which does not exist`);
      }
    }
    return problems;
  }

  it('the keys written above are the migrations’ own (each column is one the parent has)', () => {
    for (const [parent, children] of Object.entries(KEYS)) {
      for (const columns of Object.values(children)) {
        if (columns === 'reverse') continue;
        for (const column of columns) expect(RELATIONS.get(parent), parent).toContain(column);
      }
    }
    expect(RELATIONS.get('game_scores')).toContain('game_id');
  });

  it('finds the reads of every repointed reader and of the feed', () => {
    const found = reads();
    const where = found.map((read) => read.where.split(':')[0]);
    for (const file of [
      'frontend/src/utils/savedGamesClient.js',
      'frontend/src/pages/ScoresPage.jsx',
      'frontend/src/hooks/useGameAssignments.js',
      'supabase/functions/_shared/calendar/teamFeed.ts',
    ]) {
      expect(where, file).toContain(file);
    }
    expect(found.every((read) => read.select !== null)).toBe(true);
  });

  it('each names only columns its relations have, and embeds only through a key', () => {
    expect(judgeReads(reads())).toEqual([]);
  });

  it('PLANT: an unhinted slot, a hint on no key, a column of the legacy table and an unrelated embed are each reported', () => {
    const planted = [
      "supabase.from('game_assignments').select('id, game_slots(slot_date)');",
      "supabase.from('game_assignments').select('id, home:teams!coach_id(name)');",
      "supabase.from('game_assignments').select('id, start_time, score_home').eq('season_id', s);",
      "supabase.from('game_assignments').select('id, games(id)');",
      "supabase.from('current_game_runs').select('run_id').or(`season_id.eq.${x}`);",
    ];
    const problems = judgeReads(
      reads(planted.map((text, i) => ({ file: `planted${i}.js`, text })))
    );
    expect(problems).toEqual([
      'planted0.js:1: game_assignments -> game_slots is ambiguous without a column hint',
      'planted1.js:1: game_assignments -> teams hinted by coach_id, not a key column',
      'planted2.js:1: game_assignments.start_time does not exist',
      'planted2.js:1: game_assignments.score_home does not exist',
      'planted2.js:1: filters game_assignments.season_id, which does not exist',
      'planted3.js:1: game_assignments has no foreign key to or from games',
      'planted4.js:1: filters current_game_runs.season_id, which does not exist',
    ]);
  });
});
