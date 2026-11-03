/**
 * The read-only Practice daylight page (duration-phase wiring, PR B,
 * `docs/changes/2026-11-02-duration-phases-wiring.md`, task B2): the page, its
 * hook, the model and the component together, over a fake client that serves
 * stored rows.
 *
 * Every expectation about which slots appear, how many and in which state is
 * derived from the INPUT rows (`tests/helpers/practiceDaylightRows.js`), never
 * from what the page drew: the lit slot is found from the venue's flag, the
 * dated range from the slot row. The sentences themselves are pinned in
 * `daylightOutlookText.test.js`; the page's loading, unreadable and no-zone
 * states are pinned in `practiceDaylightOutlookHook.test.jsx` (the same page).
 * Axe is run on this page in Chromium, in both themes, by
 * `tests/e2e/features/practice_daylight_outlook.feature`.
 *
 * Synthetic data only.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  tables: /** @type {Record<string, any[]>} */ ({}),
  fail: /** @type {string|null} */ (null),
  failAs: /** @type {'error'|'throw'} */ ('error'),
  reads: /** @type {Array<{ table: string, columns: string }>} */ ([]),
  writes: /** @type {Array<[string, string]>} */ ([]),
  org: /** @type {any} */ ({}),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { fakeDaylightClient } = await import('./helpers/fakeDaylightClient.js');
  return { supabase: fakeDaylightClient(h) };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => h.org,
}));

import DaylightOutlook from '../frontend/src/components/daylight/DaylightOutlook.jsx';
import PracticeDaylightPage from '../frontend/src/pages/PracticeDaylightPage.jsx';
import { OUTLOOK_BANNER, buildDaylightOutlook } from '../frontend/src/utils/daylightOutlook.js';
import { DEMO_GRID } from '../scripts/build-demo-seed.mjs';
import {
  ID,
  ORG,
  SEASON,
  demoGridRows,
  estateRows,
  estateTables,
} from './helpers/practiceDaylightRows.js';

