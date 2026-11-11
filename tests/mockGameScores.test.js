/**
 * The mock's score record, held rule and standings (`frontend/src/lib/mockGameScores.js`, `mockGamePublished.js`,
 * `mockGameIdentity.js`) held to the database's own table, `supabase/tests/game_scores.sql`, by the NUMBERS AND WORDS
 * that file asserts (LESSONS_LEARNED 77 and 102: a twin is held by what the original asserts). Plan
 * `docs/changes/2026-11-06-games-table-source-of-truth.md`, F11-2, task B2.
 *
 * Each expectation below is first required to be text of the pgTAP file (so an edit there that the mock does not
 * follow fails here), then required of the mock over the same league: T3 beat T4 3-1, T5 drew T6 1-1, T1 beat an
 * outside club 2-0, and two outside clubs played each other.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHeld } from '../packages/core/src/gameIdentity.js';
import {
  mockGameHeldIds,
  mockGameIsHeld,
  mockPersistGameSchedule,
} from '../frontend/src/lib/mockGameIdentity.js';
import {
  isRowScored,
  mockGameHoldCode,
  publishedRpcRefusal,
  publishedWriteRefusal,
} from '../frontend/src/lib/mockGamePublished.js';
import {
  computeScoredStandings,
  deriveCurrentGameRuns,
  deriveLeagueStandings,
  isSavedGame,
  mockUpdateSavedGameScore,
} from '../frontend/src/lib/mockGameScores.js';
import { scheduleWriteRefusal } from '../frontend/src/lib/mockSeasons.js';

const PGTAP = readFileSync(path.join(process.cwd(), 'supabase/tests/game_scores.sql'), 'utf8');
/** The pgTAP file asserts this text: an expectation that is not in it is this file's invention, and fails. */
const inPgtap = (text) => {
  expect(PGTAP.includes(text), `supabase/tests/game_scores.sql asserts ${text}`).toBe(true);
  return text;
};

const ORG = 'a1111111-1111-1111-1111-111111111111';
const ORG_B = 'b2222222-2222-2222-2222-222222222222';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const SEASON = 'a1111111-1111-1111-1111-111111111aaa';
const DONE = 'a1111111-1111-1111-1111-1111111100c1';
const DIV = 'a1111111-1111-1111-1111-11111111abcd';
const DIV_DONE = 'a1111111-1111-1111-1111-1111111d00c1';
const t = (n) => `a1111111-1111-1111-1111-0000000d00${n}`;
const e = (n) => `a1111111-1111-1111-1111-0000000d0e${n}`;
const d = (n) => `a1111111-1111-1111-1111-0000000d00d${n}`;
const RUN1 = 'a1111111-1111-1111-1111-0000000d0a01';

