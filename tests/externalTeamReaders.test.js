/**
 * The census of everything that reads `teams`, made enforceable for outside clubs (schedule expansion plan
 * `docs/changes/2026-11-03-schedule-expansion.md`, 4.6, decision 5; PR 5, task E2).
 *
 * An outside club is a `teams` row with `is_external` set, one per (division, club label). It is a legal side of a
 * game and nothing else: it has no players, no coach, no practice, and it is in no team run. So every reader of
 * `teams` has to say which of these it is, and a reader nobody classified is a list that will show a club that is not
 * the organization's. The shape is `tests/practiceReaderCensus.test.js`:
 *
 * - **The subject set is enumerated from the code, never from the plan**: every production file (`frontend/src`,
 *   `packages/core/src`, `supabase/functions`, outside its tests and the mock client) that reads the table
 *   (`.from('teams')`, a helper that takes the table name, a `['teams', 'teams', columns]` read list, or a `teams(...)`
 *   embed), and the LATEST definition of every SQL function or view in `supabase/migrations` whose body reads it.
 * - **Every subject is classified** in {@link REGISTRY}: `exclude` (an `is_external` row never appears: the read says
 *   so), `include` (the reader shows an outside club's games, and must not filter it), `by-id` (it looks up the teams
 *   it is handed, or a team's own row: nothing lists teams), `tenancy` and `writer` (it checks or writes a row it is
 *   given), `pending` (a named later change adopts the exclusion: the read must NOT have it yet, so that change has to
 *   move the entry).
 * - **Both directions fail**: an unclassified reader, and an entry whose file or function no longer reads the table.
 * - **A class is checked, not trusted**: `exclude` must carry the filter, `include` must not, `pending` must not yet.
 *
 * It then pins what the classes promise: the capacity panel's read leaves an outside club out of the demand (the
 * owner's decision 5, item 5), the reports show an outside side of a game by name and the coach schedule has no coach
 * for it, the conflict audit does not call an outside club double-booked, nothing feeds an outside club's result into
 * the standings today, and the scanner itself finds each kind of reader and can fail (it is run on constructed
 * sources, as lesson 92 asks).
 *
 * **Blind spots, declared.** A reader naming the table through a variable (`.from(TABLE)`) is invisible to the JS scan,
 * as is a SQL function that builds the name at run time. Row-level security policies name the table to decide who may
 * read a row, not to list teams, and are not subjects. Overloaded SQL functions are keyed by name.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { auditSchedule } from '../packages/core/src/scheduleImport/audit.js';
import { buildCoachSchedule } from '../packages/core/src/reports/coachSchedule.js';
import { buildDaySheet } from '../packages/core/src/reports/daySheet.js';
import { loadPracticeCapacityRows } from '../frontend/src/hooks/usePracticeCapacityDemand.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_ROOTS = ['frontend/src', 'packages/core/src', 'supabase/functions'];
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const MIGRATIONS = 'supabase/migrations';

/** The filter every `exclude` JS reader carries (PostgREST `is_external <> true`; the mock treats an absent column alike). */
const JS_EXCLUSION = /\.neq\(\s*['"`]is_external['"`]\s*,\s*true\s*\)/;
const SQL_EXCLUSION = /\bis_external\b/;

/**
 * @typedef {'exclude' | 'include' | 'by-id' | 'tenancy' | 'writer' | 'pending'} ReaderClass
 * @type {Record<string, { class: ReaderClass, why: string, pr?: string }>}
 */
const REGISTRY = {
  // --- JavaScript and TypeScript readers.
  'frontend/src/components/settings/FeatureFlagSettings.jsx': {
    class: 'exclude',
    why: 'asks whether the organization has formed any team (it locks a setting once teaming ran): an outside club is not one',
  },
  'frontend/src/hooks/useCoedTransition.js': {
    class: 'exclude',
    why: "counts the season division's teams for the coed transition: roster counts are the organization's own",
  },
  'frontend/src/hooks/useNavBadges.js': {
    class: 'exclude',
    why: "the Teams badge counts the organization's teams",
  },
  'frontend/src/hooks/usePracticeCapacityDemand.js': {
    class: 'exclude',
    why: "the capacity panel's demand is each division's teams times its practices a week: an outside club plays no practice here (owner decision 5, item 5)",
  },
  'frontend/src/hooks/usePracticeDaylightOutlook.js': {
    class: 'by-id',
    why: 'names the teams assigned to a slot, by id; an outside club has no practice assignment',
  },
  'frontend/src/hooks/usePracticeRepairSnapshot.js': {
    class: 'by-id',
    why: 'names the teams of saved practice assignments, by id; an outside club has none',
  },
  'frontend/src/hooks/usePreferenceContext.js': {
    class: 'exclude',
    why: 'the teams an admin can write a practice preference for: a rule for an outside club is meaningless',
  },
  'frontend/src/hooks/useSetupProgress.js': {
    class: 'exclude',
    why: 'the setup checklist\'s "teams formed" count',
  },
  'frontend/src/hooks/useTeamPortal.js': {
    class: 'by-id',
    why: 'reads one team by its id (the portal of that team)',
  },
  'frontend/src/pages/CoachesPage.jsx': {
    class: 'exclude',
    why: 'coach assignment and coach compliance: an outside club has no coach to assign or to miss',
  },
  'frontend/src/pages/DashboardPage.jsx': {
    class: 'exclude',
    why: "the admin home's team count and roster capacity by division",
  },
  'frontend/src/pages/PlayerRecordPage.jsx': {
    class: 'by-id',
    why: "names the player's own team (a player is never on an outside club)",
  },
  'frontend/src/pages/TeamBuilderPage.jsx': {
    class: 'exclude',
    why: "the team builder lists the organization's teams to move players between",
  },
  'frontend/src/utils/scheduleReportsRead.js': {
    class: 'include',
    why: 'the Day Sheet and the Changes view name BOTH sides of a game, an outside club included; the coach schedule has no coach for one',
  },
  'packages/core/src/practiceSupabase.js': {
    class: 'by-id',
    why: "an embed of the team's division to scope saved practices to a season; it lists no team",
  },
  'supabase/functions/_shared/auth.ts': {
    class: 'by-id',
    why: 'resolves the organizations of the team ids a payload names',
  },
  'supabase/functions/_shared/calendar/teamFeed.ts': {
    class: 'include',
    why: 'the feed of one team names its opponent in each game, an outside club included',
  },
  'supabase/functions/_shared/engines/practice-division-settings.ts': {
    class: 'by-id',
    why: "the settings of the teams a run was handed, looked up by id; the run's teams come from the client lists above",
  },
  'supabase/functions/_shared/engines/practice-lock.ts': {
    class: 'by-id',
    why: "an embed of the team's division to scope saved practices to a season; it lists no team",
  },
  'supabase/functions/_shared/engines/practice-reservations.ts': {
    class: 'by-id',
    why: 'the division of the teams a run was handed, looked up by id',
  },
  'supabase/functions/calendar-feed/index.ts': {
    class: 'by-id',
    why: 'resolves a feed token to its one team',
  },

  // --- SQL: the latest definition of each function or view that reads the table.
  'sql:view:view_org_metrics': {
    class: 'exclude',
    why: "total_teams counts the organization's own teams of the season (latest definition 20261108010000:2118)",
  },
  'sql:view:view_league_standings': {
    class: 'pending',
    pr: 'F11-2',
    why: "DEFERRED to the F11 plan (policy ii of 4.6; its F11-2 rebuilds the view over game_scores and excludes outside clubs). Left alone here by the F11 plan's binding amendment: it still reads the empty legacy games, so no path feeds an outside club's result into it today (pinned below)",
  },
  'sql:fn:sync_schedule_tbd_practices': {
    class: 'exclude',
    why: 'the practice TIME TBD list: an outside club in a two-a-week division would read as short of its count',
  },
  'sql:fn:get_schedule_tbd': {
    class: 'include',
    why: 'the TIME TBD list names both teams of a game that has no time, an outside club included',
  },
  'sql:fn:persist_practice_schedule': {
    class: 'pending',
    pr: 'the next replacement of persist_practice_schedule',
    why: 'its result lists "teams without a practice" and the time-TBD teams from the season\'s roster, so an outside club of a division that gives practices would be named there; replacing the 1,200-line body is out of proportion for this PR and is reported to the owner',
  },
  'sql:fn:apply_game_import_job': {
    class: 'writer',
    why: 'creates the outside clubs and the shells, and reads teams only to resolve what the admin mapped',
  },
  'sql:fn:rollback_game_import_job': {
    class: 'writer',
    why: 'removes the clubs and shells the import created, when nothing else references them',
  },
  'sql:fn:map_game_import_job': {
    class: 'by-id',
    why: 'validates the team ids the admin mapped against the organization',
  },
  'sql:fn:persist_game_schedule': {
    class: 'writer',
    why: 'validates the two sides of a saved game by id; an outside club is a legal side',
  },
  'sql:fn:persist_team_schedule': {
    class: 'writer',
    why: "the audited team writer: the import's shells go through it; an outside club never does",
  },
  'sql:fn:start_demo_session': { class: 'writer', why: "seeds the demo league's own teams" },
  'sql:fn:finalize_coach_import_job': {
    class: 'by-id',
    why: 'ties a coach to the teams of the children it names, by id',
  },
  'sql:fn:rollback_coach_import_job': {
    class: 'by-id',
    why: 'puts back what the coach import replaced, by id',
  },
  'sql:fn:finalize_practice_preference_import_job': {
    class: 'by-id',
    why: "resolves a preference row's team by the name the file gives; an outside club is reached only if a preference file names it, and a rule for a team with no coach and no practice does nothing",
  },
  'sql:fn:update_game_score': {
    class: 'by-id',
    why: 'checks both teams of a score belong to the organization, by id',
  },
  'sql:fn:rotate_calendar_token': { class: 'by-id', why: "one team's feed token" },
  'sql:fn:admin_update_coach_status': { class: 'by-id', why: "a coach's teams, by the coach" },
  'sql:fn:apply_player_patch': {
    class: 'by-id',
    why: "checks a player's team belongs to the player's season",
  },
  'sql:fn:admin_update_player': {
    class: 'by-id',
    why: "checks a player's team belongs to the organization",
  },
  'sql:fn:admin_delete_coaches': { class: 'by-id', why: 'the teams of the coaches deleted' },
  'sql:fn:admin_delete_team': {
    class: 'by-id',
    why: 'deletes one team by id (an outside club has no UI path to it: the Teams lists exclude it)',
  },
  'sql:fn:admin_update_team': { class: 'by-id', why: 'edits one team by id' },
  'sql:fn:set_team_coaches': { class: 'by-id', why: "the one writer of a team's coaches, by id" },
  'sql:fn:admin_assign_team_coach': {
    class: 'by-id',
    why: 'assigns a coach to one team by id (the Coaches page lists no outside club)',
  },
  'sql:fn:team_coach_assignment_drift': {
    class: 'by-id',
    why: "compares each team's stored coach with its assignments: an outside club has neither, so it never drifts",
  },
  'sql:fn:practice_schedule_fingerprint': {
    class: 'by-id',
    why: 'fingerprints saved practice rows, joined to their team; an outside club has none',
  },
  'sql:fn:enact_practice_recommendation': { class: 'by-id', why: "one team's practice, by id" },
  'sql:fn:team_local_today': { class: 'by-id', why: "one team's date on the season's clock" },
  'sql:fn:get_team_staff': { class: 'by-id', why: "one team's staff" },
  'sql:fn:get_team_roster': { class: 'by-id', why: "one team's roster" },
  'sql:fn:practice_new_auto_row_refusals': {
    class: 'by-id',
    why: 'judges the practice rows it is handed',
  },
  'sql:fn:admin_add_practice_preference': { class: 'by-id', why: 'a rule for one team by id' },
  'sql:fn:admin_edit_practice_preference': { class: 'by-id', why: 'a rule for one team by id' },
  'sql:fn:admin_remove_practice_preference': { class: 'by-id', why: 'a rule for one team by id' },
  'sql:fn:admin_decide_must_preference': { class: 'by-id', why: 'a rule for one team by id' },
  'sql:fn:enforce_player_season': {
    class: 'tenancy',
    why: "a player's team is of the player's season",
  },
  'sql:fn:team_players_same_season': {
    class: 'tenancy',
    why: "a roster row's team is of its player's season",
  },
  'sql:fn:team_coach_assignments_same_season': {
    class: 'tenancy',
    why: "a coach assignment's team is of the coach's season",
  },
  'sql:fn:schedule_tbd_enforce_tenancy': {
    class: 'tenancy',
    why: "a TIME TBD row's teams are of its organization and season",
  },
  'sql:fn:season_schedule_readonly_when_completed': {
    class: 'tenancy',
    why: "finds a row's season through its team",
  },
  'sql:fn:coach_practice_preferences_enforce_tenancy': {
    class: 'tenancy',
    why: "a rule's team is of its organization",
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

const JS_PATTERNS = {
  from: /\bfrom\(\s*['"`]teams['"`]\s*\)/,
  helper:
    /\b(?:countRows|countOf|read|readAll|readAllPages|fetchTable|fetchAll)\(\s*['"`]teams['"`]/,
  tuple: /\[\s*['"`]teams['"`]\s*,\s*['"`]teams['"`]/,
  embed: /[:\s'"`,(]teams(?:!\w+)?\(/,
};

/**
 * The kinds of read a JS or TS source makes of `teams`, or none.
 * @param {string} source
 * @returns {string[]}
 */
export function jsTeamReads(source) {
  const src = stripJsComments(source);
  return Object.entries(JS_PATTERNS)
    .filter(([, re]) => re.test(src))
    .map(([kind]) => kind);
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

const NOT_PRODUCTION = /\/(_?tests?|__tests__)\/|_test\.ts$|mockSupabaseClient|mockSeasons/;

/** @returns {Map<string, { kinds: string[], source: string }>} */
function scanJs() {
  const found = new Map();
  for (const root of JS_ROOTS) {
    for (const file of walk(path.join(REPO, root))) {
      const rel = path.relative(REPO, file);
      if (NOT_PRODUCTION.test(rel)) continue;
      const source = readFileSync(file, 'utf8');
      const kinds = jsTeamReads(source);
      if (kinds.length > 0) found.set(rel, { kinds, source });
    }
  }
  return found;
}

const SQL_DEFINITION =
  /\b(CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|(?:MATERIALIZED\s+)?VIEW)|DROP\s+(?:FUNCTION|VIEW))\s+(?:IF\s+EXISTS\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)/gi;
const SQL_TABLE_READ =
  /(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+(?:ONLY\s+)?(?:public\.)?teams\b/i;

/**
 * The latest definition of every SQL function and view, migrations in version order.
 * @param {Array<{ name: string, sql: string }>} files
 * @returns {Map<string, { file: string, text: string }>} keyed `sql:fn:<name>` or `sql:view:<name>`
 */
export function latestSqlDefinitions(files) {
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
  return latest;
}

/** @param {Map<string, { file: string, text: string }>} latest */
export function sqlTeamReaders(latest) {
  return new Map([...latest].filter(([, def]) => SQL_TABLE_READ.test(def.text)));
}

function migrationFiles() {
  const dir = path.join(REPO, MIGRATIONS);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }));
}

/**
 * The census over the readers found: what is unclassified, what is stale, and what its class does not hold.
 * @param {Map<string, { kinds?: string[], source?: string, text?: string }>} found
 * @param {typeof REGISTRY} registry
 */
export function judgeReaders(found, registry) {
  const unclassified = [...found.keys()].filter((k) => !(k in registry)).sort();
  const stale = Object.keys(registry)
    .filter((k) => !found.has(k))
    .sort();
  /** @type {string[]} */
  const wrong = [];
  for (const [key, entry] of Object.entries(registry)) {
    const reader = found.get(key);
    if (!reader) continue;
    const isSql = key.startsWith('sql:');
    const text = isSql ? (reader.text ?? '') : (reader.source ?? '');
    const filtered = (isSql ? SQL_EXCLUSION : JS_EXCLUSION).test(
      isSql ? text : stripJsComments(text)
    );
    if (entry.class === 'exclude' && !filtered)
      wrong.push(`${key}: classed exclude but does not exclude is_external`);
    if (entry.class === 'include' && filtered)
      wrong.push(`${key}: classed include but filters is_external`);
    if (entry.class === 'pending' && filtered)
      wrong.push(`${key}: classed pending (${entry.pr}) but already excludes: move the entry`);
  }
  return { unclassified, stale, wrong };
}

// ---------------------------------------------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------------------------------------------

describe('every reader of `teams` is classified, from the code', () => {
  const js = scanJs();
  const sqlLatest = latestSqlDefinitions(migrationFiles());
  const sql = sqlTeamReaders(sqlLatest);
  /** @type {Map<string, any>} */
  const found = new Map([...js, ...sql]);

  it('finds the readers (a census that examined nothing is a failure)', () => {
    expect(js.size).toBeGreaterThanOrEqual(20);
    expect(sql.size).toBeGreaterThanOrEqual(35);
    // Positive controls: a reader of each JS kind and of each SQL kind is in the subject set.
    expect(js.get('frontend/src/hooks/usePracticeCapacityDemand.js')?.kinds).toEqual(
      expect.arrayContaining(['from', 'tuple'])
    );
    expect(js.get('frontend/src/hooks/useNavBadges.js')?.kinds).toContain('helper');
    expect(js.get('supabase/functions/calendar-feed/index.ts')?.kinds).toContain('embed');
    expect(sql.has('sql:view:view_org_metrics')).toBe(true);
    expect(sql.has('sql:fn:sync_schedule_tbd_practices')).toBe(true);
  });

  it('has no unclassified reader and no stale entry, and each class holds', () => {
    const { unclassified, stale, wrong } = judgeReaders(found, REGISTRY);
    expect({ unclassified, stale, wrong }).toEqual({ unclassified: [], stale: [], wrong: [] });
  });

  it('every entry says why, and the pending ones name who adopts them', () => {
    for (const [key, entry] of Object.entries(REGISTRY)) {
      expect(entry.why.length, key).toBeGreaterThan(15);
      if (entry.class === 'pending') expect(entry.pr, key).toBeTruthy();
    }
  });

  it('PLANT: a reader removed from the registry is reported (and put back, it is not)', () => {
    const victim = 'frontend/src/pages/CoachesPage.jsx';
    const without = { ...REGISTRY };
    delete without[victim];
    expect(judgeReaders(found, without).unclassified).toEqual([victim]);
    expect(judgeReaders(found, REGISTRY).unclassified).toEqual([]);
  });

  it('PLANT: an exclusion taken out of a reader is reported', () => {
    const key = 'frontend/src/hooks/usePracticeCapacityDemand.js';
    const reader = /** @type {any} */ (found.get(key));
    const planted = new Map(found);
    planted.set(key, { ...reader, source: reader.source.replace(JS_EXCLUSION, '') });
    expect(judgeReaders(planted, REGISTRY).wrong).toEqual([
      `${key}: classed exclude but does not exclude is_external`,
    ]);
    const sqlKey = 'sql:view:view_org_metrics';
    const view = /** @type {any} */ (found.get(sqlKey));
    const plantedSql = new Map(found);
    plantedSql.set(sqlKey, {
      ...view,
      text: view.text.replace(/is_external/g, 'is_something_else'),
    });
    expect(judgeReaders(plantedSql, REGISTRY).wrong).toEqual([
      `${sqlKey}: classed exclude but does not exclude is_external`,
    ]);
  });
});

describe('the scanners find each kind of read, and only reads', () => {
  it('finds a read of each JS kind', () => {
    expect(jsTeamReads("supabase.from('teams').select('id')")).toEqual(['from']);
    expect(jsTeamReads("const n = await countRows('teams');")).toEqual(['helper']);
    expect(jsTeamReads("['teams', 'teams', 'id, name']")).toEqual(['tuple']);
    expect(jsTeamReads("'id, team:teams(id, name), other'")).toEqual(['embed']);
    expect(jsTeamReads("'id, teams!inner(divisions!inner(season_settings_id))'")).toEqual([
      'embed',
    ]);
  });

  it('does not find a comment, a longer name, or another table', () => {
    expect(jsTeamReads("// supabase.from('teams')\n/* countRows('teams') */")).toEqual([]);
    expect(jsTeamReads("supabase.from('teams_archive').select('id')")).toEqual([]);
    expect(jsTeamReads("supabase.from('team_players').select('id')")).toEqual([]);
    expect(jsTeamReads("const label = plural(n, 'team', 'teams');")).toEqual([]);
  });

  it('finds SQL readers by their latest definition only', () => {
    const files = [
      {
        name: '1.sql',
        sql: 'CREATE FUNCTION public.a() RETURNS int AS $$ SELECT count(*) FROM public.teams $$;\nCREATE VIEW public.v AS SELECT 1 FROM public.teams t;',
      },
      {
        name: '2.sql',
        sql: 'CREATE OR REPLACE FUNCTION public.a() RETURNS int AS $$ SELECT 1 $$;',
      },
      { name: '3.sql', sql: 'DROP VIEW public.v;' },
    ];
    expect([...sqlTeamReaders(latestSqlDefinitions(files)).keys()]).toEqual([]);
    const kept = [
      ...files.slice(0, 1),
      {
        name: '2.sql',
        sql: 'CREATE OR REPLACE FUNCTION public.a() RETURNS int AS $$ SELECT count(*) FROM teams $$;',
      },
    ];
    expect([...sqlTeamReaders(latestSqlDefinitions(kept)).keys()].sort()).toEqual([
      'sql:fn:a',
      'sql:view:v',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What the classes promise
// ---------------------------------------------------------------------------------------------------------------

const DIVISION = 'div-1';
/** A minimal PostgREST double: chainable, thenable, applying `eq` and `neq` to the rows it holds. */
function fakeClient(tables, calls = []) {
  return {
    from(table) {
      let rows = [...(tables[table] ?? [])];
      calls.push(table);
      const builder = {
        select: () => builder,
        eq: (column, value) => {
          rows = rows.filter((row) => String(row[column]) === String(value));
          return builder;
        },
        neq: (column, value) => {
          rows = rows.filter((row) => String(row[column]) !== String(value));
          return builder;
        },
        is: () => builder,
        in: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        range: (from, to) => {
          rows = rows.slice(from, to + 1);
          return builder;
        },
        then: (resolve) => resolve({ data: rows, error: null }),
      };
      return builder;
    },
  };
}

describe('exclude: the capacity panel leaves an outside club out of the demand (decision 5, item 5)', () => {
  const tables = {
    divisions: [
      {
        id: DIVISION,
        organization_id: 'org',
        season_settings_id: 'season',
        name: 'U10',
        practices_per_week: 2,
      },
    ],
    teams: [
      {
        id: 'own-1',
        organization_id: 'org',
        division_id: DIVISION,
        name: 'Lions',
        is_external: false,
      },
      { id: 'own-2', organization_id: 'org', division_id: DIVISION, name: 'Tigers' },
      {
        id: 'club-1',
        organization_id: 'org',
        division_id: DIVISION,
        name: 'Visiting Club A',
        is_external: true,
      },
    ],
    practice_slots: [],
    practice_assignments: [],
  };

  it("reads the organization's own teams and not the outside club", async () => {
    const read = await loadPracticeCapacityRows(fakeClient(tables), {
      organizationId: 'org',
      seasonSettingsId: 'season',
    });
    expect(read.ok).toBe(true);
    if (read.ok !== true) return;
    expect(read.rows.teams.map((team) => team.id).sort()).toEqual(['own-1', 'own-2']);
  });

  it('CONTROL: without the filter the same client returns the outside club (so the test can fail)', async () => {
    const client = fakeClient(tables);
    const all = await client.from('teams').select('id, division_id').eq('organization_id', 'org');
    expect(all.data.map((team) => team.id)).toContain('club-1');
  });
});

describe('include: the reports show an outside club as a side of a game, and the coach schedule has no coach for it', () => {
  const teams = [
    { id: 'own-1', name: 'Lions', division: 'U10' },
    { id: 'club-1', name: 'Visiting Club A', division: 'U10', is_external: true },
  ];
  const fields = [{ id: 'f1', name: 'Field 1', venueId: 'v1' }];
  const venues = [{ id: 'v1', name: 'Park One' }];
  const games = [
    {
      id: 'g1',
      homeTeamId: 'own-1',
      awayTeamId: 'club-1',
      fieldId: 'f1',
      division: 'U10',
      weekIndex: 1,
      start: '2026-05-02T16:00:00Z',
      end: '2026-05-02T17:00:00Z',
    },
  ];

  it('the Day Sheet names the outside club (and says unknown for a team it was not given)', () => {
    const sheet = buildDaySheet({
      games,
      teams,
      fields,
      venues,
      timeZone: 'America/Los_Angeles',
      date: '2026-05-02',
    });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0].Away).toBe('Visiting Club A');
    const dropped = buildDaySheet({
      games,
      teams: teams.filter((t) => !t.is_external),
      fields,
      venues,
      timeZone: 'America/Los_Angeles',
      date: '2026-05-02',
    });
    expect(dropped.rows[0].Away).toBe('Unknown team (club-1)');
  });

  it("the coach schedule lists the coach's own games and has no coach for the outside club", () => {
    const schedule = buildCoachSchedule({
      coachId: 'coach-1',
      coaches: [{ id: 'coach-1', name: 'CoachFirst1 CoachLast1' }],
      teams,
      assignments: [
        {
          coach_id: 'coach-1',
          team_id: 'own-1',
          role: 'head',
          effective_from: '2026-01-01',
          effective_to: null,
        },
      ],
      asOf: '2026-05-01',
      games,
      fields,
      venues,
      timeZone: 'America/Los_Angeles',
    });
    expect(JSON.stringify(schedule)).toContain('Visiting Club A');
    expect(JSON.stringify(schedule)).not.toContain('coach-2');
    const directory = schedule.directory ?? null;
    if (directory)
      expect(directory.coaches.flatMap((c) => c.teams.map((t) => t.id))).not.toContain('club-1');
  });
});

describe('not applicable: an outside club in two games at once is legal', () => {
  const game = (key, start, end, home, away) => ({
    key,
    weekIndex: 1,
    division: 'd1',
    fieldId: `f-${key}`,
    start,
    end,
    homeTeamId: home,
    awayTeamId: away,
  });
  const teams = [
    { id: 'own-1', division: 'd1', coachIds: [] },
    { id: 'own-2', division: 'd1', coachIds: [] },
    { id: 'club-1', division: 'd1', isExternal: true },
  ];
  const overlapping = [
    game('a', '2026-05-02T09:00:00-07:00', '2026-05-02T10:00:00-07:00', 'own-1', 'club-1'),
    game('b', '2026-05-02T09:30:00-07:00', '2026-05-02T10:30:00-07:00', 'own-2', 'club-1'),
  ];

  it('the audit does not call an outside club double-booked', () => {
    const report = auditSchedule({ games: overlapping, teams });
    expect(report.counts['team-double-booked']).toBe(0);
  });

  it('CONTROL: an own team in the same two games at once is called double-booked', () => {
    const same = [
      game('a', '2026-05-02T09:00:00-07:00', '2026-05-02T10:00:00-07:00', 'own-1', 'club-1'),
      game('b', '2026-05-02T09:30:00-07:00', '2026-05-02T10:30:00-07:00', 'own-1', 'own-2'),
    ];
    expect(auditSchedule({ games: same, teams }).counts['team-double-booked']).toBe(1);
  });
});

describe('standings: deferred to the F11 plan, and nothing feeds an outside club into them today', () => {
  const files = migrationFiles();
  const latest = latestSqlDefinitions(files);

  it('the standings view is not rebuilt by this change and still reads the legacy games table', () => {
    const view = latest.get('sql:view:view_league_standings');
    expect(view, 'the view exists').toBeTruthy();
    expect(view?.file.startsWith('20261023010000')).toBe(true);
    expect(view?.text).toMatch(/\bgame_results\b|\bgames\b/);
    expect(view?.text).not.toMatch(/\bis_external\b/);
  });

  it('no function of the import writes a score, a legacy game or a result', () => {
    for (const name of [
      'apply_game_import_job',
      'rollback_game_import_job',
      'map_game_import_job',
      'ensure_game_slot',
    ]) {
      const body = latest.get(`sql:fn:${name}`)?.text ?? '';
      expect(body.length, `${name} exists`).toBeGreaterThan(200);
      expect(body, name).not.toMatch(
        /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:games|game_results)\b/i
      );
      expect(body, name).not.toMatch(/\bscore_(?:home|away)\b|update_game_score/i);
    }
  });

  it('CONTROL: the scan would find such a write (a planted body is caught)', () => {
    const planted =
      'CREATE FUNCTION public.apply_game_import_job() RETURNS void AS $$ UPDATE public.games SET score_home = 1 $$;';
    expect(planted).toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:games|game_results)\b/i
    );
  });
});