beforeEach(() => {
  h.tables = estateTables();
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
afterEach(cleanup);

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/schedule/practice-daylight']}>
      <PracticeDaylightPage />
    </MemoryRouter>
  );
const renderOutlook = (rows, season = /** @type {Record<string, any>} */ (SEASON)) =>
  render(
    <MemoryRouter>
      <DaylightOutlook rows={rows} season={season} />
    </MemoryRouter>
  );
/** The table row for a slot, found by its title and ground. */
const rowFor = (title, ground) => {
  const found = screen
    .getAllByTestId('daylight-row')
    .filter(
      (row) =>
        within(row).getByTestId('daylight-slot-title').textContent === title &&
        row.textContent.includes(ground)
    );
  expect(found, `${title} on ${ground}`).toHaveLength(1);
  return found[0];
};

describe('the page over an estate', () => {
  it('says first that nothing is applied, under a page titled Practice daylight', async () => {
    renderPage();
    await screen.findByTestId('daylight-outlook');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Practice daylight' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('daylight-banner')).toHaveTextContent(OUTLOOK_BANNER);
    expect(screen.getByTestId('daylight-banner').textContent).toMatch(/^Proposed, not applied\./);
    // The rules it follows are stated, since no setting changes them.
    expect(screen.getByTestId('daylight-rules')).toHaveTextContent(
      /shortened first, in 10-minute steps to no less than 40 minutes/
    );
  });

  it('only reads: the seven reads are made, and nothing is written or called', async () => {
    renderPage();
    await screen.findByTestId('daylight-outlook');
    expect([...new Set(h.reads.map((r) => r.table))].sort()).toEqual(
      [
        'field_subunits',
        'fields',
        'locations',
        'practice_assignments',
        'practice_lighting_overrides',
        'practice_slots',
        'teams',
      ].sort()
    );
    expect(h.writes).toEqual([]);
    // No control that applies, saves or enacts anything.
    expect(screen.queryByRole('button', { name: /apply|save|enact|retime|accept/i })).toBeNull();
  });

  it('lists every unlit slot of the rows read, worst first, and counts them as a partition', async () => {
    renderPage();
    await screen.findByTestId('daylight-table');
    const rows = estateRows();
    const litFields = new Set(
      rows.fields
        .filter((f) => rows.locations.find((l) => l.id === f.location_id).lighting_available)
        .map((f) => f.id)
    );
    const unlit = rows.practiceSlots.filter((s) => !litFields.has(s.field_id));
    expect(unlit).toHaveLength(8);
    const drawn = screen.getAllByTestId('daylight-row');
    expect(drawn).toHaveLength(unlit.length);
    expect(drawn.map((row) => row.dataset.verdict)).toEqual([
      'flagged',
      'flagged',
      'flagged',
      'unknown',
      'retimed',
      'exempt',
      'ok',
      'no-dates',
    ]);
    // The summary and the counts say the same: six kinds, one slot each but the flagged three.
    expect(screen.getByTestId('daylight-summary')).toHaveTextContent(
      '8 practice slots on unlit ground, 86 practice dates from Tue 1 Sep to Mon 30 Nov (America/New_York). 1 practice slot on lit ground is not judged.'
    );
    const counts = within(screen.getByTestId('daylight-counts'))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(counts).toEqual([
      'Flagged on some dates: 3',
      'Sunset unknown: 1',
      'Need retiming: 1',
      'Under portable lighting: 1',
      'End by sunset as planned: 1',
      'No practice dates: 1',
    ]);
  });

  it('is a semantic table: a caption, column headers with scope, a verdict in words', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: /Practice slots on unlit ground/ });
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((th) => [th.textContent, th.getAttribute('scope')])).toEqual([
      ['Practice', 'col'],
      ['Outlook', 'col'],
      ['Proposed changes', 'col'],
      ['Ways to fix', 'col'],
    ]);
    for (const row of within(table).getAllByTestId('daylight-row')) {
      expect(within(row).getAllByRole('cell')).toHaveLength(4);
      // The outlook is a word as well as a colour.
      expect(within(row).getByTestId('daylight-verdict').textContent.length).toBeGreaterThan(5);
    }
    // Landmarks and headings: one main, h1 then h2s.
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(3);
  });

  it('a slot that survives is said to end by sunset all season, with nothing to change or fix', async () => {
    renderPage();
    await screen.findByTestId('daylight-table');
    const row = rowFor('Monday 15:00 to 16:00', 'Field 1');
    expect(within(row).getByTestId('daylight-verdict')).toHaveTextContent(
      'Ends by sunset all season'
    );
    expect(row).toHaveTextContent('As planned: 15:00 to 16:00 (60 min).');
    expect(row).toHaveTextContent('No change is proposed.');
    expect(row).toHaveTextContent('Nothing to fix.');
    expect(row).toHaveTextContent('Teams: no team assigned');
  });

  it('a slot that goes dark: its phases in words, the teams on it, the one date nothing saves', async () => {
    renderPage();
    await screen.findByTestId('daylight-table');
    const row = rowFor('Tuesday 18:00 to 19:00', 'Field 1');
    expect(row).toHaveTextContent('Teams: Lions, Tigers');
    const phases = within(row)
      .getAllByTestId('daylight-phase')
      .map((li) => li.textContent);
    expect(phases).toHaveLength(8);
    expect(phases[0]).toBe(
      'From Tue 22 Sep: 50 min, 18:00 to 18:50. The latest it may end is 18:56.'
    );
    expect(phases[6]).toMatch(/^From Tue 3 Nov: .*The clocks go back on Sun 1 Nov/);
    const flagged = within(row).getAllByTestId('daylight-flagged-date');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toHaveTextContent(
      /^Tue 24 Nov: it runs 16:00 to 16:40, after the latest it may end \(16:37\)/
    );
    expect(flagged[0]).toHaveTextContent('kept as scheduled and flagged');
    expect(within(row).getByTestId('daylight-verdict')).toHaveTextContent('Flagged on 1 date');
  });

  it('a slot with flagged dates: each kept as scheduled, the first three shown, the rest one disclosure away', async () => {
    renderPage();
    await screen.findByTestId('daylight-table');
    const row = rowFor('Wednesday 17:00 to 18:00', 'Field 1');
    const all = within(row).getAllByTestId('daylight-flagged-date');
    expect(all.map((li) => li.textContent.slice(0, 11))).toEqual([
      'Wed 4 Nov: ',
      'Wed 11 Nov:',
      'Wed 18 Nov:',
      'Wed 25 Nov:',
    ]);
    for (const li of all) expect(li).toHaveTextContent('kept as scheduled and flagged');
    // Three are in the open; the fourth is inside a native disclosure, named by its count.
    const details = within(row).getByText('Show the other 1 flagged date').closest('details');
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(within(details).getAllByTestId('daylight-flagged-date')).toHaveLength(1);
    expect(within(row).getByTestId('daylight-flagged').querySelectorAll('li')).toHaveLength(3);
  });

  it('a slot at a venue with no coordinates says sunset unknown, never fine, and links to the coordinates', async () => {
    renderPage();
    await screen.findByTestId('daylight-table');
    const row = rowFor('Thursday 17:00 to 18:00', 'Field 3');
    expect(within(row).getByTestId('daylight-verdict')).toHaveTextContent('Sunset unknown');
    expect(within(row).getByTestId('daylight-unknown')).toHaveTextContent(
      'Sunset unknown on 13 dates: Far Park has no coordinates.'
    );
    expect(row).not.toHaveTextContent('Ends by sunset');
    const link = within(row).getByRole('link', { name: 'Open Fields & Venues' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/fields');
  });

  it('a slot under an approved lighting window: not judged on those dates, the window named; one on lit ground named as not applied', async () => {
    renderPage();
    await screen.findByTestId('daylight-table');
    const all = rowFor('Tuesday 18:00 to 19:00', 'Field 2 A');
    expect(within(all).getByTestId('daylight-verdict')).toHaveTextContent(
      'Under portable lighting'
    );
    expect(within(all).getByTestId('daylight-exempt')).toHaveTextContent(
      '13 dates are under an approved lighting window and are not judged.'
    );
    const part = rowFor('Wednesday 18:00 to 19:00', 'Field 2 B');
    expect(within(part).getByTestId('daylight-exempt')).toHaveTextContent(
      '2 dates are under an approved lighting window'
    );
    // A window on the lit ground is read and named, so an admin's choice is never silently unread.
    expect(screen.getByTestId('daylight-notes')).toHaveTextContent(
      'An approved lighting window for Friday 18:00 on Field 4 (Bright Park) from Tue 6 Oct to Mon 12 Oct is not applied: it is on lit ground, where nothing is judged.'
    );
  });

  it('the link to Practice lighting is a real link, in every row that offers a lighting window', async () => {
    renderPage();
    await screen.findByTestId('daylight-table');
    const links = screen.getAllByRole('link', { name: 'Open Practice lighting' });
    // The three flagged slots offer a window; no other row does.
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', '/schedule/practice-lighting');
      expect(link.closest('[data-testid="daylight-row"]')).toHaveAttribute(
        'data-verdict',
        'flagged'
      );
    }
  });

  it('says what a candidate fix does not check, once per row that lists fixes', async () => {
    renderPage();
    await screen.findByTestId('daylight-table');
    const notices = screen.getAllByText(/candidates only: permits, field size/i);
    expect(notices).toHaveLength(3);
  });
});

