/**
 * Every mock path that deletes or replaces a saved game, against a game that has a score (Codex on #725, P2, and its
 * siblings). The database refuses each (the guard, the save's omission check, the rollback's "changed since", or
 * the foreign key from a score to its game), or takes the score with the game on purpose (delete team, F11 decision
 * D5). A mock path that deleted the game and left its row of `game_scores` behind would leave a result the computed
 * standings keep counting for a game that is gone.
 *
 * Through the real mock client (`mockSupabase.rpc` and its table writes). Each path has the scored game beside an
 * unscored control, and after every call the invariant is read from the tables: no score names a game that is gone.
 * The database's words are text of `supabase/tests/game_scores.sql`.
 *
 * The paths, and where each is held:
 *   - the game save (a move, a flip, an omission): `tests/mockGameScores.test.js`;
 *   - the import's rollback and its apply (a changed row, and so a take-out, is skipped): `tests/mockGameImport.test.js`;
 *   - cancel, a direct delete, a direct move, delete team, a confirmed field delete: here.
 * NOT mirrored, on purpose, and said in `mockGamePublished.js`: the field-import rollback and the removal of a slot
 * delete or null a game's field without asking the guard, for a Published game as for a scored one (no screen that
 * shows a schedule offers them; the database refuses both at the cascade). The demo reset is not a deleter of this
 * kind: `start_demo_session` makes a new organization and removes none.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';
import { mockSupabase as supabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';

const PGTAP = readFileSync(path.join(process.cwd(), 'supabase/tests/game_scores.sql'), 'utf8');
const inPgtap = (text) => {
  expect(PGTAP.includes(text), `supabase/tests/game_scores.sql asserts ${text}`).toBe(true);
  return text;
};

const ORG = 'org-deleters';
const ADMIN = 'mock-admin-id';
const SCORED = 'g-scored';
const PLAIN = 'g-plain';

const game = (id, home, away, slot, field) => ({
  id,
  organization_id: ORG,
  run_id: 'run-1',
  game_slot_id: slot,
  slot_id: slot,
  field_id: field,
  home_team_id: home,
  away_team_id: away,
  week_index: 1,
  start: '2026-04-04T08:00:00Z',
  end: '2026-04-04T09:00:00Z',
  published: false,
});

async function seed() {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  seedMockDb({
    organizations: [{ id: ORG, name: 'Synthetic FC', feature_flags: { score_entry: true } }],
    organization_members: [{ organization_id: ORG, profile_id: ADMIN, role: 'admin' }],
    season_settings: [{ id: 'season-1', organization_id: ORG, status: 'active' }],
    divisions: [{ id: 'div-1', organization_id: ORG, season_settings_id: 'season-1', name: 'U10' }],
    teams: ['t-1', 't-2', 't-3', 't-4'].map((id) => ({
      id,
      organization_id: ORG,
      division_id: 'div-1',
      name: id,
    })),
    locations: [{ id: 'loc-1', organization_id: ORG, name: 'Park', effective_to: null }],
    fields: [
      { id: 'f-scored', organization_id: ORG, location_id: 'loc-1', name: 'Field A', active: true },
      { id: 'f-plain', organization_id: ORG, location_id: 'loc-1', name: 'Field B', active: true },
    ],
    game_slots: [
      { id: 's-scored', organization_id: ORG, field_id: 'f-scored', week_index: 1 },
      { id: 's-plain', organization_id: ORG, field_id: 'f-plain', week_index: 1 },
    ],
    scheduler_runs: [
      {
        id: 'run-1',
        organization_id: ORG,
        season_settings_id: 'season-1',
        run_type: 'game',
        status: 'completed',
        completed_at: '2026-03-01T00:00:00Z',
      },
    ],
    game_assignments: [
      game(SCORED, 't-1', 't-2', 's-scored', 'f-scored'),
      game(PLAIN, 't-3', 't-4', 's-plain', 'f-plain'),
    ],
    game_scores: [],
    audit_log: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: ADMIN } }));
  const { error } = await supabase.rpc('update_game_score', {
    p_organization_id: ORG,
    p_game_id: SCORED,
    p_score_home: 2,
    p_score_away: 1,
  });
  expect(error, 'the score is entered through the RPC').toBe(null);
}

const said = (answer) =>
  answer?.error ? `${answer.error.code}:${answer.error.details ?? ''}` : 'no error';
const gameIds = () =>
  getMockData('game_assignments')
    .filter((g) => g.organization_id === ORG)
    .map((g) => g.id)
    .sort();
/** The invariant: every score names a game that stands. */
const orphans = () => {
  const ids = new Set(getMockData('game_assignments').map((g) => String(g.id)));
  return getMockData('game_scores').filter((row) => !ids.has(String(row.game_id)));
};

