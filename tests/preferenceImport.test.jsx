/**
 * The practice preference import screen (Phase D C2): reading a file, the preview of what it will do,
 * running the import, and the result.
 *
 * Three layers, each with the plant that turns it red:
 *
 * 1. `readPreferenceFile`: which columns are read and uploaded, which rows the file check refuses.
 *    Plant (a): let a column the import does not read through `keptRows` -> the ignored-column and
 *    upload tests go red.
 * 2. The preview against the mock client's own pipeline (`import-validation` staging and the
 *    finalizer, itself held to the SQL by `tests/coachPreferencesMock.test.js`): every count the
 *    preview promises equals the one the finalizer returns, over one file that exercises every
 *    outcome. Plant (b): stop counting an identical rule once in the preview -> that test goes red.
 * 3. The panel: choose a file, see the preview, import, see the result; the empty file, the file whose
 *    only team is unknown, a missing column, a completed season, a demo, a failed import.
 */

import React from 'react';
import Papa from 'papaparse';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import PreferenceImportPanel from '../frontend/src/components/preferences/PreferenceImportPanel.jsx';
import CoachPreferencesPage from '../frontend/src/pages/CoachPreferencesPage.jsx';
import ToastHost from '../frontend/src/components/ui/ToastHost.jsx';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { useAuth } from '../frontend/src/contexts/AuthContext.jsx';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { makeDedupeHeaderTransformer } from '../frontend/src/utils/gotsportCanonicalizer.js';
import { canonicalImportKey, isAllowedImportKey } from '../frontend/src/utils/importAllowlist.js';
import {
  PREFERENCE_TEMPLATE,
  preferenceTemplateCsv,
  readPreferenceFile,
} from '../frontend/src/utils/practicePreferenceFile.js';
import { sanitizeImportText } from '../frontend/src/utils/importRows.js';
import { previewPracticePreferenceImport } from '../frontend/src/utils/practicePreferenceImportPreview.js';
import {
  MAX_IMPORT_ROWS,
  STAGE_CHUNK_SIZE,
  runPracticePreferenceImport,
} from '../frontend/src/utils/practicePreferenceImportRun.js';
import { seedMockDb } from './helpers/seedMockDb.js';
import { databaseIsoDate } from '../frontend/src/utils/coachPreferencePreview.js';
import {
  ADMIN_USER,
  C1,
  ORG,
  SEASON,
  T1,
  T2,
  T3,
  freshMockDb,
  ruleRow,
} from './helpers/preferenceTables.js';

const demo = vi.hoisted(() => ({ isDemo: false }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({ useOrganization: vi.fn() }));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({ useAuth: vi.fn() }));
vi.mock('../frontend/src/hooks/useDemo.js', () => ({ useDemo: () => demo }));
vi.mock('../frontend/src/lib/supabaseClient.js', async () => ({
  supabase: (await import('../frontend/src/lib/mockSupabaseClient.js')).mockSupabase,
}));
// Every paged read takes a moment, as a network read does: without it the mock answers inside one
// task, React never draws the "reading again" state, and a refresh that takes a panel down is
// invisible to the page-level test below.
vi.mock('../frontend/src/lib/pagedFetch.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    fetchAllPages: async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return actual.fetchAllPages(...args);
    },
  };
});
vi.mock('../frontend/src/components/DemoImportNotice.jsx', () => ({
  default: ({ open }) =>
    open ? <div role="dialog" aria-label="Importing is turned off in the demo" /> : null,
}));

const HEADER =
  'Coach Email,Team,Request Level,Days,Start Times,Venues,Effective From,Effective Until,Priority';

/** CSV text -> what the panel reads: headers (after the duplicate rename) and rows. */
function parseCsv(text) {
  const results = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: makeDedupeHeaderTransformer(),
  });
  return { headers: results.meta.fields ?? [], rows: results.data };
}

/** The panel's props for the fixture season: the coaches, teams and rosters of `freshMockDb`. */
function panelContext(db) {
  return {
    loading: false,
    error: null,
    previewError: null,
    coaches: db.coaches.filter((coach) => coach.season_settings_id === SEASON),
    locations: db.locations,
    rosterRows: db.team_coach_assignments,
    teams: db.teams,
    divisions: db.divisions,
    practiceRows: db.practice_assignments,
  };
}

let db;
const seed = () => {
  // The mock keeps its last write on `window` as well as in sessionStorage; both are replaced. The
  // tables go in through the sanctioned seeder (tests/mockDeleteTombstones.test.js counts direct writes).
  delete window.__MOCK_DB__;
  sessionStorage.removeItem('__MOCK_DB__');
  seedMockDb(db);
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: ADMIN_USER } }));
};
const stored = () => JSON.parse(sessionStorage.getItem('__MOCK_DB__') ?? '{}');

beforeEach(() => {
  demo.isDemo = false;
  db = freshMockDb();
  seed();
});
afterEach(() => {
  delete window.__MOCK_DB__;
  sessionStorage.removeItem('__MOCK_DB__');
  sessionStorage.removeItem('__MOCK_SESSION__');
});

