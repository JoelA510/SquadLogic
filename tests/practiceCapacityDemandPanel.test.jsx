/**
 * The "Before you run: slots against what each division needs" panel (schedule expansion, PR 13,
 * task N1; `docs/changes/2026-11-03-schedule-expansion.md`, 5.9 and decisions 28 and 29):
 * `frontend/src/hooks/usePracticeCapacityDemand.js` and
 * `frontend/src/components/scheduling/PracticeCapacityDemandPanel.jsx`.
 *
 * Read-only: the panel selects four tables as the signed-in user and writes nothing.
 *
 * - **All or nothing** (lessons 90 and 93). Each of the four reads is made to fail in turn, as an
 *   error answer and as a rejected request, and the panel must draw an alert naming the table and
 *   no row, no table and no verdict. Before its inputs arrive (and again while it reads after the
 *   page saved something) it says "not checked yet" and shows no figure.
 * - **The three sentences are on its face** (decisions 28 and 29): what the numbers are based on,
 *   that times held outside the app are unknown to it, and that the verdict is an upper bound.
 *   They are written out below, not read back from the component, so a changed wording is a red
 *   test here and a conscious edit.
 * - **A 0-a-week division is "None wanted"**, never short.
 * - Every expectation is worked out from `tests/helpers/practiceCapacityRows.js`'s league (its
 *   header lists the arithmetic), not from what the panel printed.
 *
 * Axe is not run here: this repository has no axe in jsdom (lesson 97, point 4). The panel is
 * scanned in both themes by `tests/e2e/features/practices_per_division.feature`; what jsdom can hold
 * is held here: a captioned table with column and row headers, a focusable labelled scroll region,
 * the verdict in words (never colour alone), and no hard-coded colour.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const h = vi.hoisted(() => ({
  /** @type {Record<string, any[]>} */
  tables: {},
  /** @type {string|null} the table whose read fails */
  fail: null,
  /** @type {'error'|'throw'} how it fails */
  failAs: 'error',
  /** @type {Array<{ table: string, columns: string }>} */
  reads: [],
  /** @type {Array<[string, string]>} */
  writes: [],
  org: /** @type {any} */ ({}),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { fakeDaylightClient } = await import('./helpers/fakeDaylightClient.js');
  return { supabase: fakeDaylightClient(h) };
});

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => h.org,
}));

import { supabase } from '../frontend/src/lib/supabaseClient.js';
import PracticeCapacityDemandPanel from '../frontend/src/components/scheduling/PracticeCapacityDemandPanel.jsx';
import {
  NO_SEASON_MESSAGE,
  NO_ZONE_MESSAGE,
  loadPracticeCapacityRows,
  usePracticeCapacityDemand,
} from '../frontend/src/hooks/usePracticeCapacityDemand.js';
import {
  buildCapacityDemand,
  capacityDemandInputFromRows,
} from '@squadlogic/core/practice/index.js';
import {
  ID,
  ORG,
  OTHER_SEASON_ID,
  SEASON,
  SEASON_ID,
  TODAY,
  TODAY_INSTANT,
  capacityTables,
} from './helpers/practiceCapacityRows.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The four tables, as the panel reads them. */
const EVERY_TABLE = ['divisions', 'teams', 'practice_slots', 'practice_assignments'];

/** The sentences on the panel's face (decisions 28 and 29), written out in full. */
const BASIS =
  'These figures are based on every open practice slot a division may use, live from today ' +
  '(2026-10-05) on and as long as the division’s practice. A saved practice uses its place in ' +
  'its slot from today on.';
const HELD_OUTSIDE = 'Times held outside the app are unknown to this panel.';
const UPPER_BOUND =
  'Each verdict is an upper bound: the room it counts can only be too high, so “to spare” can ' +
  'be too high and “short by” can understate a shortage.';
const DECLARED =
  'Not checked here: coach overlap, coach must-keep rules, daylight, closures, permits, travel, ' +
  'saved exceptions and teams whose practice time is TBD. A run applies them, so it can place ' +
  'fewer practices than the room shown.';