function world() {
  const slot = (n, week, hour) => ({
    id: d(n),
    organization_id: ORG,
    field_id: 'f1',
    division_id: DIV,
    week_index: week,
    start: `2026-04-${String(4 + (week - 1) * 7).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`,
    end: `2026-04-${String(4 + (week - 1) * 7).padStart(2, '0')}T${String(hour + 1).padStart(2, '0')}:00:00Z`,
  });
  const slots = [
    slot(1, 1, 8),
    slot(2, 1, 10),
    slot(3, 1, 12),
    slot(5, 2, 8),
    slot(8, 2, 10),
    slot(9, 3, 8),
    slot('a', 4, 8),
  ];
  const game = (n, home, away, slotN, published = false) => {
    const s = slots.find((x) => x.id === d(slotN));
    return {
      id: e(n),
      organization_id: ORG,
      run_id: RUN1,
      game_slot_id: s.id,
      slot_id: s.id,
      field_id: s.field_id,
      home_team_id: t(home),
      away_team_id: t(away),
      division: 'Org A U10',
      week_index: s.week_index,
      start: s.start,
      end: s.end,
      assignment_source: 'auto',
      published,
      season_settings_id: SEASON,
    };
  };
  const team = (n, name, extra = {}) => ({
    id: t(n),
    organization_id: ORG,
    division_id: DIV,
    name,
    ...extra,
  });
  return /** @type {any} */ ({
    organizations: [
      { id: ORG, feature_flags: { score_entry: true } },
      { id: ORG_B, feature_flags: { score_entry: true } },
    ],
    organization_members: [{ organization_id: ORG, profile_id: ADMIN, role: 'admin' }],
    season_settings: [
      { id: SEASON, organization_id: ORG, status: 'active' },
      { id: DONE, organization_id: ORG, status: 'completed' },
    ],
    divisions: [
      { id: DIV, organization_id: ORG, season_settings_id: SEASON, name: 'Org A U10' },
      { id: DIV_DONE, organization_id: ORG, season_settings_id: DONE, name: 'C U10' },
    ],
    teams: [
      team('01', 'Id One'),
      team('02', 'Id Two'),
      team('03', 'Id Three'),
      team('04', 'Id Four'),
      team('05', 'Id Five'),
      team('06', 'Id Six'),
      team('07', 'Id Seven', { division_id: DIV_DONE }),
      team('08', 'Id Eight', { division_id: DIV_DONE }),
      team('e1', 'Outside One', { is_external: true }),
      team('e2', 'Outside Two', { is_external: true }),
    ],
    game_slots: slots,
    scheduler_runs: [
      {
        id: 'a1111111-1111-1111-1111-0000000d0a00',
        organization_id: ORG,
        season_settings_id: SEASON,
        season_id: SEASON,
        run_type: 'game',
        status: 'completed',
        completed_at: '2026-03-01T00:00:00Z',
      },
      {
        id: RUN1,
        organization_id: ORG,
        season_settings_id: SEASON,
        season_id: SEASON,
        run_type: 'game',
        status: 'completed',
        completed_at: '2026-03-02T00:00:00Z',
      },
    ],
    game_assignments: [
      game('01', '01', '02', 1, true),
      game('02', '03', '04', 2),
      game('03', '01', '03', 5),
      game('05', '05', '06', 3),
      game('0a', '01', 'e1', 9),
      game('0b', 'e1', 'e2', 'a'),
      { ...game('09', '07', '08', 1), run_id: null, season_settings_id: DONE, division: 'C U10' },
      {
        id: 'b2222222-2222-2222-2222-0000000d0e01',
        organization_id: ORG_B,
        home_team_id: 'bx',
        away_team_id: 'by',
      },
    ],
    game_scores: [],
    games: [{ id: 'legacy-1', organization_id: ORG }],
    audit_log: [],
  });
}

const ctxOf = (db, user = ADMIN) => ({
  currentUserId: user,
  isOrgAdmin: (org) =>
    db.organization_members.some(
      (m) => m.organization_id === org && m.profile_id === user && m.role === 'admin'
    ),
  isOrgMember: (org) =>
    db.organization_members.some((m) => m.organization_id === org && m.profile_id === user),
  seasonRefusal: (rows) => scheduleWriteRefusal(db, 'game_scores', rows),
});
/** update_game_score through the mock, said the way the pgTAP file's `pg_temp.score` says it. */
function score(db, game, home, away, { org = ORG, user = ADMIN } = {}) {
  const { data, error } = mockUpdateSavedGameScore(
    db,
    { p_organization_id: org, p_game_id: game, p_score_home: home, p_score_away: away },
    ctxOf(db, user)
  );
  if (error) return `${error.code}:${error.details ?? ''}`;
  const show = (v) => (v === null ? '-' : String(v));
  return `${show(data.score_home)}-${show(data.score_away)} changed=${data.changed} was=${show(data.previous_score_home)}-${show(data.previous_score_away)}`;
}
const stored = (db, game) => {
  const row = db.game_scores.find((s) => s.game_id === game);
  return row
    ? `${row.score_home}-${row.score_away} by ${String(row.updated_by).slice(-4)}`
    : 'none';
};
const standing = (db, team) => {
  const r = deriveLeagueStandings(db).find((row) => row.team_id === team);
  return r
    ? `${r.games_played} ${r.wins}-${r.losses}-${r.draws} ${r.goals_for}:${r.goals_against} ${r.points} nc=${r.results_not_counted}`
    : 'no row';
};
const item = (db, n, over = {}) => {
  const g = db.game_assignments.find((row) => row.id === e(n));
  return {
    id: g.id,
    home_team_id: g.home_team_id,
    away_team_id: g.away_team_id,
    game_slot_id: g.game_slot_id,
    field_id: g.field_id,
    week_index: g.week_index,
    start: g.start,
    end: g.end,
    source: 'auto',
    ...over,
  };
};
const VISIBLE = ['01', '02', '03', '05', '0a', '0b'];
const save = (db, { skip = [], over = {} } = {}) => {
  const res = mockPersistGameSchedule(
    db,
    { organization_id: ORG, season_settings_id: SEASON, run_type: 'game', status: 'completed' },
    VISIBLE.filter((n) => !skip.includes(n)).map((n) => item(db, n, over[n] ?? {})),
    {
      currentUserId: ADMIN,
      isOrgAdmin: (org) => org === ORG,
      now: new Date('2026-11-11T00:00:00Z'),
    }
  );
  return res.error ? `${res.error.code}:${res.error.details ?? ''}` : 'no error';
};
const moved = (db, slotN) => {
  const s = db.game_slots.find((x) => x.id === d(slotN));
  return { game_slot_id: s.id, week_index: s.week_index, start: s.start, end: s.end };
};