describe('reading a file', () => {
  it('every column of the template is one the import reads, so the template cannot ask for a column that is dropped', () => {
    for (const header of PREFERENCE_TEMPLATE.headers) {
      expect(isAllowedImportKey('practice_preferences', canonicalImportKey(header)), header).toBe(
        true
      );
    }
    // And the example rows are real rows: parsed back, none is refused by the file check.
    const parsed = parseCsv(preferenceTemplateCsv());
    const read = readPreferenceFile(parsed);
    expect(parsed.rows).toHaveLength(PREFERENCE_TEMPLATE.examples.length);
    expect(read.refused).toEqual([]);
    expect(read.ignoredColumns).toEqual([]);
    expect(read.hasEmailColumn && read.hasRuleColumn).toBe(true);
  });

  it('keeps only the columns the import reads: the rest are named as ignored and never in keptRows', () => {
    const parsed = parseCsv(
      'Timestamp,Your name,Coach Email,Comments,Days\n2026-09-01,Casey,casey@example.test,"Please, Tuesdays",Tuesday\n'
    );
    const read = readPreferenceFile(parsed);
    expect(read.ignoredColumns).toEqual(['Timestamp', 'Your name', 'Comments']);
    expect(read.keptRows).toEqual([{ 'Coach Email': 'casey@example.test', Days: 'Tuesday' }]);
    expect(JSON.stringify(read.keptRows)).not.toMatch(/Please|Casey,|2026-09-01/);
    expect(read.staged).toEqual([
      { row: 1, payload: { email: 'casey@example.test', weekdays: 'Tuesday' } },
    ]);
  });

  it('refuses a row with no email or a malformed one as the file check does, and counts rows from the first under the header', () => {
    const read = readPreferenceFile(
      parseCsv(
        `${HEADER}\n,Hawks,prefer,Monday,,,,,\nnot-an-email,Hawks,prefer,Monday,,,,,\nok@example.test,Hawks,prefer,Monday,,,,,\n`
      )
    );
    expect(read.refused).toEqual([
      { row: 1, message: 'Missing required field: email' },
      { row: 2, message: 'Invalid email format' },
    ]);
    expect(read.staged.map((entry) => entry.row)).toEqual([3]);
  });

  it('says when the file has no email column or no day, time or venue column', () => {
    expect(readPreferenceFile(parseCsv('Team,Days\nHawks,Monday\n')).hasEmailColumn).toBe(false);
    expect(
      readPreferenceFile(parseCsv('Coach Email,Team\na@example.test,Hawks\n')).hasRuleColumn
    ).toBe(false);
  });

  it('cleans a cell as the Edge function does: tags and control characters out, trimmed, capped', () => {
    expect(sanitizeImportText('  <b>Hawks</b>\u0007 ')).toBe('Hawks');
    expect(sanitizeImportText(null)).toBe('');
    expect(sanitizeImportText('x'.repeat(600))).toHaveLength(500);
    // The cleaner is the one the Edge function and the mock use (importRowsParity holds them equal),
    // so the staged rows of a file with nested markup are what the preview read.
    expect(sanitizeImportText('<<script>script>')).toBe('script>');
    expect(sanitizeImportText('<scr<script>ipt>')).toBe('ipt>');
    // A lone bracket is data ("<1", "5 > 3") and stays.
    expect(sanitizeImportText('<1')).toBe('<1');
  });
});

/** One file that reaches every outcome the finalizer counts. */
const EVERY_OUTCOME = [
  HEADER,
  // 1: a must for Hawks, two days and two times, high priority.
  'casey@example.test,U10 Hawks,must,Tuesday and Thursday,5:00 PM; 6:00 PM,,,,high',
  // 2: no team: a rule for each team Casey coaches (Hawks and Owls), with a window.
  'casey@example.test,,prefer,Monday,,Riverside Park,2026-09-01,2026-10-31,',
  // 3: row 1 written the other way round: one rule, counted once.
  'casey@example.test,U10 Hawks,MUST,Thu / Tue,"17:00, 18:00",,,,High',
  // 4: a coach not in the file of coaches.
  'nobody@example.test,U10 Hawks,prefer,Monday,,,,,',
  // 5: a team that does not exist.
  'casey@example.test,U99 Ghosts,prefer,Monday,,,,,',
  // 6: a coach who coaches no team named a team they do not coach.
  'robin@example.test,U10 Hawks,prefer,Monday,,,,,',
  // 7: no team named, and the coach coaches none.
  'robin@example.test,,prefer,Monday,,,,,',
  // 8: a day that is not a day.
  'casey@example.test,U10 Hawks,prefer,Funday,,,,,',
  // 9: no condition at all.
  'casey@example.test,U10 Hawks,prefer,,,,,,',
  // 10: last season's coach is not in this season.
  'last@example.test,U10 Hawks,prefer,Monday,,,,,',
  // 11: no email: refused by the file check before any rule is read.
  ',U10 Hawks,prefer,Monday,,,,,',
  // 12: a venue by name, on the other team Casey coaches.
  'casey@example.test,U12 Owls,prefer,,,North Fields,,,low',
].join('\n');