const TOTAL_NOTE =
  'Whole season: a slot open to several divisions counts in each of their rows but once here, ' +
  'so the rows can add up to more than this line.';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TODAY_INSTANT));
  h.tables = capacityTables();
  h.fail = null;
  h.failAs = 'error';
  h.reads = [];
  h.writes = [];
  h.org = {
    currentOrganization: { id: ORG },
    currentSeasonSetting: SEASON,
    seasonSettingsLoading: false,
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The loader over the fake client; `any` so a test can look at either branch of the result. */
const load = async (ids = { organizationId: ORG, seasonSettingsId: SEASON_ID }) =>
  /** @type {any} */ (await loadPracticeCapacityRows(supabase, ids));

/** The panel's rows, by division name, as `{ column header: cell text }`. */
function figures() {
  const headers = screen.getAllByRole('columnheader').map((th) => th.textContent.trim());
  const out = {};
  for (const tr of screen.getAllByTestId('capacity-row')) {
    const cells = [...tr.children].map((cell) => cell.textContent.replace(/\s+/g, ' ').trim());
    out[cells[0]] = Object.fromEntries(headers.map((name, i) => [name, cells[i]]));
  }
  return out;
}
const totalRow = () => {
  const headers = screen.getAllByRole('columnheader').map((th) => th.textContent.trim());
  const cells = [...screen.getByTestId('capacity-total').children].map((cell) =>
    cell.textContent.replace(/\s+/g, ' ').trim()
  );
  return Object.fromEntries(headers.map((name, i) => [name, cells[i]]));
};

const renderReady = async (props = {}) => {
  render(<PracticeCapacityDemandPanel {...props} />);
  await screen.findByTestId('capacity-table');
};

describe('the loader reads four tables, and only reads', () => {
  it('returns the rows of the organization and season, from the tables’ own columns', async () => {
    const read = await load();
    expect(read.ok).toBe(true);
    expect([...new Set(h.reads.map((r) => r.table))].sort()).toEqual([...EVERY_TABLE].sort());
    expect(h.writes).toEqual([]);
    // The season is the division's: a division of another season is not read, and neither is its
    // team counted (the join is the model's).
    expect(read.rows.divisions.map((d) => d.name).sort()).toEqual(['U10', 'U12', 'U14', 'U8']);
    expect(read.rows.divisions.some((d) => d.season_settings_id === OTHER_SEASON_ID)).toBe(false);
    expect(read.rows.practiceSlots).toHaveLength(4);
    expect(read.rows.practiceAssignments).toHaveLength(1);
  });

  it('asks for every column the model reads: the report over what it read equals the report over the full rows', async () => {
    const read = await load();
    expect(read.ok).toBe(true);
    const full = capacityTables();
    const over = (divisions, teams, practiceSlots, practiceAssignments) =>
      buildCapacityDemand(
        capacityDemandInputFromRows({
          liveFrom: TODAY,
          season: SEASON,
          divisions,
          teams,
          practiceSlots,
          practiceAssignments,
        })
      );
    const fromFull = over(
      full.divisions.filter((d) => d.season_settings_id === SEASON_ID),
      full.teams,
      full.practice_slots,
      full.practice_assignments.map((r) => ({
        id: r.id,
        teamId: r.team_id,
        slotId: r.practice_slot_id,
        effectiveDateRange: r.effective_date_range,
      }))
    );
    // A column the select forgot would change a figure: a slot undated, a reservation lost, a
    // length unread.
    expect(
      over(
        read.rows.divisions,
        read.rows.teams,
        read.rows.practiceSlots,
        read.rows.practiceAssignments
      )
    ).toEqual(fromFull);
    expect(fromFull.divisions).toHaveLength(4);
    expect(fromFull.total.stillNeeded).toBe(4);
  });

  it.each(EVERY_TABLE)('%s failing gives { ok: false } naming it, and no rows', async (table) => {
    h.fail = table;
    const read = await load();
    expect(read.ok).toBe(false);
    expect(read.table).toBe(table);
    expect(read.message).toContain(table);
    expect(read).not.toHaveProperty('rows');
  });

  it.each(EVERY_TABLE)('%s rejecting is a failed read too, naming it', async (table) => {
    h.fail = table;
    h.failAs = 'throw';
    const read = await load();
    expect(read.ok).toBe(false);
    expect(read.table).toBe(table);
    expect(read.message).toContain(table);
  });

  it('refuses without an organization or a season, reading nothing', async () => {
    expect((await load({ organizationId: '', seasonSettingsId: SEASON_ID })).ok).toBe(false);
    expect((await load({ organizationId: ORG, seasonSettingsId: '' })).ok).toBe(false);
    expect(h.reads).toEqual([]);
  });
});

describe('the hook', () => {
  const mount = (props) => renderHook((p) => usePracticeCapacityDemand(p), { initialProps: props });
  const base = () => ({ organizationId: ORG, season: SEASON });

  it('is loading, then ready with the rows and today on the season’s clock', async () => {
    const { result } = mount(base());
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rows.practiceSlots).toHaveLength(4);
    // Noon in Chicago on the 5th; at 03:00 UTC on the 6th it would still be the 5th there.
    expect(result.current.liveFrom).toBe('2026-10-05');
  });

  it('reads today on the season’s clock, not the host’s', async () => {
    vi.setSystemTime(new Date('2026-10-06T03:30:00Z')); // 22:30 on the 5th in Chicago
    const { result } = mount(base());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.liveFrom).toBe('2026-10-05');
  });

  it('is unreadable with the table named, and has no rows, when any read fails', async () => {
    h.fail = 'practice_slots';
    const { result } = mount(base());
    await waitFor(() => expect(result.current.status).toBe('unreadable'));
    expect(result.current.rows).toBeNull();
    expect(result.current.message).toContain('practice_slots');
  });

  it('a season with no time zone is a message, and nothing is read', async () => {
    const { result } = mount({ ...base(), season: { ...SEASON, timezone: '  ' } });
    expect(result.current).toMatchObject({
      status: 'no-zone',
      message: NO_ZONE_MESSAGE,
      rows: null,
    });
    await settle();
    expect(h.reads).toEqual([]);
  });

  it('no season, or no organization, is a message, and nothing is read', async () => {
    expect(mount({ organizationId: ORG, season: null }).result.current).toMatchObject({
      status: 'no-season',
      message: NO_SEASON_MESSAGE,
    });
    expect(mount({ organizationId: null, season: SEASON }).result.current.status).toBe('no-season');
    await settle();
    expect(h.reads).toEqual([]);
  });

  it('while the season is still being read, nothing is read from the one held', async () => {
    const { result } = mount({ ...base(), seasonLoading: true });
    expect(result.current.status).toBe('loading');
    await settle();
    expect(h.reads).toEqual([]);
  });

  it('never serves the rows of a previous season: another season reads again', async () => {
    const { result, rerender } = mount(base());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ organizationId: ORG, season: { ...SEASON, id: OTHER_SEASON_ID } });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('never serves rows read before the page saved something: a new refresh key reads again', async () => {
    const { result, rerender } = mount({ ...base(), refreshKey: 0 });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const before = h.reads.length;
    rerender({ ...base(), refreshKey: 1 });
    expect(result.current.status).toBe('loading');
    expect(result.current.rows).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(h.reads.length).toBeGreaterThan(before);
  });
});

