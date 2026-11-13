// @vitest-environment jsdom
//
// The Practices tab of the Import panel (plan docs/changes/2026-11-03-schedule-expansion.md 4.11.5 and 4.11.6; PR 11,
// task L2): a `kind` of PR 6's panel, driven through the REAL mock client. The file is staged by the mock's
// `import-validation`, mapped, previewed (the database's dry run) and applied by the mock's practice import RPCs, and
// every assertion about what was written reads the mock's tables back through that same client.
//
// What it holds:
//   - nothing is created without the confirm: the list names and counts everything to be created, and the confirm is
//     refused until it is ticked (until then the tables are as they were);
//   - each row that is not imported is listed with its reason in words, the database's new reasons too (`slot-differs`
//     naming what differs, the blank-cell reasons, a hold's ground, a coach conflict), and no state is said by colour;
//   - an alias is a proposal: shown with its source, applied only when chosen;
//   - only a ticked division setting is sent, with the division's other rules as they are stored;
//   - the probable moves are the database's: shown as team-level lines, the case named in words, the arriving rows
//     unticked by default, and only a ticked row is sent (`options.add_moved_rows`); a spring file over fall practices
//     pairs nothing;
//   - the import is rolled back from its result.
import React from 'react';
import Papa from 'papaparse';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALIAS_CSV,
  FILE_ROWS,
  FILE_HEADERS,
  DIVISIONS,
  HALF_A,
  HALF_CA,
  VENUE_C,
  ORG,
  SPRING_ROWS,
  TEAMS,
  fileCsv,
  pinWorldClock,
  seedPracticeImportWorld,
} from './helpers/practiceImportWorld.js';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: '0b000000-0000-4000-8000-000000000001', name: 'Placeholder League' },
    currentSeasonSetting: {
      id: '0b000000-0000-4000-8000-000000000002',
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

/** A table of the mock, this league's rows only, read through the client as the app reads it. */
async function table(name) {
  const { data, error } = await mockSupabase.from(name).select('*').eq('organization_id', ORG);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data ?? [];
}
const step = () => screen.getByTestId('schedule-import-step').textContent;
const upload = (csv = fileCsv(), name = 'practices.csv') =>
  fireEvent.change(screen.getByTestId('schedule-import-file'), {
    target: { files: [new File([csv], name, { type: 'text/csv' })] },
  });
const toMapping = async (csv) => {
  upload(csv);
  await waitFor(() => expect(step()).toMatch(/2 of 4/), { timeout: 5000 });
  // the tab's steps are their own chunk: wait for it
  await screen.findByTestId('practice-import-staged', {}, { timeout: 5000 });
};
const choose = (name, value) =>
  fireEvent.change(screen.getByRole('combobox', { name: `What ${name} is` }), {
    target: { value },
  });
/** @param {string} name @returns {HTMLSelectElement} */
const select = (name) =>
  /** @type {HTMLSelectElement} */ (screen.getByRole('combobox', { name: `What ${name} is` }));
/** @param {string} name @returns {HTMLButtonElement} */
const button = (name) => /** @type {HTMLButtonElement} */ (screen.getByRole('button', { name }));
/** @param {string | RegExp} label @returns {HTMLInputElement} */
const checkbox = (label) => /** @type {HTMLInputElement} */ (screen.getByLabelText(label));
const toPreview = async () => {
  fireEvent.click(button('Preview the import'));
  await waitFor(() => expect(step()).toMatch(/3 of 4/), { timeout: 5000 });
};
const count = (key) => Number(screen.getByTestId(`practice-import-count-${key}`).textContent);
/** Every new label created, U10B-05 skipped, the Annex mapped to Venue A (the choices that reach every outcome). */
const decideEverything = () => {
  choose('Venue A Annex', `map:0b000000-0000-4000-8000-000000000020`);
  choose('U14 Boys', 'create');
  choose('Venue B', 'create');
  choose('Field 9 (Venue B)', 'create');
  choose('C (Venue A, Field 2)', 'create');
  choose('U14B-01 (U14 Boys)', 'create');
  choose('U10B-05 (U10 Boys)', 'skip');
};
/** The calls the panel made of one RPC. */
const callsOf = (spy, name) => spy.mock.calls.filter(([rpc]) => rpc === name).map(([, p]) => p);
const storedMapping = async () =>
  (await table('import_jobs')).find((j) => j.job_type === 'practice_schedule')?.warning_summary
    ?.practice_mapping;

beforeEach(() => {
  // the TIME TBD rebuild reads the date: pinned, so the answer does not change as the real date passes
  pinWorldClock(vi);
  seedPracticeImportWorld();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the template', () => {
  it('names exactly the columns core reads, in core’s order (the template cannot name a column the import drops)', async () => {
    const { CSV_TEMPLATES } = await import('../frontend/src/utils/csvTemplates.js');
    const { PRACTICE_IMPORT_TEMPLATE_HEADER } =
      await import('../packages/core/src/practiceImport/parseRows.js');
    expect(CSV_TEMPLATES.practice_schedule.headers).toEqual([...PRACTICE_IMPORT_TEMPLATE_HEADER]);
    expect(CSV_TEMPLATES.practice_schedule.example).toHaveLength(
      PRACTICE_IMPORT_TEMPLATE_HEADER.length
    );
  });
});

describe('upload: the server reads the file, and says what it kept and what it cannot import', () => {
  it('stages the whole file, names the column it dropped, and lists the refused rows with their reasons', async () => {
    const invoke = vi.spyOn(mockSupabase.functions, 'invoke');
    render(<ScheduleImportPanel kind="practices" />);
    expect(step()).toMatch(/1 of 4/);
    await toMapping();
    // one request, the whole file (the parse judges the file as a whole)
    const calls = /** @type {Array<[string, any]>} */ (
      invoke.mock.calls.filter(([name]) => name === 'import-validation')
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][1].body).toMatchObject({ import_type: 'practice_schedule', action: 'stage' });
    expect(calls[0][1].body.rows).toHaveLength(15);
    // the Coach column never left the browser, and is named as not read
    expect(JSON.stringify(calls[0][1].body.rows)).not.toContain('Placeholder Coach');
    expect(screen.getByTestId('practice-import-staged').textContent).toMatch(
      /15 rows read\. 10 practices, 2 open slots, 1 held cell, 2 that cannot be imported\. Columns not read and not stored: Coach\./
    );
    expect(JSON.stringify(await table('staging_import_rows'))).not.toContain('Placeholder Coach');
    const refused = screen.getByTestId('schedule-import-upload-refused').textContent;
    expect(refused).toMatch(/Row 12: "Funday" is not a day this import reads/);
    expect(refused).toMatch(/Row 13: The Location is blank\./);
  });
});

