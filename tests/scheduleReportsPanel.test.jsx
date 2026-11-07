/**
 * The Reports section of the Exports page (PR 7 of the schedule expansion): the Day Sheet, the coach schedule and
 * "Changes since publication". The real panel over the real mock client, seeded with the invented league of
 * `tests/helpers/reportsWorld.js`; the pure builders have their own files, and this one reads what the screen says.
 *
 * What this file holds (lessons 90 and 93):
 * - a view that renders before its inputs arrive says "Not checked yet", never "no games";
 * - a read that fails says which table and draws no row (the games, the league tables, the baseline);
 * - the Day Sheet shows the chosen date and venue, the TIME TBD games apart, and downloads the same rows;
 * - the coach schedule marks a coach from the team list and shows practices; no email or phone reaches the page
 *   even when the database answers with them;
 * - the Changes view lists a cancelled game, says a moved game is a removed game and a new game, and refuses a
 *   baseline that fails its integrity check.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ScheduleReportsPanel from '../frontend/src/components/reports/ScheduleReportsPanel.jsx';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { saveFile } from '../frontend/src/utils/scheduleDownloads.js';
import { seedMockDb } from './helpers/seedMockDb.js';
import {
  COACHES,
  COACH_ASSIGNMENTS,
  FIELDS,
  ORG_ID,
  RUN_ID,
  SEASON_ID,
  SLOTS,
  TEAMS,
  TZ,
  VENUES,
  baselineDbRow,
  baselineRows,
  practiceRows,
  savedGames,
  tbdRows,
} from './helpers/reportsWorld.js';

vi.mock('../frontend/src/config.js', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  IS_MOCK_MODE: false,
}));
vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const mock = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mock.mockSupabase };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'mock-admin-id' } }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() },
}));
// The downloads are read as text, not as a Blob.
vi.mock('../frontend/src/utils/scheduleDownloads.js', () => ({
  saveFile: vi.fn(),
  csvBlob: (csv) => csv,
}));

const ADMIN_ID = 'mock-admin-id';
const NO_ERRORS = { team: null, practice: null, game: null };
const NOT_LOADING = { team: false, practice: false, game: false };

function seedWorld({ baselines = [] } = {}) {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  const org = { organization_id: ORG_ID };
  const slots = SLOTS.map((s) => ({ id: s.id, ...org, week_index: s.weekIndex, field_id: 'f-a1' }));
  seedMockDb({
    organizations: [{ id: ORG_ID, name: 'Synthetic FC', is_onboarded: true }],
    organization_members: [{ ...org, profile_id: ADMIN_ID, role: 'admin' }],
    profiles: [{ id: ADMIN_ID, full_name: 'Synthetic Admin' }],
    season_settings: [{ id: SEASON_ID, ...org, name: 'Fall 2026', status: 'active', timezone: TZ }],
    divisions: [
      { id: 'd-10', ...org, season_settings_id: SEASON_ID, name: 'U10' },
      { id: 'd-12', ...org, season_settings_id: SEASON_ID, name: 'U12' },
    ],
    teams: TEAMS.map((t) => ({ id: t.id, ...org, name: t.name, division_id: t.divisionId })),
    // The contact columns are in the answer on purpose: the page must not reach for them.
    coaches: COACHES.map((c) => ({
      id: c.id,
      ...org,
      season_settings_id: SEASON_ID,
      full_name: c.name,
      email: `${c.id}@example.invalid`,
      phone: '555-0100',
      can_coach_multiple_teams: c.canCoachMultipleTeams,
    })),
    team_coach_assignments: COACH_ASSIGNMENTS.map((a) => ({ ...org, ...a })),
    locations: VENUES.map((v) => ({ id: v.id, ...org, name: v.name, effective_to: null })),
    fields: FIELDS.map((f) => ({
      id: f.id,
      ...org,
      name: f.name,
      location_id: f.venueId,
      active: true,
    })),
    game_slots: slots,
    practice_slots: practiceRows().map((p) => ({
      id: `ps-${p.id}`,
      ...org,
      field_id: p.slot.field.id,
      day_of_week: p.slot.day_of_week,
      start_time: p.slot.start_time,
      end_time: p.slot.end_time,
      valid_from: p.slot.valid_from,
      valid_until: p.slot.valid_until,
    })),
    practice_assignments: practiceRows().map((p) => ({
      id: p.id,
      ...org,
      team_id: p.team_id,
      practice_slot_id: `ps-${p.id}`,
      slot_id: `ps-${p.id}`,
      effective_date_range: p.effective_date_range,
    })),
    schedule_tbd: tbdRows().map((row) => ({
      ...row,
      ...org,
      season_settings_id: SEASON_ID,
      division_id: row.kind === 'game' ? 'd-10' : 'd-12',
    })),
    publication_baselines: baselines,
    audit_log: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: ADMIN_ID } }));
}

function mount(props = {}) {
  return render(
    <ScheduleReportsPanel
      gameAssignments={savedGames()}
      gameRunId={RUN_ID}
      sourceErrors={NO_ERRORS}
      sourceLoading={NOT_LOADING}
      supabaseClient={mockSupabase}
      {...props}
    />
  );
}

/** A client that answers like the mock, except that one table fails as an error or as a rejected request. */
function clientFailing(table, how = 'error') {
  return new Proxy(mockSupabase, {
    get(target, prop) {
      if (prop === 'from') {
        return (name) => {
          if (name !== table) return target.from(name);
          const failure = () =>
            how === 'reject'
              ? Promise.reject(new Error(`network down reading ${table}`))
              : Promise.resolve({ data: null, error: { message: `${table} denied` } });
          const builder = {
            select: () => builder,
            eq: () => builder,
            order: () => builder,
            range: () => builder,
            maybeSingle: failure,
            then: (resolve, reject) => failure().then(resolve, reject),
          };
          return builder;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const openTab = (name) => fireEvent.click(screen.getByRole('tab', { name }));
const downloaded = () => {
  const [call] = vi.mocked(saveFile).mock.calls.slice(-1);
  return { name: call[0], csv: call[1] };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useOrganization).mockReturnValue({
    // @ts-expect-error [MOCK] - a partial organization context is enough here.
    currentOrganization: { id: ORG_ID },
    currentSeasonSetting: { id: SEASON_ID, timezone: TZ },
  });
  seedWorld();
});
afterEach(() => cleanup());

describe('a view that renders before its inputs arrive says it has not checked', () => {
  it('says "Not checked yet" while the saved games are being read, and shows no row and no "no games"', () => {
    mount({ gameAssignments: [], sourceLoading: { ...NOT_LOADING, game: true } });
    expect(screen.getByTestId('reports-not-checked')).toHaveTextContent(/not checked yet/i);
    expect(screen.queryByTestId('day-sheet-table')).toBeNull();
    expect(screen.queryByText(/no games/i)).toBeNull();
  });

  it('says it while the league tables are being read, then draws the Day Sheet', async () => {
    mount();
    expect(screen.getByTestId('reports-not-checked')).toBeInTheDocument();
    await screen.findByLabelText('Date');
    expect(screen.queryByTestId('reports-not-checked')).toBeNull();
  });

  it('says there is no saved schedule, in those words, when there is no game run', async () => {
    mount({ gameAssignments: [], gameRunId: null });
    expect(await screen.findByTestId('reports-no-schedule')).toHaveTextContent(
      /no game schedule is saved/i
    );
  });

  it('draws nothing and says so when the season has no time zone', async () => {
    vi.mocked(useOrganization).mockReturnValue({
      // @ts-expect-error [MOCK] - a partial organization context is enough here.
      currentOrganization: { id: ORG_ID },
      currentSeasonSetting: { id: SEASON_ID, timezone: null },
    });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(/time zone/i);
    expect(screen.queryByTestId('day-sheet-table')).toBeNull();
  });
});

describe('a read that fails says which table and draws no row', () => {
  it('names the saved games when they could not be read', () => {
    mount({ gameAssignments: [], sourceErrors: { ...NO_ERRORS, game: 'game_assignments: boom' } });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/saved games/i);
    expect(alert).toHaveTextContent(/boom/);
    expect(screen.queryByTestId('day-sheet-table')).toBeNull();
    expect(screen.queryByText(/no games/i)).toBeNull();
  });

  it.each([
    ['fields', 'error'],
    ['fields', 'reject'],
    ['team_coach_assignments', 'error'],
    ['practice_assignments', 'reject'],
    ['coaches', 'error'],
  ])('names %s when that read fails as a %s, and shows no report at all', async (table, how) => {
    mount({ supabaseClient: clientFailing(table, how) });
    const alert = await screen.findByTestId('reports-read-error');
    expect(alert).toHaveTextContent(table);
    expect(screen.queryByTestId('day-sheet-table')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Day Sheet' })).toBeNull();
  });
});

describe('the Day Sheet', () => {
  async function openDay(date = '2026-10-03') {
    mount();
    const dateInput = await screen.findByLabelText('Date');
    fireEvent.change(dateInput, { target: { value: date } });
  }

  it('lists the games of the chosen date, in time order, with the names a person reads', async () => {
    await openDay();
    const table = await screen.findByTestId('day-sheet-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('09:00');
    expect(rows[0]).toHaveTextContent('Synthetic Comets');
    expect(rows[0]).toHaveTextContent('North Park');
    expect(rows[1]).toHaveTextContent('Synthetic Planets');
    expect(screen.getByTestId('day-sheet-summary')).toHaveTextContent(/2 games/);
  });

  it('narrows to a venue by choice, and tells the two venues named Main Park apart', async () => {
    await openDay('2026-10-17');
    expect(screen.getByLabelText('Venue')).toBeInTheDocument();
    const options = within(screen.getByLabelText('Venue')).getAllByRole('option');
    const mains = options.filter((o) => /Main Park/.test(o.textContent));
    expect(mains).toHaveLength(2);
    expect(mains[0].textContent).not.toBe(mains[1].textContent);
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'v-main-1' } });
    expect(await screen.findByTestId('day-sheet-empty')).toHaveTextContent(/no games/i);
    // The empty answer is about this venue; the page says a game is at another venue that day.
    expect(screen.getByTestId('day-sheet-summary')).toHaveTextContent(
      /1 game on this date is at another venue/i
    );
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'v-main-2' } });
    const table = await screen.findByTestId('day-sheet-table');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });

  it('lists the TIME TBD games apart, whatever the date, with the reason', async () => {
    await openDay('2026-10-24');
    expect(await screen.findByTestId('day-sheet-empty')).toBeInTheDocument();
    const tbd = screen.getByTestId('day-sheet-tbd');
    expect(tbd).toHaveTextContent('Synthetic Comets');
    expect(tbd).toHaveTextContent('Synthetic Meteors');
    expect(tbd).toHaveTextContent(/no game slot was free for it/);
    expect(tbd).toHaveTextContent(/no date or venue/i);
  });

  it('downloads the rows it shows, as a CSV named for the date', async () => {
    await openDay();
    fireEvent.click(await screen.findByRole('button', { name: /download day sheet/i }));
    const { name, csv } = downloaded();
    expect(name).toBe('day-sheet-2026-10-03.csv');
    expect(csv.split('\n')[0]).toBe('Date,Kickoff,Ends,Venue,Field,Division,Home,Away,Status');
    expect(csv).toContain('Synthetic Comets');
    expect(csv).toContain('TIME TBD');
    expect(csv).not.toMatch(/example\.invalid|555-0100|coach/i);
  });
});

