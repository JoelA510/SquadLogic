/**
 * Practice preference rules UI (Phase D C1; originally Phase 8.6 PR 3b, PR 2).
 *
 * Driven through the real page, hooks and core re-judge, over a fake Supabase client whose tables
 * are plain arrays. What each block proves, and the plant that turns it red, is stated beside it.
 * The screen is the admins' stopgap until the import screens (C2): pending musts, rules in force,
 * and adding a rule with one condition.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import CoachPreferencesPage from '../frontend/src/pages/CoachPreferencesPage.jsx';
import ToastHost from '../frontend/src/components/ui/ToastHost.jsx';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { useAuth } from '../frontend/src/contexts/AuthContext.jsx';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({ useOrganization: vi.fn() }));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({ useAuth: vi.fn() }));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const ORG = MOCK_ORG_ID;
const C1 = '11111111-1111-4111-8111-111111111111';
const C3 = '33333333-3333-4333-8333-333333333333';
const LAST = '44444444-4444-4444-8444-444444444444';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const T2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const T3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const L1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

const slot = (day, time) => ({ day_of_week: day, start_time: time, field: { location_id: L1 } });

/** A rule row as the store holds it. */
const ruleRow = (over) => ({
  organization_id: ORG,
  coach_id: C1,
  team_id: T1,
  level: 'prefer',
  requested_level: 'prefer',
  must_decision: null,
  status: 'in_force',
  source: 'import',
  import_job_id: 'job-1',
  weekdays: null,
  start_minutes: null,
  venue_ids: null,
  keep_weekday: false,
  keep_start: false,
  keep_venue: false,
  coach_priority: null,
  effective_from: null,
  effective_to: null,
  created_at: '2026-09-20T10:00:00Z',
  decided_at: null,
  ...over,
});

/** Two current teams for C1 (T1 on Monday, T2 on Wednesday) and one ended (T3). */
function freshTables() {
  return {
    // Coaches belong to one season (20261108010000): the page lists the season shown, 'season-1'.
    coaches: [
      { id: C1, organization_id: ORG, season_settings_id: 'season-1', full_name: 'Casey Coach' },
      {
        id: C3,
        organization_id: ORG,
        season_settings_id: 'season-1',
        full_name: 'Robin Unassigned',
      },
      {
        id: LAST,
        organization_id: ORG,
        season_settings_id: 'season-0',
        full_name: 'Last Season Coach',
      },
    ],
    locations: [{ id: L1, organization_id: ORG, name: 'Riverside Park' }],
    teams: [
      { id: T1, organization_id: ORG, name: 'U10 Hawks' },
      { id: T2, organization_id: ORG, name: 'U12 Owls' },
      { id: T3, organization_id: ORG, name: 'U8 Wrens' },
    ],
    team_coach_assignments: [
      {
        id: 'tca-1',
        organization_id: ORG,
        team_id: T1,
        coach_id: C1,
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: null,
      },
      {
        id: 'tca-2',
        organization_id: ORG,
        team_id: T2,
        coach_id: C1,
        role: 'assistant',
        effective_from: '2026-01-01',
        effective_to: null,
      },
      // Ended: T3 is not a current team, so its series must not be listed.
      {
        id: 'tca-3',
        organization_id: ORG,
        team_id: T3,
        coach_id: C1,
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: '2026-02-01',
      },
    ],
    practice_assignments: [
      {
        id: 'pa-1',
        organization_id: ORG,
        team_id: T1,
        effective_date_range: null,
        slot: slot('mon', '18:00:00'),
      },
      {
        id: 'pa-2',
        organization_id: ORG,
        team_id: T2,
        effective_date_range: null,
        slot: slot('wed', '18:00:00'),
      },
      {
        id: 'pa-3',
        organization_id: ORG,
        team_id: T3,
        effective_date_range: null,
        slot: slot('mon', '17:00:00'),
      },
    ],
    coach_practice_preferences: [
      // A must the file asked for, in force as prefer until accepted.
      ruleRow({ id: 'r1', weekdays: ['WED'], requested_level: 'must', must_decision: 'pending' }),
      // A plain prefer in force.
      ruleRow({ id: 'r2', team_id: T2, venue_ids: [L1], created_at: '2026-09-19T10:00:00Z' }),
    ],
  };
}

let tables;
/** @type {Record<string, any>} */
let tableErrors;

