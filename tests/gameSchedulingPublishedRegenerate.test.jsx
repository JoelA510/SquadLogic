/**
 * Regenerating the game schedule keeps the Published games exactly where they are (plan
 * `docs/changes/2026-11-03-schedule-expansion.md`, 3.5 and 3.7, PR 2 task B2).
 *
 * Driven through the real page, the real `useDashboardData` and the real mock client, with the
 * save stood in for so the games it would send can be read. Four teams play a round robin of three
 * weeks, six games saved in one run: in each week the first matchup is Published, on the last of
 * three slots (a fresh run never uses it: a week has two games), and the second is not, on the
 * middle one (a fresh run puts it on the first).
 *
 * What is held:
 *   - the three Published games come back with the id, slot and time they were saved with: their
 *     cards sit in the same cells under the same ids, and the games sent to the save carry the
 *     same (home, away, slot, week) tuple and the same instants (a Published game is sent with its own id and
 *     its own tuple, so the save keeps the row either way);
 *   - the games sent satisfy `publishedOmissions`, PR 1's oracle for what a save must not leave out;
 *   - the three that are not Published are generated again, as before (decision 14);
 *   - the control: with the same rows NOT Published (or from a database without the column, as
 *     production is until PR 1's migration lands) the page does what it always did, the three
 *     games move (each carrying its own id since 20261120010000, so the oracle names none; the
 *     tuples alone would name all three), and no sentence about kept games is shown.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishedOmissions } from '../packages/core/src/gamePublished.js';
import { buildDivisionRoundRobins } from '../packages/core/src/gameScheduling.js';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = '00000000-0000-4000-8000-0000000000e3';
const SEASON = 'season-pubregen';
const SAVED_RUN = '00000000-0000-4000-8000-0000000000d4';
const FIELD = 'field-pr1';

const ROSTER = vi.hoisted(() => [
  { id: 'team-1', name: 'Synthetic Comets', division: 'U10' },
  { id: 'team-2', name: 'Synthetic Rockets', division: 'U10' },
  { id: 'team-3', name: 'Synthetic Meteors', division: 'U10' },
  { id: 'team-4', name: 'Synthetic Planets', division: 'U10' },
]);
/** What the stubbed save does, per test. */
const SAVE = vi.hoisted(() => ({ impl: /** @type {any} */ (null) }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const value = {
    currentOrganization: { id: '00000000-0000-4000-8000-0000000000e3', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-pubregen', timezone: 'America/New_York' },
    featureFlags: {},
    permissions: perms[roles.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  };
  return { useOrganization: () => value };
});
vi.mock('../frontend/src/hooks/useTeamSummary.js', () => {
  const value = {
    summary: { teams: ROSTER },
    loading: false,
    error: null,
    status: 'completed',
    progress: 100,
    generatedAt: '2026-09-01',
  };
  return { useTeamSummary: () => value };
});
vi.mock('../frontend/src/hooks/usePracticeSummary.js', () => ({
  usePracticeSummary: () => ({
    practiceSummary: null,
    practiceReadinessSnapshot: null,
    generatedAt: null,
    loading: false,
    error: null,
    runId: null,
    refetch: () => {},
  }),
}));
vi.mock('../frontend/src/hooks/useCurrentPracticeSchedule.js', () => ({
  useCurrentPracticeSchedule: () => ({
    assignments: [],
    loading: false,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({
  useFieldClosures: () => ({ closures: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() },
}));
vi.mock('../frontend/src/utils/gamePersistenceClient.js', () => ({
  persistGameScheduleReview: (...args) => SAVE.impl(...args),
}));

const { default: GameSchedulingPage } =
  await import('../frontend/src/pages/GameSchedulingPage.jsx');

/** Three Saturdays; local 09:00, 11:00 and 13:00 (New York, EDT: 13:00Z, 15:00Z, 17:00Z). */
const SATURDAYS = ['2026-10-03', '2026-10-10', '2026-10-17'];
const LOCAL = [
  { start: '09:00:00', end: '10:00:00', utc: '13' },
  { start: '11:00:00', end: '12:00:00', utc: '15' },
  { start: '13:00:00', end: '14:00:00', utc: '17' },
];
const slotId = (week, index) => `gs-pr-${week}-${index}`;

const SLOTS = SATURDAYS.flatMap((date, w) =>
  LOCAL.map((time, index) => ({
    id: slotId(w + 1, index),
    organization_id: ORG,
    field_id: FIELD,
    slot_date: date,
    start_time: time.start,
    end_time: time.end,
    week_index: w + 1,
    capacity: 1,
  }))
);

/** The round robin the page will build for these four teams: the games saved are its own. */
const WEEKS = buildDivisionRoundRobins(
  ROSTER.map(({ id, name, division }) => ({ id, name, division }))
).roundRobinByDivision.U10;

/**
 * Six saved games. `published` is what the `published` column says: `true` for the first game of each
 * week, `false` for none, a list of ids for just those, or `'absent'` for no such column at all
 * (the database before the migration).
 */
function savedGames(published) {
  const rows = [];
  WEEKS.slice(0, 3).forEach((week, w) => {
    const date = SATURDAYS[w];
    week.matchups.slice(0, 2).forEach((matchup, m) => {
      const index = m === 0 ? 2 : 1;
      const time = LOCAL[index];
      const id = m === 0 ? `ga-pub-${w + 1}` : `ga-open-${w + 1}`;
      const flag = Array.isArray(published)
        ? published.includes(id)
        : published === true && m === 0;
      rows.push({
        id,
        run_id: SAVED_RUN,
        organization_id: ORG,
        division: 'U10',
        week_index: w + 1,
        slot_id: slotId(w + 1, index),
        game_slot_id: slotId(w + 1, index),
        field_id: FIELD,
        start: `${date}T${time.utc}:00:00+00:00`,
        end: `${date}T${String(Number(time.utc) + 1)}:00:00+00:00`,
        home_team_id: matchup.homeTeamId,
        away_team_id: matchup.awayTeamId,
        assignment_source: 'auto',
        ...(published === 'absent' ? {} : { published: flag }),
      });
    });
  });
  return rows;
}

/** The same six rows with the three Published ones flagged, for the oracle's `saved` side. */
const FLAGGED = savedGames(true);
const PUBLISHED_ROWS = FLAGGED.filter((row) => row.published);

function seed(publishedColumn) {
  seedMockDb({
    fields: [
      { id: FIELD, name: 'Field 1', organization_id: ORG, location_id: 'loc-pr1', active: true },
    ],
    locations: [{ id: 'loc-pr1', organization_id: ORG, effective_to: null }],
    game_slots: SLOTS,
    scheduler_runs: [
      {
        id: SAVED_RUN,
        organization_id: ORG,
        run_type: 'game',
        status: 'completed',
        season_settings_id: SEASON,
        completed_at: '2026-10-14T12:00:00Z',
        results: {},
      },
    ],
    game_assignments: savedGames(publishedColumn),
  });
}

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function listedMatchups() {
  return screen
    .queryAllByRole('cell')
    .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((text) => /^Synthetic \w+ vs Synthetic \w+$/.test(text));
}

/** Render over the saved run and press Generate: the review is staged and Apply is offered. */
async function generate(publishedColumn) {
  seed(publishedColumn);
  render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(listedMatchups()).toHaveLength(6));
  const run = await screen.findByRole('button', {
    name: 'Auto-Generate: run auto-scheduler optimization',
  });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  return screen.findByRole('button', { name: /apply schedule/i });
}

/** Apply, and return the games the save was sent. */
async function applyAndRead() {
  const apply = await screen.findByRole('button', { name: /apply schedule/i });
  const saves = [];
  SAVE.impl = async (args) => {
    saves.push(args);
    return { runId: 'run-new' };
  };
  await waitFor(() => expect(apply).toBeEnabled());
  fireEvent.click(apply);
  await waitFor(() => expect(saves).toHaveLength(1));
  return saves[0].assignments;
}

const instant = (value) => Date.parse(value);
/** Whether a game in the save is the saved row, in everything the save reads. */
const isSameGame = (sent, row) =>
  sent.homeTeamId === row.home_team_id &&
  sent.awayTeamId === row.away_team_id &&
  sent.slotId === row.game_slot_id &&
  sent.weekIndex === row.week_index &&
  sent.fieldId === row.field_id &&
  instant(sent.start) === instant(row.start) &&
  instant(sent.end) === instant(row.end);

describe('regenerating keeps the Published games where they are', () => {
  it('stages the three Published games under their own ids, in their own cells, and says so', async () => {
    await generate(true);
    // Said in words, with the count.
    expect(await screen.findByText(/3 Published games kept as they are/)).toBeInTheDocument();

    // Their cards are in the cells they were saved in, under the ids they were saved with. (The
    // ids of games that are not Published are made up for a review, so only these three can be named.)
    fireEvent.click(await screen.findByRole('button', { name: 'Enter Manual Override' }));
    await screen.findByTestId('game-schedule-grid');
    for (const week of [1, 2, 3]) {
      const cell = screen.getByTestId(`drop-zone-${FIELD}:${slotId(week, 2)}`);
      expect(within(cell).getByTestId(`game-card-ga-pub-${week}`)).toBeInTheDocument();
    }

    // What the save is sent: the three tuples and instants unchanged, and nothing Published left out.
    const sent = await applyAndRead();
    expect(sent).toHaveLength(6);
    for (const row of PUBLISHED_ROWS) {
      expect(
        sent.filter((game) => isSameGame(game, row)),
        `${row.id} is in the save as it was saved`
      ).toHaveLength(1);
    }
    expect(publishedOmissions(FLAGGED, sent)).toEqual([]);
  });

  it('generates the games that are not Published again, as before', async () => {
    await generate(true);
    const sent = await applyAndRead();
    const open = sent.filter((game) => !PUBLISHED_ROWS.some((row) => isSameGame(game, row)));
    expect(open).toHaveLength(3);
    // The saved ones sat on the middle slot of their week; with the last slot held by a Published
    // game, a fresh run puts each on the first. They moved: that part is not frozen.
    for (const game of open) {
      expect(game.slotId, `week ${game.weekIndex}`).toBe(slotId(game.weekIndex, 0));
    }
    expect(new Set(sent.map((game) => `${game.slotId}`)).size).toBe(6);
  });

  it('says it in the singular for one Published game, and keeps that one', async () => {
    await generate(['ga-pub-1']);
    expect(await screen.findByText(/1 Published game kept as it is/)).toBeInTheDocument();
    const sent = await applyAndRead();
    expect(publishedOmissions(savedGames(['ga-pub-1']), sent)).toEqual([]);
  });
});

describe('with nothing Published the page does what it always did', () => {
  for (const [label, column] of [
    ['every row says published: false', false],
    ['the rows have no published column (a database before the migration)', 'absent'],
  ]) {
    it(`${label}: the three games move, each carries its own id, and no kept-games sentence is shown`, async () => {
      await generate(column);
      expect(screen.queryByText(/Published games? kept/)).not.toBeInTheDocument();
      const sent = await applyAndRead();
      // The same six rows, but with the three flagged as the oracle sees them. Since 20261120010000 a moved game is sent
      // with its own id, which carries it wherever it now is: nothing is left out. Without the ids (the tuple alone, as
      // the page sent them before) every one of the three would be: the control that the oracle can still say so.
      expect(publishedOmissions(FLAGGED, sent)).toEqual([]);
      expect(sent.map((game) => game.id).sort()).toEqual(
        savedGames(column)
          .map((row) => row.id)
          .sort()
      );
      const tupleOnly = sent.map(({ id: _id, ...rest }) => rest);
      expect(publishedOmissions(FLAGGED, tupleOnly).map((row) => row.id)).toEqual([
        'ga-pub-1',
        'ga-pub-2',
        'ga-pub-3',
      ]);
      // And they moved (the last slot of a week is not used by a fresh run).
      for (const row of PUBLISHED_ROWS) {
        expect(sent.some((game) => isSameGame(game, row))).toBe(false);
      }
    });
  }
});

describe('when the saved games cannot be read the page does not generate', () => {
  /** A `game_assignments` read the server refuses, whatever the page asks for. */
  function refuseSavedGames() {
    const realFrom = mockSupabase.from.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
      if (table !== 'game_assignments') return realFrom(table);
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        range: () => builder,
        then: (resolve, reject) =>
          Promise.resolve({ data: null, error: new Error('saved games refused') }).then(
            resolve,
            reject
          ),
      };
      return builder;
    });
  }

  it('Generate stays off and says why: it could not know which games are Published', async () => {
    seed(true);
    refuseSavedGames();
    render(
      <MemoryRouter>
        <GameSchedulingPage />
      </MemoryRouter>
    );
    // The refusal has been read (the page's banner carries it) before anything is judged: while the
    // read is still loading the button is off for another reason.
    expect((await screen.findAllByText(/saved games refused/)).length).toBeGreaterThan(0);
    const run = screen.getByRole('button', {
      name: 'Auto-Generate: run auto-scheduler optimization',
    });
    expect(run).toBeDisabled();
    expect(
      screen.getByText(/saved game schedule could not be read.*not generated.*Published/)
    ).toBeInTheDocument();
    fireEvent.click(run);
    expect(screen.queryByRole('button', { name: /apply schedule/i })).not.toBeInTheDocument();
  });
});