describe('mapping: proposals and their sources; nothing guessed', () => {
  it('an exact name opens on "use existing"; a new label opens undecided; an alias is proposed with its source and not applied', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    expect(select('U10 Boys').value).toBe(`map:${DIVISIONS.u10}`);
    expect(select('U14 Boys').value).toBe('undecided');
    // the alias file is read in the browser (never uploaded) and proposes; nothing is chosen for the admin
    fireEvent.change(screen.getByLabelText('Choose an alias file (optional)'), {
      target: { files: [new File([ALIAS_CSV], 'aliases.csv', { type: 'text/csv' })] },
    });
    await waitFor(() =>
      expect(screen.getByTestId('practice-import-alias-summary').textContent).toMatch(
        /aliases\.csv: 1 alias read/
      )
    );
    const annex = select('Venue A Annex');
    expect(annex.value).toBe('undecided');
    const row = annex.closest('tr');
    expect(
      within(/** @type {HTMLElement} */ (row)).getByText(/Proposed by the alias file: Venue A/)
    ).toBeTruthy();
    // chosen, it is stored with the source it came from
    choose('Venue A Annex', `map:0b000000-0000-4000-8000-000000000020`);
    await toPreview();
    const mapping = await storedMapping();
    const annexKey = Object.keys(mapping.locations).find((k) => k.includes('annex'));
    expect(mapping.locations[annexKey]).toEqual({
      action: 'map',
      id: '0b000000-0000-4000-8000-000000000020',
      source: 'alias',
    });
    expect(Object.values(mapping.divisions).map((d) => d.source)).toEqual(['exact', 'exact']);
  });

  it('a label nobody decided creates nothing: each of its rows is listed with its reason', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    await toPreview();
    const refused = screen.getByTestId('practice-import-refused').textContent;
    expect(refused).toMatch(/Row 9: .*location/i);
    expect(refused).toMatch(/Row 10: .*division/i);
    expect(screen.getByTestId('practice-import-creations').textContent).toMatch(
      /Nothing: every practice uses records you already have/
    );
  });
});