describe('the preview equals what the import does', () => {
  /** The rules the file's teams already have: replaced, kept, or not named. */
  const seedExistingRules = () => {
    db.coach_practice_preferences = [
      // An imported rule on Hawks, accepted as a must: replaced, and comes back pending.
      ruleRow({
        id: 'old-import-hawks',
        team_id: T1,
        level: 'must',
        requested_level: 'must',
        must_decision: 'accepted',
        weekdays: ['FRI'],
        import_job_id: 'job-old',
      }),
      // An imported rule on a team the file does not name: kept.
      ruleRow({ id: 'old-import-wrens', team_id: T3, weekdays: ['SAT'], import_job_id: 'job-old' }),
      // A rule an admin added on Hawks: kept.
      ruleRow({
        id: 'admin-hawks',
        team_id: T1,
        source: 'admin',
        import_job_id: null,
        weekdays: ['SUN'],
      }),
    ];
    seed();
  };

  const previewOf = (read, extra = {}) =>
    previewPracticePreferenceImport({
      staged: read.staged,
      context: {
        seasonId: SEASON,
        coaches: db.coaches,
        teams: db.teams,
        divisions: db.divisions,
        assignments: db.team_coach_assignments,
        locations: db.locations,
        ruleRows: db.coach_practice_preferences,
        today: databaseIsoDate(),
        ...extra,
      },
    });

  const COUNT_KEYS = [
    'inserted_rules',
    'replaced_rules',
    'teams_named',
    'pending_musts',
    'duplicate_rule_rows',
    'invalid_rows',
    'unknown_coach_rows',
    'unknown_team_rows',
    'no_team_rows',
    'coach_not_on_team_rows',
  ];

  it('every count the preview shows is the finalizer’s, over a file that reaches every outcome', async () => {
    seedExistingRules();
    const read = readPreferenceFile(parseCsv(EVERY_OUTCOME));
    const preview = previewOf(read);

    // The file reaches every outcome (a preview of nothing proves nothing): each count is non-zero.
    for (const key of COUNT_KEYS) expect(preview[key], key).toBeGreaterThan(0);
    expect(read.refused).toHaveLength(1);

    const before = stored().coach_practice_preferences.map((row) => row.id);
    const run = await runPracticePreferenceImport({
      supabase: mockSupabase,
      organizationId: ORG,
      seasonSettingsId: null,
      fileName: 'prefs.csv',
      rows: read.keptRows,
    });
    for (const key of COUNT_KEYS) expect(run.result[key], key).toBe(preview[key]);
    expect(run.result.validation_error_rows).toBe(read.refused.length);
    expect(run.result.status).toBe('completed_with_warnings');

    // The unknown coaches and teams listed are the same rows.
    expect(run.result.unknown_coaches.map((item) => [item.row, item.email])).toEqual(
      preview.refusals.filter((r) => r.kind === 'unknown_coach').map((r) => [r.row, r.email])
    );
    expect(run.result.unknown_teams.map((item) => [item.row, item.team])).toEqual(
      preview.refusals.filter((r) => r.kind === 'unknown_team').map((r) => [r.row, r.team])
    );

    // The rules written are the rules previewed, team by team; the replaced ones are the ones named.
    const after = stored().coach_practice_preferences;
    const added = after.filter((row) => !before.includes(row.id));
    const key = (r) =>
      [
        r.team_id,
        r.coach_id,
        r.requested_level,
        r.weekdays,
        r.start_minutes,
        r.venue_ids,
        r.coach_priority,
      ].join('|');
    expect(added.map(key).sort()).toEqual(
      preview.rules
        .map((r) =>
          [
            r.teamId,
            r.coachId,
            r.requestedLevel,
            r.weekdays,
            r.startMinutes,
            r.venueIds,
            r.coachPriority,
          ].join('|')
        )
        .sort()
    );
    const replaced = after.filter((row) => row.status === 'replaced').map((row) => row.id);
    expect(replaced).toEqual(['old-import-hawks']);
    expect(preview.accepted_musts_replaced).toBe(1);
    // Kept: the admin's rule and the rule of a team the file does not name.
    expect(after.find((row) => row.id === 'admin-hawks').status).toBe('in_force');
    expect(after.find((row) => row.id === 'old-import-wrens').status).toBe('in_force');
    // A requested must is in force as prefer, pending.
    expect(added.filter((row) => row.must_decision === 'pending')).toHaveLength(
      preview.pending_musts
    );
    expect(added.every((row) => row.level === 'prefer')).toBe(true);
  });

  it('markup in a cell is cleaned the same way by the preview and by the pipeline it previews', async () => {
    // A team written with a tag in it resolves to the team; nested or split markup is cleaned to the
    // same text on both sides (an unknown team, named alike), never left with a bracket.
    const csv = [
      HEADER,
      'casey@example.test,U10 <i></i>Hawks,prefer,Monday,,,,,',
      'casey@example.test,<<b>b>U12 Owls,prefer,Tuesday,,,,,',
      'casey@example.test,U12 <scr<script>ipt>Owls,prefer,Wednesday,,,,,',
    ].join('\n');
    const read = readPreferenceFile(parseCsv(csv));
    const preview = previewOf(read);
    expect(preview.rules.map((rule) => rule.teamName)).toEqual(['U10 Hawks']);
    expect(preview.refusals.map((refusal) => refusal.team)).toEqual(['b>U12 Owls', 'U12 ipt>Owls']);
    expect(preview.unknown_team_rows).toBe(2);
    // No tag is left in a cell, though the lone '>' the nested markup leaves is data.
    expect(read.staged.every(({ payload }) => !Object.values(payload).some(hasTagSpan))).toBe(true);

    const run = await runPracticePreferenceImport({
      supabase: mockSupabase,
      organizationId: ORG,
      seasonSettingsId: null,
      fileName: 'markup.csv',
      rows: read.keptRows,
    });
    expect(run.result.inserted_rules).toBe(preview.inserted_rules);
    expect(run.result.unknown_team_rows).toBe(preview.unknown_team_rows);
    expect(run.result.unknown_teams.map((item) => item.team)).toEqual(
      preview.refusals.map((refusal) => refusal.team)
    );
    // What the finalizer reads is the cleaned payload: no tag reaches it, and it is what was previewed.
    const payloads = stored().staging_import_rows.map((row) => row.normalized_payload);
    expect(payloads).toHaveLength(3);
    expect(payloads.every((payload) => !Object.values(payload).some(hasTagSpan))).toBe(true);
    expect(payloads.map((payload) => payload.team)).toEqual(
      read.staged.map(({ payload }) => payload.team)
    );
  });

  it('a blank team makes one rule for each team the coach coaches, and the preview says which', () => {
    const read = readPreferenceFile(
      parseCsv(`${HEADER}\ncasey@example.test,,prefer,Monday,,,,,\n`)
    );
    const preview = previewOf(read);
    expect(preview.inserted_rules).toBe(2);
    expect(preview.teams_named).toBe(2);
    expect(preview.fanOut).toEqual([
      { row: 1, email: 'casey@example.test', teams: ['U10 Hawks', 'U12 Owls'] },
    ]);
    // An ended assignment (Wrens) is not a team the coach coaches today.
    expect(preview.rules.map((rule) => rule.teamId).sort()).toEqual([T1, T2].sort());
  });

  it('a file whose only team is unknown applies nothing, replaces nothing and says so', () => {
    db.coach_practice_preferences = [
      ruleRow({ id: 'keep-me', team_id: T1, weekdays: ['SAT'], import_job_id: 'job-old' }),
    ];
    const read = readPreferenceFile(
      parseCsv(`${HEADER}\ncasey@example.test,U99 Ghosts,prefer,Monday,,,,,\n`)
    );
    const preview = previewOf(read);
    expect(preview).toMatchObject({
      inserted_rules: 0,
      replaced_rules: 0,
      teams_named: 0,
      unknown_team_rows: 1,
      nothingToApply: true,
    });
  });

  it('is exact about "today": a coach whose assignment ended yesterday coaches nothing, one who starts today does', () => {
    db.team_coach_assignments = [
      {
        id: 'a',
        organization_id: ORG,
        team_id: T1,
        coach_id: C1,
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: '2026-09-27',
      },
      {
        id: 'b',
        organization_id: ORG,
        team_id: T2,
        coach_id: C1,
        role: 'lead',
        effective_from: '2026-09-28',
        effective_to: null,
      },
    ];
    const read = readPreferenceFile(
      parseCsv(`${HEADER}\ncasey@example.test,,prefer,Monday,,,,,\n`)
    );
    const preview = previewOf(read, { today: '2026-09-28' });
    expect(preview.rules.map((rule) => rule.teamId)).toEqual([T2]);
    expect(previewOf(read, { today: '2026-09-27' }).rules.map((rule) => rule.teamId)).toEqual([T1]);
  });
});