describe('the empty and unusual estates', () => {
  it('a league with no practice slots is told so, with no table', () => {
    renderOutlook({
      ...estateRows(),
      practiceSlots: [],
      practiceAssignments: [],
      lightingOverrides: [],
    });
    expect(screen.getByTestId('daylight-empty')).toHaveTextContent(
      'There are no practice slots yet'
    );
    expect(screen.queryByTestId('daylight-table')).toBeNull();
  });

  it('a league with every slot on lit ground is told so', () => {
    const rows = estateRows();
    renderOutlook({
      ...rows,
      practiceSlots: rows.practiceSlots.filter((s) => s.id === ID.lit),
      practiceAssignments: [],
      lightingOverrides: [],
    });
    expect(screen.getByTestId('daylight-empty')).toHaveTextContent(
      'Every practice slot is on lit ground'
    );
    expect(screen.queryByTestId('daylight-table')).toBeNull();
  });

  it('no venue with coordinates: one message that points at the coordinates form, no list of unknowns', () => {
    const rows = estateRows();
    renderOutlook({
      ...rows,
      locations: rows.locations.map((l) => ({ ...l, latitude: null, longitude: null })),
    });
    const message = screen.getByTestId('daylight-no-coordinates');
    expect(message).toHaveTextContent('Sunset unknown.');
    expect(message).toHaveTextContent('No venue with unlit practices has coordinates');
    expect(within(message).getByRole('link', { name: 'Fields & Venues' })).toHaveAttribute(
      'href',
      '/fields'
    );
    expect(screen.queryByTestId('daylight-table')).toBeNull();
    expect(screen.queryAllByTestId('daylight-row')).toHaveLength(0);
  });

  it('some venues without coordinates: the others are judged, and the unknown ones are rows, not hidden', () => {
    renderOutlook(estateRows());
    expect(screen.queryByTestId('daylight-no-coordinates')).toBeNull();
    expect(screen.getAllByTestId('daylight-row').some((r) => r.dataset.verdict === 'unknown')).toBe(
      true
    );
  });

  it('slots whose dates never meet the season: nothing judged, and it says so', () => {
    const rows = estateRows();
    renderOutlook({
      ...rows,
      practiceSlots: rows.practiceSlots.filter((s) => s.id === ID.noDates),
      practiceAssignments: [],
      lightingOverrides: [],
    });
    expect(screen.getByTestId('daylight-nothing-judged')).toHaveTextContent('nothing was judged');
    expect(screen.getByTestId('daylight-verdict')).toHaveTextContent('No practice dates');
  });

  it('an input the adapter refuses is a message and no row', () => {
    const rows = estateRows();
    renderOutlook({
      ...rows,
      locations: rows.locations.map((l, i) => (i === 0 ? { ...l, id: 'not-a-uuid' } : l)),
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('could not be worked out');
    expect(alert).toHaveTextContent('not a uuid');
    expect(screen.queryAllByTestId('daylight-row')).toHaveLength(0);
  });

  it('a season with no dates is a message and no row', () => {
    renderOutlook(estateRows(), { ...SEASON, season_start: null });
    expect(screen.getByRole('alert')).toHaveTextContent('no start and end date');
    expect(screen.queryAllByTestId('daylight-row')).toHaveLength(0);
  });

  it('no school-day end: a shift is said to be unproposed, and a flagged date says why', () => {
    renderOutlook(estateRows(), { ...SEASON, school_day_end: null });
    expect(screen.getByTestId('daylight-rules')).toHaveTextContent(
      'The season has no school-day end set, so starting earlier is not proposed.'
    );
    expect(screen.getByTestId('daylight-notes')).toHaveTextContent(
      'Starting a practice earlier is not proposed'
    );
    expect(
      screen.getAllByText(/an earlier start is not proposed\. It is kept as scheduled and flagged/)
        .length
    ).toBeGreaterThan(0);
  });

  it('a slot dated by the season is said so', () => {
    const rows = estateRows();
    renderOutlook({
      ...rows,
      practiceSlots: rows.practiceSlots.map((s) =>
        s.id === ID.ok ? { ...s, valid_from: null, valid_until: null } : s
      ),
    });
    expect(screen.getByTestId('daylight-notes')).toHaveTextContent(
      '1 practice slot has no start or end date of its own, so the season’s dates are used for it.'.replace(
        '’',
        "'"
      )
    );
  });
});

describe('the largest real grid, on the main thread', () => {
  it('works out the demo league (304 slots, 128 teams) well inside the default timeout', () => {
    const { rows, season } = demoGridRows(DEMO_GRID);
    expect(rows.practiceSlots).toHaveLength(304);
    expect(rows.teams).toHaveLength(128);
    const started = performance.now();
    const outlook = buildDaylightOutlook({ rows, season });
    const elapsed = performance.now() - started;
    // Subject set from the rows: the slots on a lit field are found from the venue's flag.
    const litVenues = new Set(rows.locations.filter((l) => l.lighting_available).map((l) => l.id));
    const litFields = new Set(
      rows.fields.filter((f) => litVenues.has(f.location_id)).map((f) => f.id)
    );
    const litSubunits = new Set(
      rows.fieldSubunits.filter((s) => litFields.has(s.field_id)).map((s) => s.id)
    );
    const unlit = rows.practiceSlots.filter((s) => !litSubunits.has(s.field_subunit_id));
    expect(outlook.rows).toHaveLength(unlit.length);
    expect(outlook.counts.litSlots).toBe(rows.practiceSlots.length - unlit.length);
    // Every team assigned to an unlit slot is named on its row.
    const unlitIds = new Set(unlit.map((s) => s.id));
    const assigned = rows.practiceAssignments.filter((a) => unlitIds.has(a.practice_slot_id));
    expect(outlook.rows.filter((r) => r.teams !== 'no team assigned')).toHaveLength(
      assigned.length
    );
    // The plan's risk note: it runs on the main thread unless it ever does not fit the default 5 s
    // timeout; it took about 130 ms the first time here (executed, not copied), so no worker.
    expect(
      elapsed,
      'the outlook over the demo league took too long for the main thread'
    ).toBeLessThan(4500);
  });

  it('renders the demo league’s table without stalling', async () => {
    const { rows, season } = demoGridRows(DEMO_GRID);
    renderOutlook(rows, season);
    expect(screen.getAllByTestId('daylight-row')).toHaveLength(274);
    await waitFor(() => expect(screen.getByTestId('daylight-table')).toBeInTheDocument());
  });
});