describe('the confirm: nothing is created until the list of what will be created is ticked', () => {
  it('lists every record to be created by name and count, says venues get no coordinates, and creates nothing before it', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    const before = {
      divisions: (await table('divisions')).length,
      locations: (await table('locations')).length,
      teams: (await table('teams')).length,
      practices: (await table('practice_assignments')).length,
    };
    await toPreview();
    const created = screen.getByTestId('practice-import-creations').textContent;
    expect(created).toMatch(/Divisions: 1\s*U14 Boys/);
    expect(created).toMatch(/Locations: 1\s*Venue B/);
    expect(created).toMatch(/Fields: 1\s*Field 9/);
    expect(created).toMatch(/Halves and sides: 1\s*C/);
    expect(created).toMatch(/Teams \(no players or coach yet\): 1\s*U14B-01/);
    expect(created).toMatch(/Practice slots: 9/);
    expect(created).toMatch(/no coordinates/);
    const confirm = button('Confirm and import');
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect({
      divisions: (await table('divisions')).length,
      locations: (await table('locations')).length,
      teams: (await table('teams')).length,
      practices: (await table('practice_assignments')).length,
    }).toEqual(before);
    fireEvent.click(checkbox(/Create the \d+ records listed above/));
    expect(button('Confirm and import').disabled).toBe(false);
    fireEvent.click(button('Confirm and import'));
    await waitFor(() => expect(step()).toMatch(/4 of 4/), { timeout: 5000 });
    expect(screen.getByTestId('practice-import-applied').textContent).toMatch(
      /7 practices added, 1 already saved, 1 held back/
    );
    expect((await table('divisions')).length).toBe(before.divisions + 1);
    expect((await table('practice_assignments')).length).toBe(before.practices + 7);
  });
});

describe('every reason in words, never colour alone', () => {
  it('slot-differs names what differs; the blank-cell reasons, the hold and the coach conflict are said', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    await toPreview();
    const refused = screen.getByTestId('practice-import-refused').textContent;
    expect(refused).toMatch(
      /Row 14: The slot is saved already with another end, capacity or last date.*its end is 17:00, the row's 17:30/
    );
    expect(refused).toMatch(/Row 13: .*The Location is blank\./);
    expect(refused).toMatch(/Row 12: .*"Funday" is not a day/);
    expect(screen.getByTestId('practice-import-holds').textContent).toMatch(
      /Row 6: held for a non-team activity; it makes no slot/
    );
    const flagged = screen.getByTestId('practice-import-flagged').textContent;
    expect(flagged).toMatch(/Row 1: A coach has two teams in overlapping slots on one weekday/);
    expect(flagged).toMatch(/also coaches U12G-01/);
    // a record id is not words
    expect(refused + flagged).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(screen.getByTestId('practice-import-flags').textContent).toMatch(
      /A coach has two teams in overlapping slots on one weekday: 2 rows, 2 teams/
    );
    expect(screen.getByTestId('practice-import-coverage').textContent).toMatch(
      /Checked: .*Not checked: coach preference rules.*Coach overlap was judged only for the 2 teams \(of 8\) that have a coach assigned\./
    );
    const short = screen.getByTestId('practice-import-short').textContent;
    expect(short).toMatch(/U12G-02: 1 practice short/);
    expect(short).toMatch(/U12G-03: 1 practice short/);
  });
});