describe('running an import', () => {
  const rows = [{ 'Coach Email': 'casey@example.test', Team: 'U10 Hawks', Days: 'Tuesday' }];

  it('stages the rows in chunks of the stated size, each numbered from the file’s first row', async () => {
    const invoke = vi.spyOn(mockSupabase.functions, 'invoke');
    const many = Array.from({ length: STAGE_CHUNK_SIZE + 5 }, (_, index) => ({
      'Coach Email': 'casey@example.test',
      Team: index % 2 ? 'U10 Hawks' : 'U12 Owls',
      Days: 'Tuesday',
    }));
    await runPracticePreferenceImport({
      supabase: mockSupabase,
      organizationId: ORG,
      seasonSettingsId: null,
      fileName: 'many.csv',
      rows: many,
    });
    const calls = /** @type {any[][]} */ (invoke.mock.calls).filter(
      ([name]) => name === 'import-validation'
    );
    expect(calls.map(([, options]) => [options.body.row_offset, options.body.rows.length])).toEqual(
      [
        [0, STAGE_CHUNK_SIZE],
        [STAGE_CHUNK_SIZE, 5],
      ]
    );
    expect(calls[0][1].body).toMatchObject({
      import_type: 'practice_preferences',
      organization_id: ORG,
    });
    invoke.mockRestore();
  });

  it('refuses a file past the row limit before it creates a job', async () => {
    const create = vi.spyOn(mockSupabase, 'rpc');
    await expect(
      runPracticePreferenceImport({
        supabase: mockSupabase,
        organizationId: ORG,
        seasonSettingsId: null,
        fileName: 'big.csv',
        rows: new Array(MAX_IMPORT_ROWS + 1).fill({ 'Coach Email': 'a@example.test' }),
      })
    ).rejects.toThrow(/limit is 10000/);
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });

  it('names a draft season on the job, and none for the active one', async () => {
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    await runPracticePreferenceImport({
      supabase: mockSupabase,
      organizationId: ORG,
      seasonSettingsId: 'season-draft',
      fileName: 'draft.csv',
      rows,
    });
    const created = rpc.mock.calls.find(([name]) => name === 'create_import_job');
    expect(created[1]).toMatchObject({
      p_import_type: 'practice_preferences',
      p_season_settings_id: 'season-draft',
    });
    rpc.mockClear();
    await runPracticePreferenceImport({
      supabase: mockSupabase,
      organizationId: ORG,
      seasonSettingsId: null,
      fileName: 'active.csv',
      rows,
    });
    expect(rpc.mock.calls.find(([name]) => name === 'create_import_job')[1]).not.toHaveProperty(
      'p_season_settings_id'
    );
    rpc.mockRestore();
  });

  it('a failure after the job exists marks the job failed and throws the database’s own message', async () => {
    const real = mockSupabase.rpc;
    const rpc = vi
      .spyOn(mockSupabase, 'rpc')
      .mockImplementation(async (name, args) =>
        name === 'finalize_practice_preference_import_job'
          ? { data: null, error: { code: '22023', message: 'planted refusal from the finalizer' } }
          : real.call(mockSupabase, name, args)
      );
    await expect(
      runPracticePreferenceImport({
        supabase: mockSupabase,
        organizationId: ORG,
        seasonSettingsId: null,
        fileName: 'fails.csv',
        rows,
      })
    ).rejects.toThrow('planted refusal from the finalizer');
    expect(rpc.mock.calls.map(([name]) => name)).toContain('fail_import_job');
    const job = stored().import_jobs.find((item) => item.storage_path.endsWith('fails.csv'));
    expect(job.status).toBe('failed');
    rpc.mockRestore();
  });
});

