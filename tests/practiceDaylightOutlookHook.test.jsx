/**
 * The Practice daylight outlook's read (duration-phase wiring, PR B,
 * `docs/changes/2026-11-02-duration-phases-wiring.md`, task B1):
 * `frontend/src/hooks/usePracticeDaylightOutlook.js`.
 *
 * **All or nothing.** The reports need every table, and a report over a partial
 * read says a slot survives because the row that shows it does not was never
 * read. So each of the seven reads is made to fail in turn, and both the loader
 * (`{ ok: false }` naming the table) and the page (an alert, and no row, no
 * table and no "nothing to look at") are held to it.
 *
 * Every row is served by a fake client that returns only the columns the select
 * asked for (lesson 60: a double that returns whole rows hides a column the
 * query forgot). Synthetic data only: `tests/helpers/practiceDaylightRows.js`.
 *
 * Plant P4 (shown red, then reverted): a failed read turned into an empty one in
 * `loadPracticeDaylightRows`, so the page renders over what it did read.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const WRITES = ['insert', 'update', 'upsert', 'delete'];
  const from = (table) => {
    let rows = h.tables[table] ?? [];
    let columns = '*';
    const q = {
      select: (cols) => {
        columns = cols;
        return q;
      },
      eq: (col, val) => {
        // An embedded filter (`teams.divisions.season_settings_id`) is the server's.
        if (!col.includes('.')) rows = rows.filter((r) => String(r[col]) === String(val));
        return q;
      },
      order: () => q,
      range: (lo, hi) => {
        h.reads.push({ table, columns });
        if (h.fail === table) {
          return h.failAs === 'throw'
            ? Promise.reject(new Error(`${table}: connection reset`))
            : Promise.resolve({ data: null, error: { message: `${table}: permission denied` } });
        }
        // Only the columns asked for; an embed (`teams!inner(...)`) is not a column of the row.
        const asked = columns.split(',').map((c) => c.trim());
        const names = asked.filter((c) => !c.includes('!') && !c.includes('('));
        const projected = rows
          .slice(lo, hi + 1)
          .map((row) => Object.fromEntries(names.map((name) => [name, row[name]])));
        return Promise.resolve({ data: projected, error: null });
      },
    };
    for (const method of WRITES) {
      q[method] = () => {
        h.writes.push([table, method]);
        return q;
      };
    }
    return q;
  };
  return {
    supabase: {
      from,
      rpc: (name) => {
        h.writes.push(['rpc', name]);
        return Promise.resolve({ data: null, error: null });
      },
    },
  };
});

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => h.org,
}));

import { supabase } from '../frontend/src/lib/supabaseClient.js';
import PracticeDaylightPage from '../frontend/src/pages/PracticeDaylightPage.jsx';
import {
  NO_SEASON_MESSAGE,
  NO_ZONE_MESSAGE,
  loadPracticeDaylightRows,
  usePracticeDaylightOutlook,
} from '../frontend/src/hooks/usePracticeDaylightOutlook.js';
import { buildDaylightOutlook } from '../frontend/src/utils/daylightOutlook.js';
import {
  ORG,
  SEASON,
  SEASON_ID,
  estateRows,
  estateTables,
} from './helpers/practiceDaylightRows.js';

/** The loader over the fake client; `any` so a test can look at either branch of the result. */
const load = async (ids = { organizationId: ORG, seasonSettingsId: SEASON_ID }) =>
  /** @type {any} */ (await loadPracticeDaylightRows(supabase, ids));