describe('division settings from the file: one tick each, and only a ticked one is sent', () => {
  it('saves the ticked division’s practice settings alone, its other rules untouched, and leaves the others alone', async () => {
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    const settings = screen.getByTestId('practice-import-settings');
    expect(settings.textContent).toMatch(/U10 Boys.*length 60 minutes \(stored: any length\)/);
    // unticked by default
    expect(checkbox('Save these settings for U10 Boys').checked).toBe(false);
    expect(checkbox('Save these settings for U12 Girls').checked).toBe(false);
    fireEvent.click(checkbox('Save these settings for U10 Boys'));
    await toPreview();
    expect(screen.getByTestId('practice-import-settings-pending').textContent).toMatch(
      /U10 Boys: practice length 60 minutes/
    );
    fireEvent.click(checkbox(/Create the \d+ records listed above/));
    fireEvent.click(button('Confirm and import'));
    await waitFor(() => expect(step()).toMatch(/4 of 4/), { timeout: 5000 });
    await waitFor(() =>
      expect(screen.getByTestId('practice-import-settings-saved').textContent).toMatch(
        /Saved: U10 Boys/
      )
    );
    // the practice-only setter (F11-4b B3): the practice settings and nothing else, so the roster rules are not sent
    expect(callsOf(rpc, 'admin_upsert_division_settings')).toEqual([]);
    expect(callsOf(rpc, 'admin_set_division_practice_settings')).toEqual([
      { p_division_id: DIVISIONS.u10, p_practices_per_week: null, p_practice_minutes: 60 },
    ]);
    const u10 = (await table('divisions')).find((d) => d.id === DIVISIONS.u10);
    expect(u10).toMatchObject({ practice_minutes: 60, practices_per_week: 1, max_roster_size: 12 });
    const u12 = (await table('divisions')).find((d) => d.id === DIVISIONS.u12);
    expect(u12).toMatchObject({ practices_per_week: 2, practice_minutes: 60 });
  });
});

describe('probable moves: the database’s, team by team, unticked until ticked', () => {
  it('names the case in words, shows the team-level line, and sends no unticked row', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    await toPreview();
    const moves = screen.getByTestId('practice-import-moves');
    expect(within(moves).getByTestId('practice-import-moves-held').textContent).toMatch(
      /These teams already have saved practices in these dates; their new rows are held back until you tick them\./
    );
    expect(moves.textContent).toMatch(/U10B-03: 1 row leaving, 1 row arriving/);
    const tick = checkbox("Add U10B-03's 1 new row");
    expect(tick.checked).toBe(false);
    expect(count('held_back')).toBe(1);
    fireEvent.click(checkbox(/Create the \d+ records listed above/));
    fireEvent.click(button('Confirm and import'));
    await waitFor(() => expect(step()).toMatch(/4 of 4/), { timeout: 5000 });
    expect((await storedMapping()).options.add_moved_rows).toEqual([]);
    const u10b03 = (await table('practice_assignments')).filter(
      (pa) => pa.team_id === TEAMS['U10B-03']
    );
    // its saved practice stays, and its new one was not added
    expect(u10b03).toHaveLength(1);
  });

  it('a ticked team sends its rows, after the preview is made again with the tick; the confirm waits for it', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    await toPreview();
    fireEvent.click(checkbox("Add U10B-03's 1 new row"));
    // a tick is not in the preview yet: the confirm waits for the preview made with it
    expect(button('Confirm and import').disabled).toBe(true);
    expect(screen.getByTestId('practice-import-ticks-changed').textContent).toMatch(
      /Make the preview again/
    );
    fireEvent.click(button('Update the preview with these ticks'));
    await waitFor(() => expect(count('held_back')).toBe(0));
    expect((await storedMapping()).options.add_moved_rows).toEqual(['row-7']);
    fireEvent.click(checkbox(/Create the \d+ records listed above/));
    fireEvent.click(button('Confirm and import'));
    await waitFor(() => expect(step()).toMatch(/4 of 4/), { timeout: 5000 });
    expect(
      (await table('practice_assignments')).filter((pa) => pa.team_id === TEAMS['U10B-03'])
    ).toHaveLength(2);
  });

  it('"Tick all probable moves" ticks every team’s rows', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    await toPreview();
    fireEvent.click(button('Tick all probable moves'));
    expect(checkbox("Add U10B-03's 1 new row").checked).toBe(true);
    fireEvent.click(button('Update the preview with these ticks'));
    await waitFor(() => expect(count('held_back')).toBe(0));
    expect((await storedMapping()).options.add_moved_rows).toEqual(['row-7']);
  });

  it('a spring file over fall practices: no team is paired and nothing is held back', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping(fileCsv(SPRING_ROWS));
    decideEverything();
    await toPreview();
    expect(screen.queryByTestId('practice-import-moves')).toBeNull();
    expect(count('held_back')).toBe(0);
    expect(count('leaving')).toBe(0);
  });
});