describe('the coach schedule', () => {
  async function openCoach() {
    mount();
    await screen.findByLabelText('Date');
    openTab('Coach schedule');
    return screen.findByLabelText('Coach');
  }

  it('lists every coach on the registry with the teams counted from the team list', async () => {
    const select = await openCoach();
    const labels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toContain('Alex Sample (2 teams)');
    // Blake is flagged "multi" on the Coaches page and has one team: not marked.
    expect(labels).toContain('Blake Sample (1 team)');
    expect(labels).toContain('Casey Sample (2 teams)');
    expect(screen.getByTestId('coach-multi-count')).toHaveTextContent(
      /2 of 5 coaches are on more than one team/
    );
  });

  it('shows a chosen coach’s games and practices, the marker and the clashes', async () => {
    const select = await openCoach();
    fireEvent.change(select, { target: { value: 'c-1' } });
    const table = await screen.findByTestId('coach-schedule-table');
    expect(screen.getByTestId('coach-marker')).toHaveTextContent(/more than one team/i);
    const text = table.textContent;
    expect(text).toContain('Synthetic Comets');
    expect(text).toContain('Synthetic Planets');
    expect(text).toContain('Overlaps Synthetic Planets v Synthetic Moons');
    expect(text).toContain('Overlaps the Tuesday 18:00 to 19:00 practice of Synthetic Planets');
    expect(screen.getByTestId('coach-notes')).toHaveTextContent(
      /practice is not compared with a game/i
    );
  });

  it('does not mark a coach with one team, whatever the Coaches page flag says', async () => {
    const select = await openCoach();
    fireEvent.change(select, { target: { value: 'c-2' } });
    await screen.findByTestId('coach-schedule-table');
    expect(screen.queryByTestId('coach-marker')).toBeNull();
  });

  it('shows no email and no phone anywhere on the page, though the database answered with them', async () => {
    const select = await openCoach();
    fireEvent.change(select, { target: { value: 'c-1' } });
    await screen.findByTestId('coach-schedule-table');
    expect(document.body.textContent).not.toMatch(/example\.invalid|555-0100/);
  });

  it('downloads the coach’s file, named for the coach, with their name and no contact', async () => {
    const select = await openCoach();
    fireEvent.change(select, { target: { value: 'c-1' } });
    fireEvent.click(await screen.findByRole('button', { name: /download alex sample/i }));
    const { name, csv } = downloaded();
    expect(name).toBe('coach-schedule-alex-sample.csv');
    expect(csv).toContain('Alex Sample');
    expect(csv).not.toMatch(/example\.invalid|555-0100/);
  });

  it('says a coach with no team has no current team', async () => {
    seedWorld();
    seedMockDb({
      coaches: [
        {
          id: 'c-6',
          organization_id: ORG_ID,
          season_settings_id: SEASON_ID,
          full_name: 'Fran Sample',
        },
      ],
    });
    const select = await openCoach();
    fireEvent.change(select, { target: { value: 'c-6' } });
    expect(await screen.findByTestId('coach-notes')).toHaveTextContent(/no current team/i);
    expect(screen.queryByTestId('coach-schedule-table')).toBeNull();
  });
});