function builder(table) {
  const filters = [];
  let range = null;
  const run = () => {
    if (tableErrors[table]) return { data: null, error: tableErrors[table] };
    let rows = (tables[table] || []).filter((row) =>
      filters.every(([column, value]) => String(row[column]) === String(value))
    );
    if (range) rows = rows.slice(range[0], range[1] + 1);
    return { data: rows, error: null };
  };
  const b = {
    select: () => b,
    eq: (column, value) => {
      filters.push([column, value]);
      return b;
    },
    order: () => b,
    range: (from, to) => {
      range = [from, to];
      return b;
    },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
  };
  return b;
}

function asRole(role, userId = 'user-admin') {
  vi.mocked(useOrganization).mockReturnValue(
    /** @type {any} */ ({
      currentOrganization: { id: ORG },
      currentSeasonSetting: { id: 'season-1' },
      orgMember: { role },
    })
  );
  vi.mocked(useAuth).mockReturnValue(/** @type {any} */ ({ user: { id: userId } }));
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/coaches/practice-preferences']}>
      <ToastHost>
        <CoachPreferencesPage />
      </ToastHost>
    </MemoryRouter>
  );

beforeEach(() => {
  tables = freshTables();
  tableErrors = {};
  vi.mocked(supabase.from).mockImplementation(/** @type {any} */ (builder));
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
});

describe('admin view', () => {
  it("lists the pending musts and rules of the season shown's coaches only", async () => {
    // The table has no season: a rule is the season's through its coach. Last season's coach has a
    // pending must that must neither be listed nor offer an acceptance.
    tables.coach_practice_preferences.push(
      ruleRow({
        id: 'r-last',
        coach_id: LAST,
        weekdays: ['TUE'],
        requested_level: 'must',
        must_decision: 'pending',
      })
    );
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    expect(screen.getAllByText('Casey Coach').length).toBeGreaterThan(0);
    expect(screen.queryByText('Last Season Coach')).not.toBeInTheDocument();
    expect(screen.queryByText(/44444444-4444-4444-8444-444444444444/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Accept as must: / })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Pending musts (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rules in force (2)' })).toBeInTheDocument();
  });

  it('offers accept and keep-as-prefer on a pending must, and add on each coach of the season', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    const row = screen
      .getAllByRole('row')
      .find(
        (tr) =>
          within(tr).queryByText('Casey Coach') &&
          within(tr).queryByText('U10 Hawks') &&
          within(tr).queryByRole('button', { name: /^Accept/ })
      );
    expect(row).toBeTruthy();
    expect(within(row).getByText('Wednesday')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^Keep as prefer: / })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Add a rule for/ })).toHaveLength(2);
    expect(screen.getByText('Pending must')).toBeInTheDocument();
  });

  // Plant (a): enumerate the preview's series from the rule rows instead of the practice rows ->
  // nothing is listed and this goes red.
  it('re-judges at acceptance: lists exactly the current series the must would break', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /^Accept as must: / }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept as must' });
    const listed = within(dialog)
      .getAllByTestId('unsatisfiable-series')
      .map((item) => item.getAttribute('data-assignment-id'));
    // T1 practises Monday (breaks a must for WED); T2 is not this rule's team; T3's series is not T1's.
    expect(listed).toEqual(['pa-1']);
    expect(within(dialog).getByTestId('unsatisfiable-series')).toHaveTextContent('U10 Hawks');
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept as must' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_decide_must_preference', {
        p_preference_id: 'r1',
        p_decision: 'accept',
      })
    );
  });

  it('keep as prefer reaches the RPC with its decision', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /^Keep as prefer: / }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_decide_must_preference', {
        p_preference_id: 'r1',
        p_decision: 'keep_prefer',
      })
    );
  });

  it('remove reaches the RPC', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /^Remove .*Riverside Park$/ }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_remove_practice_preference', {
        p_preference_id: 'r2',
      })
    );
  });

  it("adds a one-value rule for one of the coach's teams, re-judging a must against that team's series", async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule for Casey Coach' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a rule' });
    fireEvent.change(within(dialog).getByLabelText('Team'), { target: { value: T2 } });
    fireEvent.change(within(dialog).getByLabelText('Level'), { target: { value: 'must' } });
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'FRI' } });
    // T2 practises Wednesday: a must for Friday breaks it.
    expect(within(dialog).getByTestId('unsatisfiable-series')).toHaveTextContent('U12 Owls');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_add_practice_preference', {
        p_coach_id: C1,
        p_team_id: T2,
        p_level: 'must',
        p_weekdays: ['FRI'],
        p_start_minutes: null,
        p_venue_ids: null,
        p_keep_weekday: false,
        p_keep_start: false,
        p_keep_venue: false,
        p_coach_priority: null,
        p_effective_from: null,
        p_effective_to: null,
      })
    );
  });

  it('adds keep-current when no value is chosen, and says "None" when no series would break', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule for Casey Coach' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a rule' });
    fireEvent.change(within(dialog).getByLabelText('Level'), { target: { value: 'must' } });
    // Keeping the current weekday of a team that practises: nothing it has is broken.
    expect(within(dialog).getByTestId('preview-none')).toHaveTextContent('None');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith(
        'admin_add_practice_preference',
        expect.objectContaining({ p_weekdays: null, p_keep_weekday: true, p_level: 'must' })
      )
    );
  });

  it('a coach with no team today has nothing to add a rule to', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule for Robin Unassigned' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a rule' });
    expect(within(dialog).getByText(/coaches no team today/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeDisabled();
  });
});