describe('the result and the roll back', () => {
  it('says the practices are saved and locked, and rolls the import back', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    await toPreview();
    fireEvent.click(checkbox(/Create the \d+ records listed above/));
    fireEvent.click(button('Confirm and import'));
    await waitFor(() => expect(step()).toMatch(/4 of 4/), { timeout: 5000 });
    expect(screen.getByTestId('practice-import-applied').textContent).toMatch(
      /saved practices are locked/i
    );
    const before = (await table('practice_assignments')).length;
    fireEvent.click(button('Roll back this import'));
    await waitFor(() =>
      expect(screen.getByTestId('schedule-import-rolled-back').textContent).toMatch(
        /The import was rolled back: 7 practices removed/
      )
    );
    expect((await table('practice_assignments')).length).toBe(before - 7);
    expect((await table('divisions')).some((d) => d.name === 'U14 Boys')).toBe(false);
  });
});

describe('the review round of #732', () => {
  it('C1: an alias file with a column twice is refused, never read with one copy dropped', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    const twice = 'Alias,Location,Field,Location\r\nVenue A Annex,Venue A,,Venue B\r\n';
    fireEvent.change(screen.getByLabelText('Choose an alias file (optional)'), {
      target: { files: [new File([twice], 'aliases.csv', { type: 'text/csv' })] },
    });
    await waitFor(() =>
      expect(screen.getByTestId('practice-import-alias-summary').textContent).toMatch(
        /aliases\.csv could not be read: the file has the column "Location" more than once/
      )
    );
    // nothing it says is proposed
    expect(screen.queryByText(/Proposed by the alias file/)).toBeNull();
  });

  it('1: a division the import creates is offered no setting, says where to set it, and the screens say a roll back keeps settings', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    expect(screen.queryByLabelText('Save these settings for U14 Boys')).toBeNull();
    expect(screen.getByTestId('practice-import-settings').textContent).toMatch(
      /U14 Boys \(created by this import\).*set them on the Team Analysis page after you confirm/
    );
    fireEvent.click(checkbox('Save these settings for U10 Boys'));
    await toPreview();
    expect(screen.getByTestId('practice-import-settings-pending').textContent).toMatch(
      /A roll back of this import does not undo them\./
    );
    fireEvent.click(checkbox(/Create the \d+ records listed above/));
    fireEvent.click(button('Confirm and import'));
    await waitFor(() => expect(step()).toMatch(/4 of 4/), { timeout: 5000 });
    fireEvent.click(button('Roll back this import'));
    await waitFor(() =>
      expect(screen.getByTestId('schedule-import-rolled-back').textContent).toMatch(
        /Division practice settings saved with the import are not undone by a roll back\./
      )
    );
    // the division the import created is gone with the roll back (no setting made it differ)
    expect((await table('divisions')).some((d) => d.name === 'U14 Boys')).toBe(false);
  });

  it('3: a team mapped in a division whose label then moves to another division goes back to undecided, and its old id is not sent', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    choose('U10B-05 (U10 Boys)', `map:${TEAMS['U10B-04']}`);
    expect(select('U10B-05 (U10 Boys)').value).toBe(`map:${TEAMS['U10B-04']}`);
    choose('U10 Boys', `map:${DIVISIONS.u12}`);
    expect(select('U10B-05 (U10 Boys)').value).toBe('undecided');
    const row = select('U10B-05 (U10 Boys)').closest('tr');
    expect(
      within(/** @type {HTMLElement} */ (row)).getByText(
        'Not decided: its rows will not be imported.'
      )
    ).toBeTruthy();
    await toPreview();
    const mapping = await storedMapping();
    expect(JSON.stringify(mapping.teams)).not.toContain(TEAMS['U10B-04']);
  });

  it('C3: the result shows the teams short as counted again after the ticked settings were saved', async () => {
    const { mockSyncScheduleTbdPractices } =
      await import('../frontend/src/lib/mockPracticeImport.js');
    // The mock's refresh rebuilds nothing (not mirrored, its header says); the SQL's rebuild is stood in by PR 10's twin.
    const realRpc = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) => {
      const answer = await realRpc(name, params);
      if (name === 'refresh_schedule_tbd_practices' && !answer.error) {
        const db = /** @type {any} */ (window).__MOCK_DB__;
        mockSyncScheduleTbdPractices(
          db,
          ORG,
          '0b000000-0000-4000-8000-000000000002',
          new Date().toISOString().slice(0, 10),
          () => globalThis.crypto.randomUUID(),
          new Date().toISOString()
        );
        /** @type {any} */ (window).__saveMockDB__(db);
      }
      return answer;
    });
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    // U12 Girls: the file holds one practice a week per team, two are stored
    expect(screen.getByTestId('practice-import-settings').textContent).toMatch(
      /U12 Girls: 1 a week \(stored: 2\)/
    );
    fireEvent.click(checkbox('Save these settings for U12 Girls'));
    await toPreview();
    // CONTROL: before the settings, the two U12 Girls teams are short
    expect(screen.getByTestId('practice-import-short').textContent).toMatch(
      /U12G-02: 1 practice short/
    );
    fireEvent.click(checkbox(/Create the \d+ records listed above/));
    fireEvent.click(button('Confirm and import'));
    await waitFor(() => expect(step()).toMatch(/4 of 4/), { timeout: 5000 });
    await waitFor(() =>
      expect(screen.getByTestId('practice-import-settings-saved').textContent).toMatch(
        /Saved: U12 Girls/
      )
    );
    const short = screen.queryByTestId('practice-import-result-short')?.textContent ?? '';
    expect(short).not.toMatch(/U12G-02/);
    expect(short).not.toMatch(/U12G-03/);
    expect(short).toMatch(/Counted again after the division settings were saved\./);
  });

  it('C4: a half chosen under a field whose location is remapped is judged in the new scope, and its old id is not sent', async () => {
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping();
    decideEverything();
    // Venue A and Venue C each have a "Field 1" with a half "A"
    choose('A (Venue A, Field 1)', `map:${HALF_A}`);
    expect(select('A (Venue A, Field 1)').value).toBe(`map:${HALF_A}`);
    choose('Venue A', `map:${VENUE_C}`);
    // the field's exact match is now Venue C's Field 1, so the half goes back to what is proposed there: its half A
    expect(select('Field 1 (Venue A)').value).toBe('map:0b000000-0000-4000-8000-000000000026');
    expect(select('A (Venue A, Field 1)').value).toBe(`map:${HALF_CA}`);
    await toPreview();
    const mapping = await storedMapping();
    expect(JSON.stringify(mapping.subunits)).not.toContain(HALF_A);
  });
});