/** Let any read an effect started reach the fake client. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const EVERY_TABLE = [
  'locations',
  'fields',
  'field_subunits',
  'practice_slots',
  'practice_lighting_overrides',
  'teams',
  'practice_assignments',
];

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

describe('the loader reads every table, and only reads', () => {
  it('returns every table under the adapter’s names, read from the organization and season', async () => {
    const read = await load();
    expect(read.ok).toBe(true);
    const expected = estateRows();
    expect(Object.keys(read.rows).sort()).toEqual(
      [
        'fieldSubunits',
        'fields',
        'lightingOverrides',
        'locations',
        'practiceAssignments',
        'practiceSlots',
        'teams',
      ].sort()
    );
    for (const key of Object.keys(expected)) {
      expect(read.rows[key], key).toHaveLength(expected[key].length);
    }
    // Each of the seven reads was made, and nothing was written.
    expect([...new Set(h.reads.map((r) => r.table))].sort()).toEqual([...EVERY_TABLE].sort());
    expect(h.writes).toEqual([]);
  });

  it('asks for every column the model reads: the outlook over what it read equals the outlook over the full rows', async () => {
    const read = await load();
    expect(read.ok).toBe(true);
    // The fake serves only the columns asked for; a column the select forgot would change the
    // outlook (a slot undated, a venue without coordinates, a window unread) and this would differ.
    expect(buildDaylightOutlook({ rows: read.rows, season: SEASON })).toEqual(
      buildDaylightOutlook({ rows: estateRows(), season: SEASON })
    );
    expect(buildDaylightOutlook({ rows: read.rows, season: SEASON }).rows.length).toBe(8);
  });

  it.each(EVERY_TABLE)('%s failing gives { ok: false } naming it, and no rows', async (table) => {
    h.fail = table;
    const read = await load();
    expect(read.ok).toBe(false);
    expect(read.table).toBe(table);
    expect(read.message).toContain(`${table}: permission denied`);
    expect(read).not.toHaveProperty('rows');
  });

  it.each(EVERY_TABLE)('%s rejecting is a failed read too, naming it', async (table) => {
    h.fail = table;
    h.failAs = 'throw';
    const read = await load();
    expect(read.ok).toBe(false);
    expect(read.message).toContain(table);
  });

  it('refuses without an organization or a season, reading nothing', async () => {
    expect((await load({ organizationId: '', seasonSettingsId: SEASON_ID })).ok).toBe(false);
    expect((await load({ organizationId: ORG, seasonSettingsId: '' })).ok).toBe(false);
    expect(h.reads).toEqual([]);
  });
});

describe('the hook', () => {
  const mountHook = (props) => renderHook(() => usePracticeDaylightOutlook(props));

  it('is loading, then ready with the rows', async () => {
    const { result } = mountHook({ organizationId: ORG, season: SEASON });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rows.practiceSlots).toHaveLength(9);
    expect(result.current.message).toBeNull();
  });

  it('is unreadable with the table named, and has no rows, when any read fails', async () => {
    h.fail = 'practice_slots';
    const { result } = mountHook({ organizationId: ORG, season: SEASON });
    await waitFor(() => expect(result.current.status).toBe('unreadable'));
    expect(result.current.rows).toBeNull();
    expect(result.current.message).toContain('practice_slots');
  });

  it('a season with no time zone is a message, and nothing is read', async () => {
    const { result } = mountHook({ organizationId: ORG, season: { ...SEASON, timezone: null } });
    expect(result.current).toEqual({ status: 'no-zone', message: NO_ZONE_MESSAGE, rows: null });
    expect(NO_ZONE_MESSAGE).toMatch(/no time zone/);
    // A blank zone is no zone.
    const blank = mountHook({ organizationId: ORG, season: { ...SEASON, timezone: '   ' } });
    expect(blank.result.current.status).toBe('no-zone');
    await settle();
    expect(h.reads).toEqual([]);
  });

  it('no season, or no organization, is a message, and nothing is read', async () => {
    expect(mountHook({ organizationId: ORG, season: null }).result.current).toEqual({
      status: 'no-season',
      message: NO_SEASON_MESSAGE,
      rows: null,
    });
    expect(mountHook({ organizationId: null, season: SEASON }).result.current.status).toBe(
      'no-season'
    );
    await settle();
    expect(h.reads).toEqual([]);
  });

  it('while the season is still being read, nothing is read from the one held', async () => {
    const { result } = mountHook({ organizationId: ORG, season: SEASON, seasonLoading: true });
    expect(result.current.status).toBe('loading');
    await settle();
    expect(h.reads).toEqual([]);
  });

  it('never serves the rows of a previous season: another season reads again', async () => {
    const other = { ...SEASON, id: '00000000-0000-4000-8000-0000000000aa' };
    const { result, rerender } = renderHook((props) => usePracticeDaylightOutlook(props), {
      initialProps: { organizationId: ORG, season: SEASON },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ organizationId: ORG, season: other });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });
});

describe('the page: a failed read draws no row, ever (plant P4)', () => {
  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={['/schedule/practice-daylight']}>
        <PracticeDaylightPage />
      </MemoryRouter>
    );

  it('reads the estate and draws every slot when nothing fails (the control)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('daylight-table')).toBeInTheDocument());
    expect(screen.getAllByTestId('daylight-row')).toHaveLength(8);
    expect(screen.queryByTestId('daylight-unreadable')).not.toBeInTheDocument();
  });

  it.each(EVERY_TABLE)(
    '%s failing: an alert naming it, and no row, no table, no empty message',
    async (table) => {
      h.fail = table;
      renderPage();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(table);
      expect(alert).toHaveTextContent('no outlook is shown');
      expect(screen.queryAllByTestId('daylight-row')).toHaveLength(0);
      expect(screen.queryByTestId('daylight-table')).not.toBeInTheDocument();
      expect(screen.queryByTestId('daylight-outlook')).not.toBeInTheDocument();
      expect(screen.queryByTestId('daylight-empty')).not.toBeInTheDocument();
      expect(screen.queryByText(/Ends by sunset all season/)).not.toBeInTheDocument();
      expect(screen.queryByText(/nothing to look at/)).not.toBeInTheDocument();
    }
  );

  it('a season with no time zone is said in words, with a way to set it, and reads nothing', async () => {
    h.org = { ...h.org, currentSeasonSetting: { ...SEASON, timezone: null } };
    renderPage();
    const blocked = await screen.findByTestId('daylight-blocked');
    expect(blocked).toHaveTextContent(NO_ZONE_MESSAGE);
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
      'href',
      '/settings'
    );
    expect(h.reads).toEqual([]);
  });

  it('says it is reading while the season is', () => {
    h.org = { ...h.org, seasonSettingsLoading: true };
    renderPage();
    expect(screen.getByTestId('daylight-loading')).toBeInTheDocument();
    expect(h.reads).toEqual([]);
  });

  it('asks for an organization before anything else', () => {
    h.org = { currentOrganization: null, currentSeasonSetting: null, seasonSettingsLoading: false };
    renderPage();
    expect(screen.getByText('Select an organization to continue.')).toBeInTheDocument();
    expect(h.reads).toEqual([]);
  });
});