beforeEach(seed);

describe('a scored game is not removed or replaced by any mock path, and no score is left behind', () => {
  it('cancel: refused in the words of a scored game; the unscored twin is cancelled', async () => {
    expect(
      said(await supabase.rpc('admin_cancel_game_assignment', { p_assignment_id: SCORED }))
    ).toBe(inPgtap('22023:game_scored'));
    expect(
      said(await supabase.rpc('admin_cancel_game_assignment', { p_assignment_id: PLAIN }))
    ).toBe('no error');
    expect(gameIds()).toEqual([SCORED]);
    expect(orphans()).toEqual([]);
  });

  it('a direct delete and a direct move: refused by the guard; the twin goes', async () => {
    expect(said(await supabase.from('game_assignments').delete().eq('id', SCORED))).toBe(
      '22023:game_scored'
    );
    expect(
      said(await supabase.from('game_assignments').update({ week_index: 9 }).eq('id', SCORED))
    ).toBe('22023:game_scored');
    expect(said(await supabase.from('game_assignments').delete().eq('id', PLAIN))).toBe('no error');
    expect(gameIds()).toEqual([SCORED]);
    expect(getMockData('game_assignments').find((g) => g.id === SCORED).week_index).toBe(1);
    expect(orphans()).toEqual([]);
  });

  it("a confirmed field delete: refused at the cascade for the scored game's field, and nothing of the field is gone", async () => {
    const refused = await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: 'f-scored',
      p_confirm: true,
    });
    expect(said(refused)).toBe(inPgtap('22023:game_scored'));
    inPgtap(
      'a confirmed delete of a field with a scored game is refused by the guard at the cascade'
    );
    expect(getMockData('fields').some((f) => f.id === 'f-scored')).toBe(true);
    expect(getMockData('game_slots').some((s) => s.id === 's-scored')).toBe(true);
    expect(gameIds()).toEqual([PLAIN, SCORED].sort());
    expect(orphans()).toEqual([]);
    // CONTROL: the field of the unscored game is deleted, with its slot and its game.
    const done = await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: 'f-plain',
      p_confirm: true,
    });
    expect(done.error).toBe(null);
    expect(done.data.deleted).toBe(true);
    expect(gameIds()).toEqual([SCORED]);
    expect(orphans()).toEqual([]);
  });

  it('a confirmed field delete is refused for a Published game too (the same guard)', async () => {
    await supabase.rpc('admin_set_games_published', {
      p_organization_id: ORG,
      p_assignment_ids: [PLAIN],
      p_published: true,
    });
    expect(getMockData('game_assignments').find((g) => g.id === PLAIN).published).toBe(true);
    const refused = await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: 'f-plain',
      p_confirm: true,
    });
    expect(said(refused)).toBe('22023:game_published');
    expect(getMockData('fields').some((f) => f.id === 'f-plain')).toBe(true);
  });

  it('delete team (D5): the game goes with its team, and its score with it', async () => {
    expect(said(await supabase.rpc('admin_delete_team', { p_team_id: 't-2' }))).toBe('no error');
    expect(gameIds()).toEqual([PLAIN]);
    expect(getMockData('game_scores')).toEqual([]);
    expect(orphans()).toEqual([]);
    const audit = getMockData('audit_log').find((row) => row.action === 'team.deleted');
    expect(audit.metadata.game_scores_deleted).toBe(1);
  });
});