describe('Codex C5 and C6 on #732', () => {
  /** A CSV of the file's rows under `headers`: a filler column carries a value the import must never store. */
  const wideCsv = (headers) =>
    Papa.unparse({
      fields: headers,
      data: FILE_ROWS.map((r) =>
        headers.map((h) => (FILE_HEADERS.includes(h) ? (r[h] ?? '') : `unread ${h}`))
      ),
    });
  const filler = (n, from = 0) => Array.from({ length: n }, (_, i) => `Extra ${from + i}`);

  it('C5, the follow-up of #734: a 250-column file with Team at column 230 imports, and its Team is read', async () => {
    const rest = FILE_HEADERS.filter((h) => h !== 'Team');
    const headers = [...rest, ...filler(229 - rest.length), 'Team'];
    headers.push(...filler(250 - headers.length, 217));
    expect(headers).toHaveLength(250);
    expect(headers.indexOf('Team')).toBe(229);
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping(wideCsv(headers));
    // the upload summary names the columns that are not stored, the wide ones among them
    const said = screen.getByTestId('practice-import-staged').textContent;
    expect(said).toMatch(/Columns not read and not stored: .*Coach/);
    expect(said).toMatch(/Extra 0, /);
    expect(said).toMatch(/Extra 236\./);
    const staged = (await table('staging_import_rows')).filter(
      (r) => r.import_type === 'practice_schedule'
    );
    expect(staged).toHaveLength(FILE_ROWS.length);
    // the Team past column 200 was read: the first row is U10B-01's placement, not an open slot
    const first = staged.find((r) => Number(r.source_row_number) === 1);
    expect(first.normalized_payload).toMatchObject({ status: 'placement', team: 'U10B-01' });
    // and nothing of a column the import does not read was stored
    expect(JSON.stringify(staged)).not.toContain('unread');
  });

  it('review of #739: a header with markup (<b>Day</b>) is read by its cleaned name, as the stage reads it', async () => {
    const headers = FILE_HEADERS.map((h) => (h === 'Day' ? '<b>Day</b>' : h));
    const csv = Papa.unparse({
      fields: headers,
      data: FILE_ROWS.map((r) => FILE_HEADERS.map((h) => r[h] ?? '')),
    });
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping(csv);
    const staged = (await table('staging_import_rows')).filter(
      (r) => r.import_type === 'practice_schedule'
    );
    expect(staged).toHaveLength(FILE_ROWS.length);
    const first = staged.find((r) => Number(r.source_row_number) === 1);
    expect(first.normalized_payload).toMatchObject({ day: 'tue', team: 'U10B-01' });
  });

  it('review of #739: a header with markup given twice (<b>Team</b>) is refused on upload, and no job is made', async () => {
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    const headers = [...FILE_HEADERS.map((h) => (h === 'Team' ? '<b>Team</b>' : h)), '<b>Team</b>'];
    const csv = Papa.unparse({
      fields: headers,
      data: FILE_ROWS.map((r) => [...FILE_HEADERS.map((h) => r[h] ?? ''), 'U99B-99']),
    });
    render(<ScheduleImportPanel kind="practices" />);
    upload(csv, 'repeat.csv');
    await waitFor(() =>
      expect(screen.getByTestId('schedule-import-error').textContent).toMatch(/more than once/)
    );
    expect(step()).toMatch(/1 of 4/);
    expect(rpc.mock.calls.filter(([name]) => name === 'create_import_job')).toEqual([]);
    expect(await table('staging_import_rows')).toEqual([]);
  });

  it('C5, the follow-up of #734: a 201-column file with no column it reads past 200 imports', async () => {
    const headers = [...FILE_HEADERS, ...filler(201 - FILE_HEADERS.length)];
    expect(headers).toHaveLength(201);
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping(wideCsv(headers));
    const staged = (await table('staging_import_rows')).filter(
      (r) => r.import_type === 'practice_schedule'
    );
    expect(staged).toHaveLength(FILE_ROWS.length);
  });
});