/** A tag span left in `text`: a `<` with a `>` somewhere after it. */
const hasTagSpan = (text) => {
  const open = text.indexOf('<');
  return open !== -1 && text.indexOf('>', open) !== -1;
};

/** Choose a CSV file in the panel's file input. */
const choose = (name, text) => {
  const input = screen.getByLabelText('Choose a CSV file');
  fireEvent.change(input, {
    target: { files: [new File([text], name, { type: 'text/csv' })] },
  });
};

describe('the panel', () => {
  const renderPanel = (over = {}) => {
    const props = {
      orgId: ORG,
      seasonId: SEASON,
      seasonIsActive: true,
      readOnly: false,
      context: panelContext(db),
      ruleRows: db.coach_practice_preferences,
      onImported: vi.fn(async () => {}),
      onReviewMusts: vi.fn(),
      ...over,
    };
    render(<PreferenceImportPanel {...props} />);
    return props;
  };

  it('previews a file before anything is sent, then imports it and reports the database’s counts', async () => {
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    const props = renderPanel();
    choose('prefs.csv', EVERY_OUTCOME);
    const preview = await screen.findByTestId('preference-import-preview');
    // Nothing has been created yet.
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain('create_import_job');
    expect(within(preview).getByText('Rules to add').nextSibling).toHaveTextContent('4');
    expect(within(preview).getByTestId('preview-fanout')).toHaveTextContent(
      'Row 2 (casey@example.test): U10 Hawks, U12 Owls'
    );
    expect(within(preview).getByTestId('preview-refused-unknown_coach')).toHaveTextContent(
      'nobody@example.test'
    );
    expect(within(preview).getByTestId('preview-refused-unknown_team')).toHaveTextContent(
      'U99 Ghosts'
    );
    expect(within(preview).getByTestId('preview-refused-server')).toHaveTextContent(
      'Missing required field: email'
    );
    expect(
      screen.getByRole('heading', { name: /What prefs.csv will do \(12 rows read\)/ })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Import 4 rules' }));
    const summary = await screen.findByTestId('preference-import-summary');
    expect(summary).toHaveTextContent('4 rules added for 2 teams');
    expect(summary).toHaveTextContent('1 must waiting for your decision');
    // The preview and the result agree, so the screen does not say they differ.
    expect(screen.queryByTestId('preference-import-differs')).not.toBeInTheDocument();
    const warnings = screen.getByTestId('preference-import-warnings');
    expect(warnings).toHaveTextContent('nobody@example.test');
    expect(warnings).toHaveTextContent('U99 Ghosts');
    expect(props.onImported).toHaveBeenCalledTimes(1);
    expect(
      stored().coach_practice_preferences.filter((r) => r.must_decision === 'pending')
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Review 1 pending must' }));
    expect(props.onReviewMusts).toHaveBeenCalledTimes(1);
    rpc.mockRestore();
  });

  it('uploads only the columns the import reads', async () => {
    const invoke = vi.spyOn(mockSupabase.functions, 'invoke');
    renderPanel();
    choose(
      'google-form.csv',
      'Timestamp,Your name,Coach Email,Team,Days,Comments\n2026-09-01,Casey Coach,casey@example.test,U10 Hawks,Tuesday,"my kid has allergies"\n'
    );
    await screen.findByTestId('preference-import-preview');
    expect(screen.getByTestId('preview-ignored')).toHaveTextContent(
      'Timestamp, Your name, Comments'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 rule' }));
    await screen.findByTestId('preference-import-summary');
    const sent = JSON.stringify(
      /** @type {any[][]} */ (invoke.mock.calls)
        .filter(([name]) => name === 'import-validation')
        .map(([, options]) => options.body)
    );
    expect(sent).toContain('casey@example.test');
    expect(sent).not.toMatch(/allergies|Casey Coach|Timestamp|2026-09-01/);
    // Nor is it stored: the staged row holds the payload and the raw row, both of kept columns.
    expect(JSON.stringify(stored().staging_import_rows)).not.toMatch(/allergies|Casey Coach/);
    invoke.mockRestore();
  });

  it('an empty file is refused in words and nothing is created', async () => {
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    renderPanel();
    choose('empty.csv', '');
    expect(await screen.findByTestId('preference-import-problem')).toHaveTextContent(
      'appears to be empty'
    );
    expect(screen.queryByTestId('preference-import-preview')).not.toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockRestore();
  });

  it('a header with no rows is refused in words', async () => {
    renderPanel();
    choose('header-only.csv', `${HEADER}\n`);
    expect(await screen.findByTestId('preference-import-problem')).toHaveTextContent(
      'header row and no rows'
    );
  });

  describe('a file the CSV parser could not read cleanly is refused whole, with the rows named', () => {
    const parseErrors = () => screen.findByTestId('preference-import-parse-errors');
    const nothingSent = (rpc) => {
      expect(rpc.mock.calls.map(([name]) => name)).not.toContain('create_import_job');
      expect(screen.queryByTestId('preference-import-preview')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Import \d+ rules?$/ })).not.toBeInTheDocument();
    };

    it('a row with more cells than the header is named, not read as its first cells', async () => {
      // An existing imported rule that a partial read would replace with a Tuesday-only rule.
      db.coach_practice_preferences = [
        ruleRow({ id: 'keep', team_id: T1, weekdays: ['MON', 'THU'], import_job_id: 'job-old' }),
      ];
      seed();
      const rpc = vi.spyOn(mockSupabase, 'rpc');
      renderPanel({ ruleRows: db.coach_practice_preferences });
      choose(
        'too-many.csv',
        'Coach Email,Team,Days\ncasey@example.test,U10 Hawks,Tuesday\ncasey@example.test,U10 Hawks,Tuesday,Thursday\n'
      );
      const list = await parseErrors();
      expect(list).toHaveTextContent('Row 2');
      expect(list).toHaveTextContent('Too many fields');
      // The message says which row and why, and quotes no cell.
      expect(list).not.toHaveTextContent(/Thursday|casey@example\.test|Hawks/);
      expect(list).toHaveAttribute('role', 'alert');
      nothingSent(rpc);
      expect(stored().coach_practice_preferences.find((r) => r.id === 'keep').status).toBe(
        'in_force'
      );
      rpc.mockRestore();
    });

    it('a row with fewer cells than the header is refused too (the cells would shift)', async () => {
      const rpc = vi.spyOn(mockSupabase, 'rpc');
      renderPanel();
      choose('too-few.csv', `${HEADER}\ncasey@example.test,U10 Hawks,Tuesday\n`);
      expect(await parseErrors()).toHaveTextContent('Row 1');
      expect(await parseErrors()).toHaveTextContent('Too few fields');
      nothingSent(rpc);
      rpc.mockRestore();
    });

    it('an unterminated quote is refused', async () => {
      const rpc = vi.spyOn(mockSupabase, 'rpc');
      renderPanel();
      choose(
        'quote.csv',
        'Coach Email,Team,Days\ncasey@example.test,"U10 Hawks,Tuesday\ncasey@example.test,U12 Owls,Monday\n'
      );
      const list = await parseErrors();
      expect(list).toHaveTextContent(/Quoted field unterminated/i);
      expect(list).not.toHaveTextContent(/U10 Hawks|U12 Owls/);
      nothingSent(rpc);
      rpc.mockRestore();
    });

    it('lists the first twenty rows and counts the rest', async () => {
      renderPanel();
      const rows = Array.from({ length: 25 }, () => 'casey@example.test,U10 Hawks,Tuesday,Extra');
      choose('many.csv', ['Coach Email,Team,Days', ...rows].join('\n'));
      const list = await parseErrors();
      expect(within(list).getAllByRole('listitem')).toHaveLength(20);
      expect(list).toHaveTextContent('and 5 more');
    });

    it('the control: a clean file with quoted commas has no parse errors and previews', async () => {
      renderPanel();
      choose(
        'clean.csv',
        'Coach Email,Team,Days,Venues\ncasey@example.test,U10 Hawks,"Tuesday, Thursday","Riverside Park"\n'
      );
      await screen.findByTestId('preference-import-preview');
      expect(screen.queryByTestId('preference-import-parse-errors')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import 1 rule' })).toBeEnabled();
    });

    it('the file control is emptied once a file is held, so fixing the file and choosing it again fires a change', async () => {
      renderPanel();
      const input = /** @type {HTMLInputElement} */ (screen.getByLabelText('Choose a CSV file'));
      choose(
        'too-many.csv',
        'Coach Email,Team,Days\ncasey@example.test,U10 Hawks,Tuesday,Thursday\n'
      );
      await parseErrors();
      expect(input.value).toBe('');
    });

    it('choosing a clean file after a refused one clears the refusal', async () => {
      renderPanel();
      choose(
        'too-many.csv',
        'Coach Email,Team,Days\ncasey@example.test,U10 Hawks,Tuesday,Thursday\n'
      );
      await parseErrors();
      choose('clean.csv', 'Coach Email,Team,Days\ncasey@example.test,U10 Hawks,Tuesday\n');
      await screen.findByTestId('preference-import-preview');
      expect(screen.queryByTestId('preference-import-parse-errors')).not.toBeInTheDocument();
    });
  });

  it('a file with no email column, or no day, time or venue column, says what to name', async () => {
    renderPanel();
    choose('no-email.csv', 'Team,Days\nU10 Hawks,Monday\n');
    expect(await screen.findByTestId('preference-import-problem')).toHaveTextContent(
      'no column for the coach’s email'
    );
    choose('no-rule.csv', 'Coach Email,Team\ncasey@example.test,U10 Hawks\n');
    await waitFor(() =>
      expect(screen.getByTestId('preference-import-problem')).toHaveTextContent(
        'no days, start times or venues column'
      )
    );
  });

  it('a file that is not a CSV is refused by its name', async () => {
    renderPanel();
    const input = screen.getByLabelText('Choose a CSV file');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'prefs.xlsx', { type: 'application/vnd.ms-excel' })] },
    });
    expect(await screen.findByTestId('preference-import-problem')).toHaveTextContent(
      'choose a CSV file'
    );
  });

  it('a file whose only team is unknown shows what it found and offers nothing to import', async () => {
    renderPanel();
    choose('ghosts.csv', `${HEADER}\ncasey@example.test,U99 Ghosts,prefer,Monday,,,,,\n`);
    const preview = await screen.findByTestId('preference-import-preview');
    expect(within(preview).getByTestId('preview-nothing')).toHaveTextContent(
      'Nothing in this file can be applied'
    );
    expect(within(preview).getByTestId('preview-refused-unknown_team')).toHaveTextContent(
      'U99 Ghosts'
    );
    const button = screen.getByRole('button', { name: 'Nothing to import' });
    expect(button).toBeDisabled();
  });

  it('re-importing says what it replaces, including an accepted must that comes back pending', async () => {
    db.coach_practice_preferences = [
      ruleRow({
        id: 'old',
        team_id: T1,
        level: 'must',
        requested_level: 'must',
        must_decision: 'accepted',
        weekdays: ['FRI'],
        import_job_id: 'job-old',
      }),
    ];
    seed();
    renderPanel({ ruleRows: db.coach_practice_preferences });
    choose('again.csv', `${HEADER}\ncasey@example.test,U10 Hawks,prefer,Monday,,,,,\n`);
    const preview = await screen.findByTestId('preference-import-preview');
    expect(within(preview).getByText('Imported rules replaced').nextSibling).toHaveTextContent('1');
    expect(preview).toHaveTextContent('1 accepted must comes back pending');
  });

  it('says when the result differs from the preview (the data changed in between)', async () => {
    renderPanel();
    choose('prefs.csv', `${HEADER}\ncasey@example.test,U10 Hawks,prefer,Monday,,,,,\n`);
    await screen.findByTestId('preference-import-preview');
    expect(screen.getByText('Imported rules replaced').nextSibling).toHaveTextContent('0');
    // Meanwhile another admin imports a file for Hawks, through the real pipeline: this file now
    // replaces a rule the preview did not know of.
    await runPracticePreferenceImport({
      supabase: mockSupabase,
      organizationId: ORG,
      seasonSettingsId: null,
      fileName: 'elsewhere.csv',
      rows: [{ 'Coach Email': 'casey@example.test', Team: 'U10 Hawks', Days: 'Friday' }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 rule' }));
    const differs = await screen.findByTestId('preference-import-differs');
    expect(differs).toHaveTextContent('rules replaced: previewed 0, applied 1');
    // Only what differs is named: the rule it adds is the one it promised.
    expect(differs).not.toHaveTextContent('rules added');
    // The screen still gives the database's numbers.
    expect(screen.getByTestId('preference-import-summary')).toHaveTextContent(
      '1 imported rule replaced'
    );
  });

  it('a failed import says so with the database’s message and does not report success', async () => {
    const real = mockSupabase.rpc;
    const rpc = vi
      .spyOn(mockSupabase, 'rpc')
      .mockImplementation(async (name, args) =>
        name === 'finalize_practice_preference_import_job'
          ? { data: null, error: { code: '42501', message: 'Access denied: planted' } }
          : real.call(mockSupabase, name, args)
      );
    const props = renderPanel();
    choose('prefs.csv', `${HEADER}\ncasey@example.test,U10 Hawks,prefer,Monday,,,,,\n`);
    await screen.findByTestId('preference-import-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 rule' }));
    expect(await screen.findByTestId('preference-import-problem')).toHaveTextContent(
      'Access denied: planted'
    );
    expect(screen.queryByTestId('preference-import-summary')).not.toBeInTheDocument();
    expect(props.onImported).not.toHaveBeenCalled();
    // The preview is still there to try again.
    expect(screen.getByRole('button', { name: 'Import 1 rule' })).toBeEnabled();
    rpc.mockRestore();
  });

  it('a completed season takes no file: the control is off and the panel says why', () => {
    renderPanel({ readOnly: true, seasonIsActive: false });
    expect(screen.getByLabelText('Choose a CSV file')).toBeDisabled();
    expect(screen.getByTestId('preference-import-readonly')).toHaveTextContent('takes no import');
  });

  it('a demo opens the notice instead of the file picker', () => {
    demo.isDemo = true;
    renderPanel();
    fireEvent.click(screen.getByLabelText('Choose a CSV file'));
    return screen.findByRole('dialog', { name: 'Importing is turned off in the demo' });
  });

  it('a failed read of the season’s data is a banner and the preview is not drawn over it', async () => {
    renderPanel({
      context: {
        ...panelContext(db),
        previewError: { message: 'permission denied for table team_coach_assignments' },
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('cannot be shown');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'permission denied for table team_coach_assignments'
    );
    choose('prefs.csv', `${HEADER}\ncasey@example.test,U10 Hawks,prefer,Monday,,,,,\n`);
    await waitFor(() =>
      expect(screen.queryByTestId('preference-import-preview')).not.toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: /^Import / })).not.toBeInTheDocument();
  });

  it.each([
    ['coaches', 'coachesError'],
    ['locations', 'locationsError'],
  ])(
    'a failed read of the %s is a banner and no preview, since every coach or venue would read as unknown',
    async (_name, which) => {
      const failure = { message: `permission denied for table ${_name}` };
      renderPanel({
        context: { ...panelContext(db), error: failure, [which]: failure },
      });
      expect(screen.getByRole('alert')).toHaveTextContent('cannot be shown');
      choose('prefs.csv', `${HEADER}\ncasey@example.test,U10 Hawks,prefer,Monday,,,,,\n`);
      await waitFor(() =>
        expect(screen.queryByTestId('preference-import-preview')).not.toBeInTheDocument()
      );
      expect(screen.queryByRole('button', { name: /^Import / })).not.toBeInTheDocument();
    }
  );

  it('downloads the template', () => {
    URL.createObjectURL = vi.fn(() => 'blob:template');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Download the CSV template' }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});

describe('on the page', () => {
  it('the result of an import stays on screen while the rules are read again, and the pending count follows', async () => {
    vi.mocked(useOrganization).mockReturnValue(
      /** @type {any} */ ({
        currentOrganization: { id: ORG },
        currentSeasonSetting: { id: SEASON, status: 'active' },
        orgMember: { role: 'admin' },
      })
    );
    vi.mocked(useAuth).mockReturnValue(/** @type {any} */ ({ user: { id: ADMIN_USER } }));
    render(
      <MemoryRouter>
        <ToastHost>
          <CoachPreferencesPage />
        </ToastHost>
      </MemoryRouter>
    );
    // No rule exists yet: the page opens on the rules, with the import a tab away.
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('tab', { name: 'Import a file' }));
    choose('prefs.csv', `${HEADER}\ncasey@example.test,U10 Hawks,must,Monday,,,,,\n`);
    await screen.findByTestId('preference-import-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 rule' }));
    await screen.findByTestId('preference-import-summary');
    // The page reads its rules again after the import; the tab's count follows, and the result is
    // still there (a refresh that took the tabs down would have taken the result with them).
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /^Pending musts/ })).toHaveTextContent('1')
    );
    expect(screen.getByTestId('preference-import-summary')).toHaveTextContent('1 rule added');
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 pending must' }));
    expect(await screen.findByRole('heading', { name: 'Pending musts (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Accept all 1 pending must/ })).toBeEnabled();
  });
});