describe('mock update_game_score for a saved game :: the answers the database gives', () => {
  it('enters, repeats, edits, refuses one side, clears, and audits only a change', () => {
    const db = world();
    expect(stored(db, e('02'))).toBe('none');
    expect(score(db, e('02'), 3, 1)).toBe(inPgtap('3-1 changed=true was=---'));
    expect(stored(db, e('02'))).toBe(inPgtap('3-1 by 1111'));
    expect(score(db, e('02'), 3, 1)).toBe(inPgtap('3-1 changed=false was=3-1'));
    expect(db.audit_log.filter((a) => a.action === 'competition.score_updated')).toHaveLength(1);
    expect(score(db, e('02'), 2, 2)).toBe(inPgtap('2-2 changed=true was=3-1'));
    expect(db.game_scores).toHaveLength(1);
    expect(score(db, e('02'), 2, null)).toBe(inPgtap('22023:score_one_sided'));
    expect(score(db, e('02'), null, 0)).toBe('22023:score_one_sided');
    expect(stored(db, e('02'))).toBe(inPgtap('2-2 by 1111'));
    expect(score(db, e('02'), -1, 0)).toBe(inPgtap('23514:'));
    expect(score(db, e('02'), null, null)).toBe(inPgtap('--- changed=true was=2-2'));
    expect(stored(db, e('02'))).toBe('none');
    expect(db.audit_log.filter((a) => a.resource_id === e('02'))).toHaveLength(3);
    expect(score(db, e('02'), null, null)).toBe(inPgtap('--- changed=false was=---'));
    expect(db.audit_log.at(-1).metadata).toMatchObject({
      game_id: e('02'),
      previous_score_home: 2,
      previous_score_away: 2,
      score_home: null,
      home_team_id: t('03'),
      away_team_id: t('04'),
    });
  });

  it('refuses whom and what the database refuses, writing nothing', () => {
    const db = world();
    expect(score(db, 'b2222222-2222-2222-2222-0000000d0e01', 1, 0)).toBe(inPgtap('42501:'));
    expect(score(db, 'no-such-game', 1, 0)).toBe('42501:');
    expect(score(db, e('09'), 1, 0)).toBe(inPgtap('22023:season_completed'));
    db.organizations[0].feature_flags = {};
    expect(score(db, e('02'), 1, 0)).toBe(inPgtap('55000:'));
    db.organizations[0].feature_flags = { score_entry: true };
    expect(score(db, e('02'), 1, 0, { user: '33333333-3333-3333-3333-333333333333' })).toBe(
      '42501:'
    );
    expect(db.game_scores).toEqual([]);
    expect(db.audit_log).toEqual([]);
  });

  it('DECLARED: the legacy arm is reached only by an id that names no saved game', () => {
    const db = world();
    expect(isSavedGame(db, e('02'))).toBe(true);
    expect(isSavedGame(db, 'legacy-1')).toBe(false);
    // The database's answer for a legacy id, which the saved-game arm gives too when asked directly.
    expect(score(db, 'legacy-1', 1, 0)).toBe('42501:');
  });
});

