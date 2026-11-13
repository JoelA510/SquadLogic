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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALIAS_CSV,
  DIVISIONS,
  ORG,
  SPRING_ROWS,
  TEAMS,
  fileCsv,
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
  seedPracticeImportWorld();
});
afterEach(() => {
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
  it('saves the ticked division’s settings with its other rules as stored, and leaves the others alone', async () => {
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
    const sent = callsOf(rpc, 'admin_upsert_division_settings');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      p_division_id: DIVISIONS.u10,
      p_practice_minutes: 60,
      // the division's other rules, sent as they are stored (the RPC sets every one it is given)
      p_max_roster_size: 12,
      p_min_roster_size: 8,
      p_target_team_size: 10,
      p_min_teams: 2,
      p_max_teams: 6,
    });
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