describe('Changes since publication', () => {
  const published = () => baselineDbRow(baselineRows(savedGames()));

  async function openChanges(props = {}) {
    mount(props);
    await screen.findByLabelText('Date');
    openTab('Changes since publication');
  }

  it('says no schedule has been published when there is no baseline, and does not call that "no changes"', async () => {
    await openChanges();
    expect(await screen.findByTestId('changes-no-baseline')).toHaveTextContent(
      /no published baseline/i
    );
    expect(screen.queryByText(/no changes/i)).toBeNull();
  });

  it('says nothing has changed, with the counts, when the saved schedule equals the baseline', async () => {
    seedWorld({ baselines: [published()] });
    await openChanges();
    fireEvent.change(await screen.findByLabelText('Published baseline'), {
      target: { value: 'b-1' },
    });
    expect(await screen.findByTestId('changes-summary')).toHaveTextContent(
      /6 games then, 6 now: 6 unchanged/
    );
    expect(screen.queryByTestId('changes-table')).toBeNull();
    expect(screen.getByTestId('changes-nothing')).toBeInTheDocument();
  });

  it('lists a cancelled game with no "now", and says a moved game is a removed game and a new game', async () => {
    seedWorld({ baselines: [published()] });
    const moved = {
      ...savedGames().find((g) => g.id === 'g1'),
      id: 'g1-moved',
      slotId: 's-7',
      gameSlotId: 's-7',
      weekIndex: 3,
      start: '2026-10-17T15:00:00+00:00',
      end: '2026-10-17T16:00:00+00:00',
    };
    await openChanges({ gameAssignments: [...savedGames({ g1: null, g3: null }), moved] });
    fireEvent.change(await screen.findByLabelText('Published baseline'), {
      target: { value: 'b-1' },
    });
    const table = await screen.findByTestId('changes-table');
    const rows = within(table).getAllByRole('row').slice(1);
    const text = rows.map((row) => row.textContent);
    expect(rows).toHaveLength(3);
    expect(text.filter((t) => t.includes('No longer in the saved schedule'))).toHaveLength(2);
    expect(text.filter((t) => t.includes('New since publication'))).toHaveLength(1);
    expect(screen.getByTestId('changes-notes')).toHaveTextContent(
      /moved to another time slot or week is saved as a new game/i
    );
    expect(screen.getByTestId('changes-notes')).toHaveTextContent(/does not link/i);
    expect(screen.getByTestId('changes-summary')).toHaveTextContent(
      /6 games then, 5 now: 4 unchanged/
    );
  });

  it('shows the reason recorded for a game whose changes were allowed after the baseline', async () => {
    seedWorld({ baselines: [published()] });
    const g3 = savedGames().find((g) => g.id === 'g3');
    seedMockDb({
      audit_log: [
        {
          id: 'a-1',
          organization_id: ORG_ID,
          user_id: ADMIN_ID,
          created_at: '2026-10-05T12:00:00+00:00',
          action: 'game.publish_overridden',
          resource_type: 'game_assignment',
          resource_id: 'old-g3',
          metadata: {
            reason_code: 'coach-request',
            note: 'The coach asked for a later start',
            scope: { kind: 'selection' },
            before: {
              game_slot_id: g3.slotId,
              field_id: g3.fieldId,
              home_team_id: g3.homeTeamId,
              away_team_id: g3.awayTeamId,
              week_index: g3.weekIndex,
              start: g3.start,
              end: g3.end,
            },
          },
        },
      ],
    });
    await openChanges({ gameAssignments: savedGames({ g3: null }) });
    fireEvent.change(await screen.findByLabelText('Published baseline'), {
      target: { value: 'b-1' },
    });
    const table = await screen.findByTestId('changes-table');
    expect(table).toHaveTextContent('Coach request');
    expect(table).toHaveTextContent('The coach asked for a later start');
    expect(table).toHaveTextContent('Synthetic Admin');
  });

  it('does not compare against a baseline that fails its integrity check, and says so', async () => {
    seedWorld({
      baselines: [
        baselineDbRow(baselineRows(savedGames()), {
          mutate: (row) => ({
            ...row,
            export_rows: row.export_rows.map((r, i) =>
              i === 0 ? { ...r, Start: '2026-10-03T23:00:00.000Z' } : r
            ),
          }),
        }),
      ],
    });
    await openChanges();
    fireEvent.change(await screen.findByLabelText('Published baseline'), {
      target: { value: 'b-1' },
    });
    const alert = await screen.findByTestId('changes-read-error');
    expect(alert).toHaveTextContent(/publication_baselines/);
    expect(alert).toHaveTextContent(/integrity|digest/i);
    expect(screen.queryByTestId('changes-table')).toBeNull();
    expect(screen.queryByTestId('changes-summary')).toBeNull();
  });

  it('downloads the changes as a CSV', async () => {
    seedWorld({ baselines: [published()] });
    await openChanges({ gameAssignments: savedGames({ g3: null }) });
    fireEvent.change(await screen.findByLabelText('Published baseline'), {
      target: { value: 'b-1' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /download changes/i }));
    const { name, csv } = downloaded();
    expect(name).toBe('changes-since-baseline-v3.csv');
    expect(csv.split('\n')[0]).toBe('Change,Division,Home,Away,Originally,Now,Why');
    expect(csv).toContain('No longer in the saved schedule');
  });
});