describe("the held rule :: Published or scored, one predicate, in the database's words", () => {
  it('a scored game is held, and core, the row predicate and the set form agree', () => {
    const db = world();
    expect(mockGameIsHeld(db, e('02'))).toBe(false);
    score(db, e('02'), 3, 1);
    const row = db.game_assignments.find((g) => g.id === e('02'));
    expect(mockGameIsHeld(db, e('02'))).toBe(true);
    expect(isHeld(row, isRowScored(row, db))).toBe(true);
    expect(isHeld(row, false)).toBe(false);
    expect(
      mockGameHeldIds(db, [e('01'), e('02'), e('03')])
        .map((id) => id.slice(-4))
        .join(',')
    ).toBe(inPgtap('0e01,0e02'));
    expect(
      [e('01'), e('02'), e('03')]
        .map(
          (id) =>
            mockGameHoldCode(
              db.game_assignments.find((g) => g.id === id),
              db
            ) ?? 'null'
        )
        .join(' ')
    ).toBe(inPgtap('game_published game_scored null'));
  });

  it('moved, flipped, cancelled, deleted, left out: refused for the scored game, allowed for its twin', () => {
    const db = world();
    score(db, e('02'), 3, 1);
    const frozen = JSON.stringify(db.game_assignments);
    expect(save(db, { over: { '02': moved(db, 8) } })).toBe(inPgtap('22023:game_scored'));
    expect(save(db, { over: { '02': { home_team_id: t('04'), away_team_id: t('03') } } })).toBe(
      '22023:game_scored'
    );
    expect(save(db, { skip: ['02'] })).toBe(
      inPgtap('22023:game_scored_omitted count=1 ids=a1111111-1111-1111-1111-0000000d0e02')
    );
    expect(save(db, { skip: ['01'] })).toBe(
      inPgtap('22023:game_published_omitted count=1 ids=a1111111-1111-1111-1111-0000000d0e01')
    );
    expect(save(db, { skip: ['01', '02'] })).toBe(
      '22023:game_published_omitted count=1 ids=a1111111-1111-1111-1111-0000000d0e01'
    );
    expect(JSON.stringify(db.game_assignments)).toBe(frozen);
    const cancel = publishedRpcRefusal(db, { kind: 'cancel', id: e('02') });
    expect(cancel.error.details).toBe('game_scored');
    expect(cancel.error.message).toBe(
      inPgtap(
        'game a1111111-1111-1111-1111-0000000d0e02 has a score and cannot be cancelled: clear its score first'
      )
    );
    expect(publishedRpcRefusal(db, { kind: 'cancel', id: e('01') }).error.details).toBe(
      'game_published'
    );
    expect(publishedRpcRefusal(db, { kind: 'cancel', id: e('03') })).toBe(null);
    const scoredRow = db.game_assignments.find((g) => g.id === e('02'));
    const del = publishedWriteRefusal('game_assignments', [{ before: scoredRow, after: null }], db);
    expect(del.error.details).toBe('game_scored');
    const move = publishedWriteRefusal(
      'game_assignments',
      [{ before: scoredRow, after: { ...scoredRow, week_index: 9 } }],
      db
    );
    expect(move.error.message).toBe(
      inPgtap(
        'Game a1111111-1111-1111-1111-0000000d0e02 has a score and cannot be moved: clear its score first'
      )
    );
    // The twin, and the hold lifted by clearing.
    expect(save(structuredClone(db), { skip: ['03'] })).toBe('no error');
    score(db, e('02'), null, null);
    expect(publishedRpcRefusal(db, { kind: 'cancel', id: e('02') })).toBe(null);
  });

  it('a score survives a save that moves the unscored games around it', () => {
    const db = world();
    score(db, e('02'), 3, 1);
    expect(save(db, { over: { '03': moved(db, 8) } })).toBe('no error');
    expect(stored(db, e('02'))).toBe('3-1 by 1111');
    const kept = db.game_assignments.find((g) => g.id === e('02'));
    expect(kept.game_slot_id).toBe(d(2));
    expect(db.game_assignments.find((g) => g.id === e('03')).game_slot_id).toBe(d(8));
    expect(deriveCurrentGameRuns(db).find((r) => r.season_settings_id === SEASON).run_id).toBe(
      kept.run_id
    );
    expect(db.game_scores).toHaveLength(1);
  });

  it('delete team (D5): refused for a Published game, not for a game held only by its score', () => {
    const db = world();
    score(db, e('05'), 1, 1);
    expect(publishedRpcRefusal(db, { kind: 'team', id: t('01') }).error.details).toBe(
      'game_published'
    );
    expect(publishedRpcRefusal(db, { kind: 'team', id: t('06') })).toBe(null);
  });
});