describe('before its inputs arrive, the panel says "not checked yet"', () => {
  const VERDICT_WORDS = /to spare|short by|none wanted|no teams|no slot open|fewer weekdays/i;

  it('on the first render, before the reads come back, with no figure and no verdict', () => {
    render(<PracticeCapacityDemandPanel />);
    const note = screen.getByTestId('capacity-unchecked');
    expect(note).toHaveTextContent(/not checked yet/i);
    expect(screen.queryByTestId('capacity-table')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('capacity-row')).toHaveLength(0);
    expect(
      screen.getByRole('heading', {
        name: 'Before you run: slots against what each division needs',
      })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(VERDICT_WORDS);
  });

  it('while the season is being read', () => {
    h.org = { ...h.org, seasonSettingsLoading: true };
    render(<PracticeCapacityDemandPanel />);
    expect(screen.getByTestId('capacity-unchecked')).toHaveTextContent(/not checked yet/i);
    expect(h.reads).toEqual([]);
  });

  it('again, with the old rows gone, while it reads after the page saved something', async () => {
    const view = render(<PracticeCapacityDemandPanel refreshKey={0} />);
    await screen.findByTestId('capacity-table');
    view.rerender(<PracticeCapacityDemandPanel refreshKey={1} />);
    expect(screen.getByTestId('capacity-unchecked')).toHaveTextContent(/not checked yet/i);
    expect(screen.queryByTestId('capacity-table')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(VERDICT_WORDS);
    await screen.findByTestId('capacity-table');
  });

  it('no organization, no season and no time zone are said in words, with no figure', async () => {
    h.org = { currentOrganization: null, currentSeasonSetting: null, seasonSettingsLoading: false };
    const view = render(<PracticeCapacityDemandPanel />);
    expect(screen.getByTestId('capacity-blocked')).toHaveTextContent(NO_SEASON_MESSAGE);
    view.unmount();
    h.org = {
      currentOrganization: { id: ORG },
      currentSeasonSetting: { ...SEASON, timezone: null },
      seasonSettingsLoading: false,
    };
    render(<PracticeCapacityDemandPanel />);
    expect(screen.getByTestId('capacity-blocked')).toHaveTextContent(NO_ZONE_MESSAGE);
    expect(screen.queryByTestId('capacity-table')).not.toBeInTheDocument();
    await settle();
    expect(h.reads).toEqual([]);
  });
});

describe('a failed read draws no row, ever', () => {
  it('the control: nothing failing draws every division', async () => {
    await renderReady();
    expect(screen.getAllByTestId('capacity-row')).toHaveLength(4);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  const cases = EVERY_TABLE.flatMap((table) => [
    [table, 'error'],
    [table, 'throw'],
  ]);
  it.each(cases)(
    '%s failing as an %s: an alert naming it, and no row, no table, no verdict',
    async (table, how) => {
      h.fail = table;
      h.failAs = how;
      render(<PracticeCapacityDemandPanel />);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(table);
      expect(alert).toHaveTextContent('no capacity figures are shown');
      expect(screen.queryAllByTestId('capacity-row')).toHaveLength(0);
      expect(screen.queryByTestId('capacity-table')).not.toBeInTheDocument();
      expect(screen.queryByTestId('capacity-total')).not.toBeInTheDocument();
      expect(screen.queryByTestId('capacity-unchecked')).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(
        /to spare|short by|none wanted|no teams|nothing to compare/i
      );
    }
  );
});

describe('the figures, worked out from the league', () => {
  it('one row per division of the season, in name order, and none for another season’s', async () => {
    await renderReady();
    const rows = screen.getAllByTestId('capacity-row');
    expect(rows.map((r) => r.getAttribute('data-division-id'))).toEqual([
      ID.u8,
      ID.u10,
      ID.u12,
      ID.u14,
    ]);
    expect(screen.queryByText('U6')).not.toBeInTheDocument();
    expect(screen.queryByText('Minnows')).not.toBeInTheDocument();
  });

  it('U8: one still needed, three slots, four places free of five', async () => {
    await renderReady();
    expect(figures().U8).toMatchObject({
      Teams: '2',
      'Wanted a week': '2',
      Held: '1',
      'Still needed': '1',
      Length: 'Any length',
      'Slots it may use': '3 slots: Tue, Wed, Thu',
      'Room left': '4 of 5',
      'Verdict (upper bound)': '3 to spare',
    });
  });

  it('U10 wants two a week at 60 minutes: the 45-minute slot is not open to it', async () => {
    await renderReady();
    expect(figures().U10).toMatchObject({
      Teams: '1',
      'Wanted a week': '2',
      Held: '0',
      'Still needed': '2',
      Length: '60 min',
      'Slots it may use': '2 slots: Tue, Thu',
      'Room left': '2 of 3',
      'Verdict (upper bound)': '0 to spare',
    });
  });

  it('U14 wants 90 minutes and no slot is that long: no slot open, with the reason in words', async () => {
    await renderReady();
    expect(figures().U14).toMatchObject({
      'Still needed': '1',
      Length: '90 min',
      'Slots it may use': '0 slots',
      'Room left': '0 of 0',
    });
    expect(figures().U14['Verdict (upper bound)']).toBe(
      'No slot open: no practice slot is exactly as long as the division’s practice. Short by 1.'
    );
  });

  it('a 0-a-week division is "None wanted", and nothing in its row says short', async () => {
    await renderReady();
    const row = screen
      .getAllByTestId('capacity-row')
      .find((r) => r.getAttribute('data-division-id') === ID.u12);
    expect(figures().U12).toMatchObject({
      Teams: '3',
      'Wanted a week': '0',
      'Still needed': '0',
      'Slots it may use': '—',
      'Room left': '—',
      'Verdict (upper bound)': 'None wanted',
    });
    expect(within(row).queryByText(/short/i)).not.toBeInTheDocument();
    expect(row.textContent).not.toMatch(/short|spare/i);
  });

  it('the whole-season row counts each slot once and says the rows add up to more', async () => {
    await renderReady();
    expect(totalRow()).toMatchObject({
      Teams: '7',
      'Wanted a week': '5',
      Held: '1',
      'Still needed': '4',
      'Slots it may use': '3 slots (the rows add up to 5)',
      Length: '—',
      'Room left': '4 of 5',
      'Verdict (upper bound)': '0 to spare',
    });
    expect(screen.getByTestId('capacity-total-note')).toHaveTextContent(TOTAL_NOTE);
  });

  it('a division with teams all holding what they need reads "to spare", not "none"', async () => {
    h.tables.practice_assignments.push({
      ...h.tables.practice_assignments[0],
      id: 'r2',
      team_id: ID.bears,
      practice_slot_id: ID.thu17,
    });
    await renderReady();
    expect(figures().U8).toMatchObject({
      Held: '2',
      'Still needed': '0',
      'Room left': '3 of 5',
      'Verdict (upper bound)': '3 to spare',
    });
  });

  it('a team holding more rows than its division wants is named in the Held cell', async () => {
    h.tables.practice_assignments.push({
      ...h.tables.practice_assignments[0],
      id: 'r2',
      practice_slot_id: ID.wed45,
    });
    await renderReady();
    expect(figures().U8.Held).toBe('2 (1 team over its count)');
  });

  it('says so when the season has no division', async () => {
    h.tables.divisions = [];
    render(<PracticeCapacityDemandPanel />);
    expect(await screen.findByTestId('capacity-no-divisions')).toHaveTextContent(
      'This season has no divisions yet, so there is nothing to compare.'
    );
    expect(screen.queryByTestId('capacity-table')).not.toBeInTheDocument();
  });

  it('counts a slot that cannot be read in the basis line and in no row', async () => {
    h.tables.practice_slots.push({
      ...h.tables.practice_slots[0],
      id: 'broken',
      start_time: 'later',
    });
    await renderReady();
    expect(screen.getByTestId('capacity-slot-counts')).toHaveTextContent(
      '5 slots were read; 3 are live from today; 3 are open to at least one division. 1 could not be read and is not counted.'
    );
    expect(figures().U8['Slots it may use']).toBe('3 slots: Tue, Wed, Thu');
  });

  it('shows no figure when the data cannot be worked out, and says so', async () => {
    h.tables.divisions[0].practices_per_week = 9; // the table would not hold this
    render(<PracticeCapacityDemandPanel />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('could not be worked out');
    expect(alert).toHaveTextContent('nothing is shown');
    expect(screen.queryAllByTestId('capacity-row')).toHaveLength(0);
    expect(screen.queryByTestId('capacity-table')).not.toBeInTheDocument();
  });
});

describe('the sentences on the panel’s face (decisions 28 and 29)', () => {
  it('says what the numbers are based on', async () => {
    await renderReady();
    expect(screen.getByTestId('capacity-basis')).toHaveTextContent(BASIS);
    expect(screen.getByTestId('capacity-slot-counts')).toHaveTextContent(
      '4 slots were read; 3 are live from today; 3 are open to at least one division.'
    );
  });

  it('says that times held outside the app are unknown to it', async () => {
    await renderReady();
    expect(screen.getByTestId('capacity-held-outside')).toHaveTextContent(HELD_OUTSIDE);
  });

  it('labels its verdict an upper bound, in the sentence and in the column heading', async () => {
    await renderReady();
    expect(screen.getByTestId('capacity-upper-bound')).toHaveTextContent(UPPER_BOUND);
    expect(screen.getByRole('columnheader', { name: 'Verdict (upper bound)' })).toBeInTheDocument();
  });

  it('declares what it does not check', async () => {
    await renderReady();
    expect(screen.getByTestId('capacity-declared')).toHaveTextContent(DECLARED);
  });

  it('promises nothing about leaving held times out of the room it counts', async () => {
    await renderReady();
    const face = screen.getByTestId('capacity-panel').textContent;
    expect(face).not.toMatch(
      /left out|excluded|leaves? (them|held)|held times are (not|excluded)/i
    );
    // It counts every open slot, and says so rather than promising otherwise.
    expect(face).toContain('every open practice slot');
  });

  it('is not drawn on the face of a panel that has read nothing', () => {
    render(<PracticeCapacityDemandPanel />);
    for (const id of ['capacity-basis', 'capacity-held-outside', 'capacity-upper-bound']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
  });
});

describe('the table is a table', () => {
  it('has a caption, column headers, a row header per row, and a focusable labelled scroll region', async () => {
    await renderReady();
    const table = screen.getByTestId('capacity-table');
    expect(table.tagName).toBe('TABLE');
    expect(table.querySelector('caption')).toHaveTextContent(/still needed/i);
    const columns = within(table).getAllByRole('columnheader');
    expect(columns.length).toBe(9);
    for (const th of columns) expect(th).toHaveAttribute('scope', 'col');
    for (const tr of [
      ...screen.getAllByTestId('capacity-row'),
      screen.getByTestId('capacity-total'),
    ]) {
      expect(tr.firstElementChild.tagName).toBe('TH');
      expect(tr.firstElementChild).toHaveAttribute('scope', 'row');
    }
    const region = screen.getByRole('region', { name: /capacity against demand, by division/i });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(table);
  });

  it('puts the verdict in words in every row, so colour is never the only signal', async () => {
    await renderReady();
    for (const tr of screen.getAllByTestId('capacity-row')) {
      const cell = tr.lastElementChild;
      expect(cell.textContent.trim().length).toBeGreaterThan(5);
      expect(cell.textContent).toMatch(
        /to spare|short by|none wanted|no teams|no slot open|fewer weekdays/i
      );
    }
  });

  it('uses the theme’s tokens and no hard-coded colour', () => {
    for (const file of [
      'frontend/src/components/scheduling/PracticeCapacityDemandPanel.jsx',
      'frontend/src/hooks/usePracticeCapacityDemand.js',
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, file).not.toMatch(/\brgba?\(|\bhsla?\(/);
      expect(source, file).not.toMatch(/style=\{\{/);
    }
  });
});

describe('what the panel reads is the season’s, in the user’s name', () => {
  it('selects only, once per table, and filters the divisions to the season', async () => {
    await renderReady();
    expect(h.writes).toEqual([]);
    const tables = h.reads.map((r) => r.table);
    for (const table of EVERY_TABLE) expect(tables).toContain(table);
    // The fake serves only what the season’s filter lets through: no division of the other season.
    expect(screen.queryByText('U6')).not.toBeInTheDocument();
  });
});
