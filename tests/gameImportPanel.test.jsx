// @vitest-environment jsdom
//
// The Games tab of the Import panel (plan docs/changes/2026-11-03-schedule-expansion.md 4.2 and 4.5; PR 6, tasks F2,
// F7 and F8), driven through the REAL mock client: the file is read by the mock's `import-validation`, mapped, previewed
// and applied by the mock's games RPCs, and every assertion about what was written reads the mock's tables back
// through that same client. Nothing here forges a state the production path cannot reach.
//
// What it holds:
//   - the confirm lists everything that will be created, by name and count; nothing is created without it (the list
//     must be ticked, and until the confirm the tables are as they were);
//   - a label nobody decided creates nothing: each of its rows is listed with its reason (plant: an unmatched label
//     that defaults to "create" turns the "nothing is created" case red);
//   - F8: a label with a match opens on "use existing"; one without opens undecided;
//   - F7: a schedule that changed between the preview and the confirm is refused, with what changed, and nothing is
//     written; the fresh preview can then be confirmed;
//   - the steps are reachable by keyboard and named for a screen reader, and no state is said by colour alone.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN,
  FILE_HEADERS,
  FILE_ROWS,
  ORG,
  SAVED,
  SEASON,
  SEASON_ROW,
  TEAMS,
  fileCsv,
  seedGameImportWorld,
} from './helpers/gameImportWorld.js';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: '0a000000-0000-4000-8000-000000000001', name: 'Placeholder League' },
    currentSeasonSetting: {
      id: '0a000000-0000-4000-8000-000000000002',
      name: 'Fall 2026',
      status: 'active',
      season_start: '2026-09-07',
      season_end: '2027-03-31',
      timezone: 'America/Los_Angeles',
    },
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

const { default: ScheduleImportPanel } =
  await import('../frontend/src/components/import/ScheduleImportPanel.jsx');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');

/** A table of the mock, read through the client as the app reads it. */
async function table(name, filter = (q) => q) {
  // this league's rows only: the mock also carries its own demonstration league
  const { data, error } = await filter(
    mockSupabase.from(name).select('*').eq('organization_id', ORG)
  );
  if (error) throw new Error(`${name}: ${error.message}`);
  return data ?? [];
}
const upload = (csv = fileCsv(), name = 'schedule.csv') =>
  fireEvent.change(screen.getByTestId('schedule-import-file'), {
    target: { files: [new File([csv], name, { type: 'text/csv' })] },
  });
const step = () => screen.getByTestId('schedule-import-step').textContent;
const toMapping = async () => {
  upload();
  await waitFor(() => expect(step()).toMatch(/2 of 4/));
};
const choose = (name, value) =>
  fireEvent.change(screen.getByRole('combobox', { name: `What ${name} is` }), {
    target: { value },
  });
const toPreview = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Preview the import' }));
  await waitFor(() => expect(step()).toMatch(/3 of 4/));
};
const count = (key) => Number(screen.getByTestId(`schedule-import-count-${key}`).textContent);
/** The choices that reach every outcome of the file (the header of helpers/gameImportWorld.js lists them). */
const decideEverything = () => {
  choose('Visiting Club A (U05 Boys)', 'outside');
  choose('Field 9 (Venue A)', 'create');
  choose('U07 Girls', 'create');
  choose('U07G Team 01 (U07 Girls)', 'create');
  choose('U07G Team 02 (U07 Girls)', 'create');
};