describe('standings :: the rows the view computes', () => {
  function league() {
    const db = world();
    score(db, e('02'), 3, 1);
    score(db, e('0a'), 2, 0);
    score(db, e('0b'), 5, 0);
    score(db, e('05'), 1, 1);
    return db;
  }

  it('own teams only; an outside result is not counted until the organization says so', () => {
    const db = league();
    expect(standing(db, t('03'))).toBe(inPgtap('1 1-0-0 3:1 3 nc=0'));
    expect(standing(db, t('04'))).toBe(inPgtap('1 0-1-0 1:3 0 nc=0'));
    expect(`${standing(db, t('05'))} / ${standing(db, t('06'))}`).toBe(
      inPgtap('1 0-0-1 1:1 1 nc=0 / 1 0-0-1 1:1 1 nc=0')
    );
    expect(`${standing(db, t('e1'))} / ${standing(db, t('e2'))}`).toBe(inPgtap('no row / no row'));
    expect(standing(db, t('01'))).toBe(inPgtap('0 0-0-0 0:0 0 nc=1'));
    db.organizations[0].feature_flags.standings_count_outside_results = true;
    expect(standing(db, t('01'))).toBe(inPgtap('1 1-0-0 2:0 3 nc=0'));
    expect(standing(db, t('e1'))).toBe('no row');
    expect(standing(db, t('03'))).toBe('1 1-0-0 3:1 3 nc=0');
    const rows = computeScoredStandings(db);
    expect(
      `${rows.reduce((n, r) => n + r.games_played, 0)} ${rows.reduce((n, r) => n + r.results_not_counted, 0)}`
    ).toBe(inPgtap("'5 0'").slice(1, -1));
  });

  it('only a boolean true turns the setting on (org_flag reads nothing else)', () => {
    const db = league();
    db.organizations[0].feature_flags.standings_count_outside_results = 'true';
    expect(standing(db, t('01'))).toBe('0 0-0-0 0:0 0 nc=1');
  });

  it("the columns are the view's, in its order", () => {
    const columns = Object.keys(computeScoredStandings(league())[0]).join(',');
    expect(columns).toBe(
      inPgtap(
        'team_id,organization_id,team_name,division_id,games_played,wins,losses,draws,goals_for,goals_against,goal_differential,points,division,season_settings_id,results_not_counted'
      )
    );
  });

  it('DECLARED: a stored row stands for a team with no result in game_scores, and never for an outside club', () => {
    const db = league();
    db.view_league_standings = [
      { team_id: t('02'), team_name: 'Id Two', wins: 7, points: 21 },
      { team_id: t('03'), team_name: 'stale', wins: 9, points: 27 },
      { team_id: t('e1'), team_name: 'Outside One', wins: 1, points: 3 },
    ];
    const rows = deriveLeagueStandings(db);
    expect(rows.find((r) => r.team_id === t('02'))).toMatchObject({
      wins: 7,
      results_not_counted: 0,
    });
    expect(rows.find((r) => r.team_id === t('03')).wins).toBe(1);
    expect(rows.some((r) => r.team_id === t('e1'))).toBe(false);
  });
});

describe('current_game_runs :: the rule of useSchedulerRun', () => {
  it('the latest completed game run of the season; not a failed, practice or seasonless one', () => {
    const db = world();
    db.season_settings.push({ id: 'season-d', organization_id: ORG, status: 'draft' });
    db.scheduler_runs.push(
      {
        id: 'r-failed',
        organization_id: ORG,
        season_settings_id: SEASON,
        run_type: 'game',
        status: 'failed',
        completed_at: '2099-01-01T00:00:00Z',
      },
      {
        id: 'r-practice',
        organization_id: ORG,
        season_settings_id: SEASON,
        run_type: 'practice',
        status: 'completed',
        completed_at: '2099-01-02T00:00:00Z',
      },
      {
        id: 'r-noseason',
        organization_id: ORG,
        season_settings_id: null,
        season_id: null,
        run_type: 'game',
        status: 'completed',
        completed_at: '2099-01-03T00:00:00Z',
      },
      {
        id: 'r-old-column',
        organization_id: ORG,
        season_settings_id: null,
        season_id: 'season-d',
        run_type: 'game',
        status: 'completed',
        completed_at: '2026-01-01T00:00:00Z',
      }
    );
    const runs = deriveCurrentGameRuns(db);
    expect(runs.filter((r) => r.season_settings_id === SEASON)).toEqual([
      {
        organization_id: ORG,
        season_settings_id: SEASON,
        run_id: RUN1,
        completed_at: '2026-03-02T00:00:00Z',
      },
    ]);
    expect(runs.find((r) => r.season_settings_id === 'season-d').run_id).toBe('r-old-column');
    expect(runs.some((r) => r.season_settings_id === DONE)).toBe(false);
  });
});