describe("the day a coach 'coaches today' is the database's, not the admin's", () => {
  // `admin_assign_team_coach` stamps an assignment with the database's `current_date` (UTC), and
  // `admin_add_practice_preference` reads "coaches this team today" on the same date. The Add dialog must
  // list the same teams the RPC would accept, wherever the admin's clock is.
  const realTz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  const at = (iso, tz) => {
    process.env.TZ = tz;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };
  const openRobin = async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule for Robin Unassigned' }));
    return screen.findByRole('dialog', { name: 'Add a rule' });
  };

  it('west of UTC in the evening, an assignment stamped with the database date (tomorrow here) counts', async () => {
    // 18:00 on 2026-10-01 in Los Angeles is 01:00Z on the 2nd: the RPC stamps '2026-10-02'.
    at('2026-10-02T01:00:00Z', 'America/Los_Angeles');
    tables.team_coach_assignments.push({
      id: 'tca-new',
      organization_id: ORG,
      team_id: T1,
      coach_id: C3,
      role: 'lead',
      effective_from: '2026-10-02',
      effective_to: null,
    });
    const dialog = await openRobin();
    expect(within(dialog).queryByText(/coaches no team today/)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Team')).toHaveValue(T1);
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeEnabled();
  });

  it("east of UTC after the database's day has not turned, an assignment ending on that day still counts", async () => {
    // 12:00 on 2026-10-02 in Auckland is 23:00Z on the 1st: the RPC's `current_date` is still the 1st,
    // and an assignment that ends on the 1st (inclusive) is current there.
    at('2026-10-01T23:00:00Z', 'Pacific/Auckland');
    tables.team_coach_assignments.push({
      id: 'tca-ends',
      organization_id: ORG,
      team_id: T1,
      coach_id: C3,
      role: 'lead',
      effective_from: '2026-09-01',
      effective_to: '2026-10-01',
    });
    const dialog = await openRobin();
    expect(within(dialog).queryByText(/coaches no team today/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeEnabled();
  });
});

describe('failure states', () => {
  const MISSING = {
    code: 'PGRST205',
    message: "Could not find the table 'public.coach_practice_preferences' in the schema cache",
  };

  it('the view names a missing table instead of showing an empty list', async () => {
    tableErrors.coach_practice_preferences = MISSING;
    asRole('admin');
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('migration has not been applied');
    expect(alert).toHaveTextContent('schema cache');
    expect(screen.queryByText('No pending musts.')).not.toBeInTheDocument();
    expect(screen.queryByText('No rules in force.')).not.toBeInTheDocument();
  });

  it('a missing RPC (PGRST202) is surfaced with its message', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue(
      /** @type {any} */ ({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.admin_decide_must_preference',
        },
      })
    );
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /^Keep as prefer: / }));
    expect(
      await screen.findByText(/Could not find the function public.admin_decide_must_preference/)
    ).toBeInTheDocument();
  });

  it('a value the core schema refuses never reaches the RPC', async () => {
    tables.locations = [{ id: 'loc-not-a-uuid', organization_id: ORG, name: 'Legacy Park' }];
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule for Casey Coach' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a rule' });
    fireEvent.change(within(dialog).getByLabelText('Dimension'), { target: { value: 'venue' } });
    fireEvent.change(within(dialog).getByLabelText(/Venue/), {
      target: { value: 'loc-not-a-uuid' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(
      await screen.findByText(/a location id is a lowercase canonical uuid/)
    ).toBeInTheDocument();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

/*
 * Every user-triggered RPC path, enumerated from the `callRpc(` call sites in
 * `useCoachPracticePreferences.js` (decide a must, add, remove), driven through the real UI with the
 * RPC refusing. Each must put the database's own message on screen AND claim no success. A catch that
 * swallows (`void err`) turns its row red.
 */
describe('every RPC path surfaces a database refusal', () => {
  const refuse = (code, message) =>
    vi
      .mocked(supabase.rpc)
      .mockResolvedValue(/** @type {any} */ ({ data: null, error: { code, message } }));

  const PATHS = [
    {
      path: 'keep as prefer',
      code: '42501',
      message: 'Access denied: planted refusal on keep as prefer',
      success: /^Kept as prefer$/,
      rpc: 'admin_decide_must_preference',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(screen.getByRole('button', { name: /^Keep as prefer: / }));
      },
      stillThere: () =>
        expect(screen.getByRole('button', { name: /^Keep as prefer: / })).toBeInTheDocument(),
    },
    {
      path: 'accept',
      code: '22023',
      message: 'practice preference r1 is not a pending must: planted refusal on accept',
      success: /^Accepted as a must$/,
      rpc: 'admin_decide_must_preference',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(screen.getByRole('button', { name: /^Accept as must: / }));
        const dialog = await screen.findByRole('dialog', { name: 'Accept as must' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Accept as must' }));
      },
      stillThere: () =>
        expect(screen.getByRole('dialog', { name: 'Accept as must' })).toBeInTheDocument(),
    },
    {
      path: 'remove',
      code: '22023',
      message: 'practice preference r2 is removed, not in force: planted refusal on remove',
      success: /^Rule removed$/,
      rpc: 'admin_remove_practice_preference',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(screen.getByRole('button', { name: /^Remove .*Riverside Park$/ }));
      },
      stillThere: () =>
        expect(
          screen.getByRole('button', { name: /^Remove .*Riverside Park$/ })
        ).toBeInTheDocument(),
    },
    {
      path: 'add',
      code: '42501',
      message: 'Access denied: planted refusal on admin_add_practice_preference',
      success: /^Rule added$/,
      rpc: 'admin_add_practice_preference',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(screen.getByRole('button', { name: 'Add a rule for Casey Coach' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add a rule' });
        fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'FRI' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
      },
      stillThere: () =>
        expect(screen.getByRole('dialog', { name: 'Add a rule' })).toBeInTheDocument(),
    },
  ];

  it('the table names every RPC the hook calls and all four user paths', async () => {
    // Enumerated from the hook's source, not from this table: a new callRpc site with no row here
    // fails this test.
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      `${process.cwd()}/frontend/src/hooks/useCoachPracticePreferences.js`,
      'utf8'
    );
    const called = new Set([...source.matchAll(/callRpc\('([a-z_]+)'/g)].map((m) => m[1]));
    expect(called.size).toBe(3);
    expect(new Set(PATHS.map((entry) => entry.rpc))).toEqual(called);
    // Three sites, four paths: accepting and keeping a must are one RPC with two decisions.
    expect([...source.matchAll(/callRpc\('/g)]).toHaveLength(PATHS.length - 1);
  });

  it.each(PATHS.map((entry) => [entry.path, entry]))(
    '%s: the refusal message is shown and no success is claimed',
    async (_name, entry) => {
      refuse(entry.code, entry.message);
      asRole('admin');
      renderPage();
      await entry.drive();
      expect(await screen.findByText(entry.message)).toBeInTheDocument();
      expect(supabase.rpc).toHaveBeenCalledWith(entry.rpc, expect.any(Object));
      expect(screen.queryByText(entry.success)).not.toBeInTheDocument();
      entry.stillThere();
    }
  );
});

describe('every load and compute failure is visible', () => {
  const acceptDialog = async () => {
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /^Accept as must: / }));
    return screen.findByRole('dialog', { name: 'Accept as must' });
  };

  it('a failed roster read says the re-judge could not run', async () => {
    tableErrors.team_coach_assignments = {
      code: '42501',
      message: 'permission denied for table team_coach_assignments',
    };
    asRole('admin');
    renderPage();
    const dialog = await acceptDialog();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Could not re-judge this decision: permission denied for table team_coach_assignments'
    );
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();
  });

  it('a failed coaches read is a banner, not an empty coach table', async () => {
    tableErrors.coaches = { code: '42501', message: 'permission denied for table coaches' };
    asRole('admin');
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load coaches or locations: permission denied for table coaches'
    );
  });

  it('a rule core cannot read says so instead of "None"', async () => {
    // Another rule in force for the team that core refuses to parse: the re-judge throws.
    tables.coach_practice_preferences.push(
      ruleRow({ id: 'bad-1', start_minutes: [99999], created_at: '2026-09-01T10:00:00Z' })
    );
    asRole('admin');
    renderPage();
    const dialog = await acceptDialog();
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('Could not re-judge this decision');
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();
  });

  it('the pending rule itself unreadable says so in the dialog', async () => {
    tables.coach_practice_preferences[0].weekdays = ['Funday'];
    asRole('admin');
    renderPage();
    const dialog = await acceptDialog();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not re-judge this decision');
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();
  });
});
