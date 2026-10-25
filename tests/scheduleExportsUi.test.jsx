// The schedule download buttons (plan docs/changes/2026-10-22-admin-focus.md,
// R7) on the coach home's schedule card, driven through the real card,
// component, `fetchTeamEvents` and the mock client: each button hands the
// browser a file built from the team's schedule, and a team whose schedule
// cannot be read makes no file at all and says which team.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';
import { readXlsx } from './helpers/readXlsx.js';
import { parseIcs } from './helpers/parseIcs.js';
import {
  TEAM_SCHEDULE_COLUMNS,
  teamScheduleCsv,
  teamScheduleRows,
} from '../packages/core/src/teamScheduleExport.js';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: MOCK_ORG_ID, name: 'Mock League' } }),
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

const { default: CoachScheduleCard } =
  await import('../frontend/src/components/coach/CoachScheduleCard.jsx');
const { fetchTeamEvents } = await import('../frontend/src/hooks/useTeamPortal.js');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');

const ZONE = 'America/Los_Angeles';
const TEAM_A = {
  id: 't1',
  name: 'Team A',
  division: { name: 'U8 Coed', season: { timezone: ZONE } },
};
const TEAM_B = {
  id: 't2',
  name: 'Team B',
  division: { name: 'U8 Coed', season: { timezone: ZONE } },
};

/** Every file the page handed the browser, with its name. */
let saved;

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-coach-id' } }));
  saved = [];
  let current = null;
  URL.createObjectURL = vi.fn((blob) => {
    current = blob;
    return 'blob:export';
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    saved.push({ name: this.download, blob: current });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const exportsGroup = async () =>
  screen.findByRole('group', { name: "Download your teams' full season" });

describe('the coach home’s schedule downloads', () => {
  it('downloads every team’s whole season as CSV, the rows the schedule holds', async () => {
    render(<CoachScheduleCard teams={[TEAM_A, TEAM_B]} />);
    const group = await exportsGroup();
    fireEvent.click(within(group).getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe('My_teams_Schedule.csv');
    expect(saved[0].blob.type).toBe('text/csv;charset=utf-8');

    // The oracle: both teams' schedules read independently, team by team.
    const a = await fetchTeamEvents('t1', ZONE);
    const b = await fetchTeamEvents('t2', ZONE);
    const rows = teamScheduleRows([
      { team: TEAM_A, timeZone: ZONE, events: a.events },
      { team: TEAM_B, timeZone: ZONE, events: b.events },
    ]);
    // The base seed's two slotless games are Team A's and Team B's.
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(await saved[0].blob.text()).toBe(teamScheduleCsv(rows));
    expect(
      await within(group).findByText(
        new RegExp(`Downloaded ${rows.length} event\\(s\\), 4 with no confirmed time`)
      )
    ).toBeInTheDocument();
  });

  it('downloads the same rows as XLSX', async () => {
    render(<CoachScheduleCard teams={[TEAM_A]} />);
    const group = await screen.findByRole('group', { name: "Download your team's full season" });
    fireEvent.click(within(group).getByRole('button', { name: 'Excel (.xlsx)' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe('Team_A_Schedule.xlsx');
    const sheet = readXlsx(new Uint8Array(await saved[0].blob.arrayBuffer()));
    const { events } = await fetchTeamEvents('t1', ZONE);
    const rows = teamScheduleRows([{ team: TEAM_A, timeZone: ZONE, events }]);
    expect(sheet.rows).toEqual([
      [...TEAM_SCHEDULE_COLUMNS],
      ...rows.map((row) => TEAM_SCHEDULE_COLUMNS.map((column) => row[column])),
    ]);
  });

  it('offers each team’s calendar, which parses and is that team’s', async () => {
    render(<CoachScheduleCard teams={[TEAM_A, TEAM_B]} />);
    const group = await exportsGroup();
    fireEvent.click(within(group).getByRole('button', { name: 'Calendar (.ics): Team B' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe('Team_B_Schedule.ics');
    expect(saved[0].blob.type).toBe('text/calendar;charset=utf-8');
    const { calendar } = parseIcs(await saved[0].blob.text());
    expect(calendar['X-WR-CALNAME']).toBe('Team B Schedule');
    expect(calendar.PRODID).toBe('-//Mock League//SquadLogic//EN');
    expect(calendar['X-WR-TIMEZONE']).toBe(ZONE);
  });

  it('makes no file when a team’s schedule cannot be read, and names the team', async () => {
    const realFrom = mockSupabase.from.bind(mockSupabase);
    render(<CoachScheduleCard teams={[TEAM_A, TEAM_B]} />);
    const group = await exportsGroup();
    // The card has read; now the games read fails for the export.
    await within(screen.getByRole('region', { name: 'Your schedule' })).findAllByTestId(
      'coach-schedule-event'
    );
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) =>
      table === 'games'
        ? /** @type {any} */ ({
            select: () => ({
              or: (filter) =>
                Promise.resolve(
                  filter.includes('t2')
                    ? { data: null, error: { message: 'boom' } }
                    : realFrom('games').select('*').or(filter)
                ),
            }),
          })
        : realFrom(table)
    );
    fireEvent.click(within(group).getByRole('button', { name: 'CSV' }));
    expect(
      await within(group).findByText(
        'No file was made: the schedule of Team B could not be read. Try again shortly.'
      )
    ).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: 'Calendar (.ics): Team B' }));
    expect(
      await within(group).findByText(
        'No calendar was made: the schedule of Team B could not be read. Try again shortly.'
      )
    ).toBeInTheDocument();
    expect(saved).toHaveLength(0);
  });

  it('keeps its buttons focusable while a file is made, and says so politely', async () => {
    render(<CoachScheduleCard teams={[TEAM_A]} />);
    const group = await screen.findByRole('group', { name: "Download your team's full season" });
    const csv = within(group).getByRole('button', { name: 'CSV' });
    fireEvent.click(csv);
    expect(csv).not.toBeDisabled();
    expect(csv).toHaveAttribute('aria-disabled', 'true');
    expect(within(group).getByRole('status')).toHaveTextContent('Preparing the file…');
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(csv).not.toHaveAttribute('aria-disabled');
    expect(csv).toHaveAttribute('aria-describedby', 'coach-schedule-exports-status');
  });
});