beforeEach(() => {
  seedGameImportWorld();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('upload: the file is read by the server, and what it kept or refused is said', () => {
  it('stages the file and lists the rows it kept and changed, and the rows it cannot import', async () => {
    render(<ScheduleImportPanel />);
    expect(step()).toMatch(/1 of 4/);
    await toMapping();
    expect(screen.getByTestId('schedule-import-staged').textContent).toMatch(
      /13 rows read\. 10 placed games, 2 with no time \(TIME TBD\), 1 that cannot be imported\./
    );
    // the column the allowlist does not hold is named, and its values are in no table
    expect(screen.getByTestId('schedule-import-staged').textContent).toMatch(/not stored: Notes/);
    expect(JSON.stringify(await table('staging_import_rows'))).not.toContain('placeholder note');
    // F5: a time and a week the import cannot read are kept rows, said
    const kept = screen.getByTestId('schedule-import-upload-warnings').textContent;
    expect(kept).toMatch(/Row 8: The start time "25:00".*TIME TBD/);
    expect(kept).toMatch(/Row 13: The week "three".*week 9/);
    expect(screen.getByTestId('schedule-import-upload-refused').textContent).toMatch(
      /Row 10: "13\/04\/2026" is not a date/
    );
    // one job, for this season, waiting for its confirm
    const jobs = await table('import_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ job_type: 'games', status: 'ready_to_apply', season_settings_id: SEASON });
  });

  it('refuses a file with a missing column before anything is created, in words', async () => {
    render(<ScheduleImportPanel />);
    const headers = FILE_HEADERS.filter((h) => h !== 'Venue');
    upload([headers.join(','), headers.map(() => 'x').join(',')].join('\n'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/no "Venue" column/);
    expect(step()).toMatch(/1 of 4/);
    expect(await table('import_jobs')).toHaveLength(0);
  });

  it('reads no file in a demo: the notice is asked for instead', async () => {
    const onDemoBlocked = vi.fn();
    render(<ScheduleImportPanel isDemo onDemoBlocked={onDemoBlocked} />);
    upload();
    expect(onDemoBlocked).toHaveBeenCalledTimes(1);
    expect(await table('import_jobs')).toHaveLength(0);
    expect(step()).toMatch(/1 of 4/);
  });
});

describe('mapping (F8): a match opens on "use existing", no match opens undecided', () => {
  it('opens each label on what is known about it', async () => {
    render(<ScheduleImportPanel />);
    await toMapping();
    // matched: one record of that name, in its division and in its venue
    expect(screen.getByRole('combobox', { name: 'What U05B Team 01 (U05 Boys) is' }).value).toBe(
      `map:${TEAMS.t1}`
    );
    expect(screen.getByRole('combobox', { name: 'What U05 Boys is' }).value).toMatch(/^map:/);
    expect(screen.getByRole('combobox', { name: 'What Field 1 (Venue A) is' }).value).toMatch(/^map:/);
    // CONTROL: no record of that name, so nothing is chosen for the admin (never "create")
    for (const name of [
      'Visiting Club A (U05 Boys)',
      'Mystery Team (U05 Boys)',
      'Field 9 (Venue A)',
      'U07 Girls',
    ]) {
      expect(screen.getByRole('combobox', { name: `What ${name} is` }).value).toBe('undecided');
    }
    // said in words beside each, not by colour
    expect(screen.getAllByText('Not decided: its rows will not be imported.').length).toBe(4);
    // a team of a division nobody decided is not asked about yet
    expect(screen.queryByRole('combobox', { name: 'What U07G Team 01 (U07 Girls) is' })).toBeNull();
    choose('U07 Girls', 'create');
    expect(screen.getByRole('combobox', { name: 'What U07G Team 01 (U07 Girls) is' }).value).toBe(
      'undecided'
    );
  });

  it('lets the admin map a label to any record in its place, and turn a match down', async () => {
    render(<ScheduleImportPanel />);
    await toMapping();
    const mystery = screen.getByRole('combobox', { name: 'What Mystery Team (U05 Boys) is' });
    // every team of the division is offered, not only a same-named one
    expect(within(mystery).getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining([
        'Use existing team: U05B Team 06',
        'Create the team "Mystery Team" (no players or coach yet)',
        'Outside club (not one of your teams)',
        'Skip its rows',
      ])
    );
    choose('Mystery Team (U05 Boys)', `map:${TEAMS.t6}`);
    // turning a match down leaves the label undecided (the proposal does not come back)
    choose('U05B Team 05 (U05 Boys)', 'undecided');
    expect(screen.getByRole('combobox', { name: 'What U05B Team 05 (U05 Boys) is' }).value).toBe(
      'undecided'
    );
    await toPreview();
    // row 11 now imports (mapped), and the rows of the label turned down do not
    const refused = screen.getByTestId('schedule-import-refused').textContent;
    expect(refused).not.toMatch(/Row 11:/);
    expect(refused).toMatch(/Row 12:.*U05B Team 05/);
  });
});

describe('confirm: everything that will be created is listed, and nothing is created without it', () => {
  it('an unmatched label nobody decided creates nothing: each of its rows is listed with its reason', async () => {
    render(<ScheduleImportPanel />);
    await toMapping();
    await toPreview();
    expect(screen.getByTestId('schedule-import-creations').textContent).toMatch(
      /What will be created \(0\).*Nothing: every game uses records you already have/
    );
    // game slots are places in time, counted apart; no division, venue, field, team or club is made
    const refused = screen.getByTestId('schedule-import-refused');
    expect(within(refused).getByRole('heading').textContent).toBe('Rows that will not be imported (5)');
    const lines = within(refused).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual([
      expect.stringMatching(/^Row 5: The team "Visiting Club A" is not one of your teams/),
      expect.stringMatching(/^Row 6: The field "Field 9" is not one of "Venue A"'s/),
      expect.stringMatching(/^Row 7: The division "U07 Girls" is not one of yours/),
      expect.stringMatching(/^Row 10: "13\/04\/2026" is not a date/),
      expect.stringMatching(/^Row 11: The team "Mystery Team" is not one of your teams/),
    ]);
    expect(count('rows.refused')).toBe(5);
    // no tick is asked for when nothing is created
    expect(screen.queryByTestId('schedule-import-create-ack')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
    await waitFor(() => expect(step()).toMatch(/4 of 4/));
    // read back: no record was created for a label nobody decided
    expect(await table('teams')).toHaveLength(6);
    expect(await table('divisions')).toHaveLength(1);
    expect(await table('fields')).toHaveLength(2);
    expect((await table('teams')).some((t) => t.is_external)).toBe(false);
  });

  it('lists every created record by name and count, holds the confirm until the list is ticked, then creates exactly that', async () => {
    render(<ScheduleImportPanel />);
    await toMapping();
    decideEverything();
    await toPreview();

    const created = screen.getByTestId('schedule-import-creations');
    expect(within(created).getByRole('heading').textContent).toBe('What will be created (5)');
    expect(screen.getByTestId('schedule-import-created-divisions').textContent).toBe('Divisions: 1U07 Girls');
    expect(screen.getByTestId('schedule-import-created-fields').textContent).toBe('Fields: 1Field 9');
    expect(screen.getByTestId('schedule-import-created-teamShells').textContent).toBe(
      'Teams (no players or coach yet): 2U07G Team 01, U07G Team 02'
    );
    expect(screen.getByTestId('schedule-import-created-outsideTeams').textContent).toBe(
      'Outside clubs: 1Visiting Club A'
    );
    expect(screen.queryByTestId('schedule-import-created-venues')).toBeNull();

    // every count of the preview, as the dry run gave it
    expect(
      Object.fromEntries(
        [
          'rows.staged',
          'rows.games',
          'rows.time_tbd',
          'rows.refused',
          'rows.skipped',
          'games.inserted',
          'games.updated',
          'games.unchanged',
          'time_tbd.inserted',
          'created.slots',
          'not_in_file',
        ].map((key) => [key, count(key)])
      )
    ).toEqual({
      'rows.staged': 13,
      'rows.games': 9,
      'rows.time_tbd': 2,
      'rows.refused': 2,
      'rows.skipped': 0,
      'games.inserted': 7,
      'games.updated': 1,
      'games.unchanged': 0,
      'time_tbd.inserted': 2,
      'created.slots': 8,
      not_in_file: 1,
    });
    // the Published game the file would move is named as left alone, and the flagged conflict is said in words
    expect(screen.getByTestId('schedule-import-skipped-games').textContent).toMatch(
      /Row 2: The game is Published and the file would change it/
    );
    const flagged = screen.getByTestId('schedule-import-warnings').textContent;
    expect(flagged).toMatch(/Field Field 1: Two games are on one field at overlapping times\./);
    expect(flagged).toMatch(/Row 12: The Week in the file is not the week the date falls in\./);
    expect(screen.getByTestId('schedule-import-kept-warnings').textContent).toMatch(/Row 8:.*Row 13:/);
    // declared, not implied: what was not checked
    expect(screen.getByTestId('schedule-import-coverage').textContent).toMatch(
      /Not checked by the import: coach overlap, hosting balance/
    );

    // NOTHING is written yet, and the confirm waits for the list to be ticked
    expect(await table('teams')).toHaveLength(6);
    expect(await table('divisions')).toHaveLength(1);
    expect(await table('game_assignments')).toHaveLength(3);
    const confirm = screen.getByRole('button', { name: 'Confirm and import' });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Create the 5 records listed above'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(step()).toMatch(/4 of 4/));

    // read back through the client: exactly the listed records, and the games
    const teams = await table('teams');
    expect(teams.filter((t) => t.is_external).map((t) => t.name)).toEqual(['Visiting Club A']);
    expect(
      teams
        .filter((t) => !t.is_external)
        .map((t) => t.name)
        .filter((n) => n.startsWith('U07G'))
        .sort()
    ).toEqual(['U07G Team 01', 'U07G Team 02']);
    expect((await table('divisions')).map((d) => d.name).sort()).toEqual(['U05 Boys', 'U07 Girls']);
    expect((await table('fields')).map((f) => f.name).sort()).toEqual(['Field 1', 'Field 2', 'Field 9']);
    const games = await table('game_assignments');
    expect(games).toHaveLength(10); // 3 saved + 7 added
    // the new games arrive Published; the saved game the file moved keeps its own state
    expect(games.filter((g) => g.import_job_id && g.published).length).toBe(7);
    expect(games.find((g) => g.id === SAVED.open)).toMatchObject({ published: false });
    expect(await table('schedule_tbd')).toHaveLength(2);
    expect(screen.getByTestId('schedule-import-applied').textContent).toMatch(
      /Imported: 7 games added, 1 changed, 2 TIME TBD games added\. The new games are Published\./
    );
  });

  it('PLANT GUARD: the count of what is created is the dry run’s, and the names beside it are as many', async () => {
    // The names come from core's resolution of the staged rows and the number from the dry run. If the two ever
    // differed the list would lie in one direction or the other; this holds them to each other on the every-outcome file.
    render(<ScheduleImportPanel />);
    await toMapping();
    decideEverything();
    await toPreview();
    for (const key of ['divisions', 'fields', 'teamShells', 'outsideTeams']) {
      const text = screen.getByTestId(`schedule-import-created-${key}`).textContent;
      const [, n, names] = /: (\d+)(.*)$/.exec(text);
      expect(names.split(', ').length).toBe(Number(n));
    }
  });
});

describe('F7: a preview that went stale is refused at the confirm, and nothing is written', () => {
  it('says what changed, writes nothing, and applies the fresh preview once it is confirmed again', async () => {
    render(<ScheduleImportPanel />);
    await toMapping();
    decideEverything();
    await toPreview();
    expect(count('games.updated')).toBe(1);

    // Another admin publishes the saved game the file would move, between the preview and the confirm (the
    // production path: the Published switch's RPC).
    const published = await mockSupabase.rpc('admin_set_games_published', {
      p_organization_id: ORG,
      p_assignment_ids: [SAVED.open],
      p_published: true,
      p_reason_code: null,
      p_note: null,
      p_scope: { kind: 'selection', value: 'test' },
    });
    expect(published.error).toBeNull();

    fireEvent.click(screen.getByLabelText('Create the 5 records listed above'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
    const staleNotice = await screen.findByTestId('schedule-import-stale');
    expect(staleNotice.getAttribute('role')).toBe('alert');
    expect(staleNotice.textContent).toMatch(/The schedule changed after this preview was made/);
    expect(staleNotice.textContent).toMatch(/Games changed: was 1, now 0/);
    // nothing was written: no new game, no created record, the job still waits
    expect(await table('game_assignments')).toHaveLength(3);
    expect(await table('teams')).toHaveLength(6);
    expect((await table('import_jobs'))[0].status).toBe('ready_to_apply');
    // the fresh preview is on screen, and it must be confirmed again (the tick is asked for again)
    expect(step()).toMatch(/3 of 4/);
    expect(count('games.updated')).toBe(0);
    const confirm = screen.getByRole('button', { name: 'Confirm and import' });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Create the 5 records listed above'));
    fireEvent.click(confirm);
    await waitFor(() => expect(step()).toMatch(/4 of 4/));
    expect(await table('game_assignments')).toHaveLength(10);
  });

  it('CONTROL: an unchanged schedule applies at the first confirm', async () => {
    render(<ScheduleImportPanel />);
    await toMapping();
    decideEverything();
    await toPreview();
    fireEvent.click(screen.getByLabelText('Create the 5 records listed above'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
    await waitFor(() => expect(step()).toMatch(/4 of 4/));
    expect(screen.queryByTestId('schedule-import-stale')).toBeNull();
  });
});

describe('the result, the rollback, and the import that can still be rolled back after a reload', () => {
  const applyEverything = async () => {
    await toMapping();
    decideEverything();
    await toPreview();
    fireEvent.click(screen.getByLabelText('Create the 5 records listed above'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
    await waitFor(() => expect(step()).toMatch(/4 of 4/));
  };

  it('rolls the import back from the result screen: the schedule is as it was', async () => {
    const before = await table('game_assignments');
    render(<ScheduleImportPanel />);
    await applyEverything();
    fireEvent.click(screen.getByRole('button', { name: 'Roll back this import' }));
    const done = await screen.findByTestId('schedule-import-rolled-back');
    expect(done.textContent).toMatch(/The import was rolled back: 7 games removed, 3 put back as they were\./);
    const after = await table('game_assignments');
    expect(after.map((g) => g.id).sort()).toEqual(before.map((g) => g.id).sort());
    expect(after.find((g) => g.id === SAVED.open)).toMatchObject({
      start: before.find((g) => g.id === SAVED.open).start,
    });
    expect(await table('schedule_tbd')).toHaveLength(0);
    expect((await table('teams')).some((t) => t.is_external)).toBe(false);
    // the roll back is offered once
    expect(screen.queryByRole('button', { name: 'Roll back this import' })).toBeNull();
  });

  it('offers the roll back of the last import to a panel opened later, and takes it', async () => {
    const first = render(<ScheduleImportPanel />);
    await applyEverything();
    first.unmount();
    render(<ScheduleImportPanel />);
    const last = await screen.findByTestId('schedule-import-last');
    expect(last.textContent).toMatch(/schedule\.csv: 7 games added, 1 changed, 2 TIME TBD games added\./);
    fireEvent.click(within(last).getByRole('button', { name: 'Roll back the last import' }));
    await screen.findByTestId('schedule-import-rolled-back');
    expect(await table('game_assignments')).toHaveLength(3);
    expect(screen.queryByTestId('schedule-import-last')).toBeNull();
  });

  it('says a refused roll back in the database’s words (a game was changed since)', async () => {
    render(<ScheduleImportPanel />);
    await applyEverything();
    const imported = (await table('game_assignments')).find((g) => g.external_ref === 'N-1');
    const allowed = await mockSupabase.rpc('admin_set_games_published', {
      p_organization_id: ORG,
      p_assignment_ids: [imported.id],
      p_published: false,
      p_reason_code: 'field-change',
      p_note: null,
      p_scope: { kind: 'selection', value: 'test' },
    });
    expect(allowed.error).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Roll back this import' }));
    const alert = await screen.findByTestId('schedule-import-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toMatch(/cannot be rolled back/);
    expect(await table('game_assignments')).toHaveLength(10);
  });
});

describe('accessibility: keyboard, names, and no state by colour alone', () => {
  it('moves focus to the step heading when the step changes, and every control has a name', async () => {
    render(<ScheduleImportPanel />);
    const panel = screen.getByTestId('schedule-import-panel');
    expect(panel.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Import a game schedule' })).toBeTruthy();
    // the file input is a real input behind a label (keyboard reachable), limited to CSV
    const input = screen.getByLabelText('Choose a CSV file');
    expect(input.getAttribute('type')).toBe('file');
    expect(input.getAttribute('accept')).toBe('.csv');
    await toMapping();
    expect(document.activeElement).toBe(screen.getByTestId('schedule-import-step'));
    // every select is named by the label it decides; every table header is a header
    for (const select of screen.getAllByRole('combobox')) {
      expect(select.getAttribute('aria-label')).toMatch(/^What .+ is$/);
    }
    expect(screen.getAllByRole('columnheader').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByRole('rowheader').length).toBeGreaterThanOrEqual(8);
    await toPreview();
    expect(document.activeElement).toBe(screen.getByTestId('schedule-import-step'));
    // both checkboxes are labelled by their text
    expect(screen.getByLabelText(/Games arrive Published/)).toBeTruthy();
  });

  it('uses no hardcoded colour and no inline style (tokens only)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('frontend/src/components/import/ScheduleImportPanel.jsx', 'utf8');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\bstyle=\{/);
    expect(source).not.toMatch(/rgba?\(/);
  });

  it('"Games arrive Published" off: the preview is made again and the games arrive unpublished', async () => {
    render(<ScheduleImportPanel />);
    await toMapping();
    decideEverything();
    await toPreview();
    fireEvent.click(screen.getByLabelText(/Games arrive Published/));
    await waitFor(() => expect(screen.getByLabelText(/Games arrive Published/).checked).toBe(false));
    await waitFor(() => expect(screen.queryByTestId('schedule-import-busy')).toBeNull());
    fireEvent.click(screen.getByLabelText('Create the 5 records listed above'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
    await waitFor(() => expect(step()).toMatch(/4 of 4/));
    const games = await table('game_assignments');
    expect(games.filter((g) => g.import_job_id && g.published)).toHaveLength(0);
    expect(screen.getByTestId('schedule-import-applied').textContent).not.toMatch(/are Published/);
  });
});

describe('the file of the world reaches what the tests above name (a check over less would pass)', () => {
  it('has thirteen rows and the admin of the seeded session', () => {
    expect(FILE_ROWS).toHaveLength(13);
    expect(JSON.parse(sessionStorage.getItem('__MOCK_SESSION__')).user.id).toBe(ADMIN);
    expect(SEASON_ROW.timezone).toBe('America/Los_Angeles');
  });
});