describe('Codex C8 on #732', () => {
  it('two teams the import creates, each short of its count, are named in the preview and the result', async () => {
    const extra = [
      { ...FILE_ROWS[10], Team: 'U12G-08', Subunit: '', Start: '13:00', End: '14:00' },
      { ...FILE_ROWS[10], Team: 'U12G-09', Subunit: '', Start: '14:00', End: '15:00' },
    ];
    render(<ScheduleImportPanel kind="practices" />);
    await toMapping(fileCsv([...FILE_ROWS, ...extra]));
    decideEverything();
    choose('U12G-08 (U12 Girls)', 'create');
    choose('U12G-09 (U12 Girls)', 'create');
    await toPreview();
    const before = screen.getByTestId('practice-import-short').textContent;
    expect(before).toMatch(/U12G-08: 1 practice short/);
    expect(before).toMatch(/U12G-09: 1 practice short/);
    expect(before).not.toMatch(/A team this import creates/);
    fireEvent.click(checkbox(/Create the \d+ records listed above/));
    fireEvent.click(button('Confirm and import'));
    await waitFor(() => expect(step()).toMatch(/4 of 4/), { timeout: 5000 });
    const after = screen.getByTestId('practice-import-result-short').textContent;
    expect(after).toMatch(/U12G-08: 1 practice short/);
    expect(after).toMatch(/U12G-09: 1 practice short/);
    expect(after).not.toMatch(/A team this import creates/);
  });
});
