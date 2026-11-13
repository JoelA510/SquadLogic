// @vitest-environment jsdom
/**
 * F11-4b task B1 (docs/changes/2026-11-13-settings-scope.md, "The screen"): the Settings panel for scoped settings.
 * One table per registered key, its caption the key's label; rows: the organization, then each program with its
 * divisions, then "No program" (not settable: decision S4) with its divisions. Each settable row has a native select
 * (Inherit / Count / Don't count) and an "Applies now" column computed by core's twin of the resolver
 * (`resolveScopedSetting`), saying the value and where it comes from.
 *
 * Driven through the real mock client (lesson 107: the page's calls, in order, against the twin): every change is one
 * `admin_set_scoped_setting` call, the panel reads the rows back, and what it shows is what the mock stored. The
 * refusals are the mock's, which holds the SQL's codes and details (tests/mockScopedSettings.test.js).
 */
import React from 'react';
import axe from 'axe-core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-scoped';
const SEASON = 'season-scoped';
const OLD = 'season-scoped-old';
const ADMIN = 'admin-scoped';
const KEY = 'standings_count_outside_results';
const CAPTION = 'Count results against outside clubs';

const ctx = vi.hoisted(() => ({
  org: {
    currentOrganization: { id: 'org-scoped', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-scoped', status: 'active' },
    orgMember: { role: 'admin' },
    featureFlags: /** @type {Record<string, boolean>} */ ({ standings: true }),
  },
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ctx.org,
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { default: ScopedSettingsSection } =
  await import('../frontend/src/components/settings/modules/ScopedSettingsSection.jsx');

const division = (id, name, programId, season = SEASON) => ({
  id,
  organization_id: ORG,
  season_settings_id: season,
  program_id: programId,
  name,
});
const program = (id, name, isDefault = false, season = SEASON) => ({
  id,
  organization_id: ORG,
  season_settings_id: season,
  name,
  is_default: isDefault,
});

/** Set a value through the mock's setter, as an admin would have before the page opened. */
async function preset(scope, scopeId, value) {
  const { error } = await mockSupabase.rpc('admin_set_scoped_setting', {
    p_key: KEY,
    p_scope: scope,
    p_scope_id: scopeId,
    p_value: value,
  });
  expect(error, `the ${scope} value is set`).toBe(null);
}

function seed() {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  seedMockDb({
    organizations: [{ id: ORG, name: 'Synthetic FC', feature_flags: { standings: true } }],
    organization_members: [{ organization_id: ORG, profile_id: ADMIN, role: 'admin' }],
    season_settings: [
      { id: SEASON, organization_id: ORG, status: 'active', name: 'Spring' },
      { id: OLD, organization_id: ORG, status: 'completed', name: 'Last spring' },
    ],
    programs: [
      program('p-default', 'No program', true),
      program('p-juniors', 'Juniors'),
      program('p-old-default', 'No program', true, OLD),
    ],
    divisions: [
      division('d-u8', 'U8', 'p-juniors'),
      division('d-u10', 'U10', 'p-juniors'),
      division('d-u12', 'U12', 'p-default'),
      // A completed season's two divisions, in no program: an organization change holds them at their old value.
      division('d-old-u8', 'U8', 'p-old-default', OLD),
      division('d-old-u10', 'U10', 'p-old-default', OLD),
    ],
    scoped_settings: [],
    audit_log: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: ADMIN } }));
}

const table = () => screen.findByRole('table', { name: CAPTION });
/** The select of a row, by its accessible name (the row's header, then the caption). */
const select = (rowName) =>
  /** @type {HTMLSelectElement} */ (
    screen.getByRole('combobox', { name: `${rowName} ${CAPTION}` })
  );
/** The "Applies now" cell of a row, by its row header. */
function appliesNow(rowName) {
  const header = screen.getByRole('rowheader', { name: rowName });
  const cells = within(/** @type {HTMLElement} */ (header.closest('tr'))).getAllByRole('cell');
  return cells[cells.length - 1].textContent.trim();
}
/** The mock database as stored (the page's writes go through saveDB, which stores it). */
const storedDb = () =>
  /** @type {any} */ (window).__MOCK_DB__ ??
  JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
const storedRows = () => storedDb().scoped_settings ?? [];
/** Change the stored database as another session would, through the mock's own writer. */
function mutateDb(change) {
  const db = storedDb();
  change(db);
  /** @type {any} */ (window).__saveMockDB__(db);
}

async function ready() {
  render(<ScopedSettingsSection />);
  await table();
  await waitFor(() => expect(screen.queryByText('Loading settings…')).not.toBeInTheDocument());
}

beforeEach(() => {
  vi.restoreAllMocks();
  ctx.org.currentSeasonSetting = { id: SEASON, status: 'active' };
  ctx.org.orgMember = { role: 'admin' };
  ctx.org.featureFlags = { standings: true };
  seed();
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

describe('the scoped settings panel :: one table per setting, every level, what applies now', () => {
  it('lists the organization, each program with its divisions, and "No program" with its divisions', async () => {
    await preset('organization', ORG, true);
    await preset('program', 'p-juniors', false);
    await preset('division', 'd-u10', true);
    await ready();
    // the name the Standings page points to (tests/standingsOutsideClubs.test.jsx)
    expect(screen.getByRole('heading', { name: 'Settings by program and division' })).toBeTruthy();
    const t = await table();
    const headers = within(t)
      .getAllByRole('rowheader')
      .map((h) => h.textContent.trim());
    expect(headers).toEqual([
      'Organization: Synthetic FC',
      'Program: Juniors',
      // by name, as the database orders them (and the Programs section shows them)
      'Division: U10',
      'Division: U8',
      'No program',
      'Division: U12',
    ]);
    // the stored value at each level, "" being Inherit
    expect(select('Organization: Synthetic FC').value).toBe('true');
    expect(select('Program: Juniors').value).toBe('false');
    expect(select('Division: U8').value).toBe('');
    expect(select('Division: U10').value).toBe('true');
    expect(select('Division: U12').value).toBe('');
    // what applies, and from where: the most specific level that holds a value
    expect(appliesNow('Organization: Synthetic FC')).toBe('Counted, set here');
    expect(appliesNow('Program: Juniors')).toBe('Not counted, set here');
    expect(appliesNow('Division: U8')).toBe('Not counted, from the program Juniors');
    expect(appliesNow('Division: U10')).toBe('Counted, set here');
    expect(appliesNow('Division: U12')).toBe('Counted, from the organization');
  });

  it('with nothing set, every level says the default, and the organization offers "Default (don\'t count)"', async () => {
    await ready();
    const org = select('Organization: Synthetic FC');
    expect([...org.options].map((o) => o.textContent)).toEqual([
      "Default (don't count)",
      'Count',
      "Don't count",
    ]);
    expect([...select('Division: U8').options].map((o) => o.textContent)).toEqual([
      'Inherit',
      'Count',
      "Don't count",
    ]);
    expect(appliesNow('Organization: Synthetic FC')).toBe('Not counted, by default');
    expect(appliesNow('Division: U8')).toBe('Not counted, by default');
    expect(appliesNow('Division: U12')).toBe('Not counted, by default');
  });

  it('shows "No program" as not settable, says why in words, and gives it no control', async () => {
    await ready();
    const header = screen.getByRole('rowheader', { name: 'No program' });
    const row = /** @type {HTMLElement} */ (header.closest('tr'));
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(row.textContent).toMatch(
      /Not settable: “No program” holds no settings\. Its divisions follow the organization\./
    );
    // its division still has its own control
    expect(select('Division: U12')).toBeTruthy();
  });
});

describe('a change :: one setter call, read back, said in words', () => {
  it('"Don\'t count" on a division under a program set to "Count" saves, reads back and says "Not counted, set here"', async () => {
    await preset('program', 'p-juniors', true);
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    await ready();
    expect(appliesNow('Division: U8')).toBe('Counted, from the program Juniors');
    fireEvent.change(select('Division: U8'), { target: { value: 'false' } });
    await waitFor(() => expect(appliesNow('Division: U8')).toBe('Not counted, set here'));
    const calls = rpc.mock.calls.filter(([name]) => name === 'admin_set_scoped_setting');
    expect(calls).toEqual([
      [
        'admin_set_scoped_setting',
        { p_key: KEY, p_scope: 'division', p_scope_id: 'd-u8', p_value: false },
      ],
    ]);
    expect(select('Division: U8').value).toBe('false');
    // what is shown is what is stored
    expect(
      storedRows().find((r) => r.division_id === 'd-u8' && r.key === KEY)?.value,
      'the division row is stored'
    ).toBe(false);
    expect(screen.getByRole('status').textContent).toBe("Saved. Division: U8: Don't count.");
    // CONTROL: its sibling still follows the program
    expect(appliesNow('Division: U10')).toBe('Counted, from the program Juniors');
  });

  it('"Inherit" sends p_value null and deletes the level\'s row: the division follows its program again', async () => {
    await preset('program', 'p-juniors', true);
    await preset('division', 'd-u10', false);
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    await ready();
    expect(appliesNow('Division: U10')).toBe('Not counted, set here');
    fireEvent.change(select('Division: U10'), { target: { value: '' } });
    await waitFor(() =>
      expect(appliesNow('Division: U10')).toBe('Counted, from the program Juniors')
    );
    expect(rpc.mock.calls.filter(([name]) => name === 'admin_set_scoped_setting')).toEqual([
      [
        'admin_set_scoped_setting',
        { p_key: KEY, p_scope: 'division', p_scope_id: 'd-u10', p_value: null },
      ],
    ]);
    expect(storedRows().some((r) => r.division_id === 'd-u10')).toBe(false);
    expect(screen.getByRole('status').textContent).toBe('Saved. Division: U10: Inherit.');
  });

  it('an organization change on a league with completed seasons says how many divisions keep their old value', async () => {
    await ready();
    fireEvent.change(select('Organization: Synthetic FC'), { target: { value: 'true' } });
    await waitFor(() => expect(appliesNow('Organization: Synthetic FC')).toBe('Counted, set here'));
    expect(screen.getByRole('status').textContent).toBe(
      'Saved. Organization: Synthetic FC: Count. 2 divisions in completed seasons keep their old value.'
    );
    // the two completed-season divisions were held (the mock's count is the SQL's frozen_completed_divisions)
    expect(storedRows().filter((r) => r.frozen_from_organization)).toHaveLength(2);
    // the current season's divisions follow the change
    expect(appliesNow('Division: U12')).toBe('Counted, from the organization');
  });

  it('one held division is said in the singular, and none is said not at all', async () => {
    // One completed-season division already has its own value (set while its season was active), so only one
    // inherits the organization's today. Its season is completed, so the row is placed as the past left it.
    mutateDb((db) =>
      db.scoped_settings.push({
        id: 'row-old-u10',
        organization_id: ORG,
        program_id: null,
        division_id: 'd-old-u10',
        key: KEY,
        value: false,
        frozen_from_organization: false,
      })
    );
    await ready();
    fireEvent.change(select('Organization: Synthetic FC'), { target: { value: 'true' } });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Saved. Organization: Synthetic FC: Count. 1 division in a completed season keeps its old value.'
      )
    );
    // back to the default: the frozen rows stand, nothing new is held, so no count is said
    fireEvent.change(select('Organization: Synthetic FC'), { target: { value: '' } });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        "Saved. Organization: Synthetic FC: Default (don't count)."
      )
    );
  });

  it('a refusal is said in words in the alert region, with no record id, and nothing is stored', async () => {
    await ready();
    // another admin completes the season after the page was read: the server refuses the change
    mutateDb((db) => {
      db.season_settings.find((s) => s.id === SEASON).status = 'completed';
    });
    fireEvent.change(select('Division: U8'), { target: { value: 'true' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Not saved: this season is completed, so its programs’ and divisions’ settings are history and cannot be changed.'
    );
    expect(alert.textContent).not.toMatch(/season-scoped/);
    expect(storedRows().some((r) => r.division_id === 'd-u8')).toBe(false);
    // the control shows what is stored, not what was chosen
    expect(select('Division: U8').value).toBe('');
  });
});

describe('read-only and hidden', () => {
  it('a completed season shows its programs and divisions read-only, with the reason; the organization stays editable', async () => {
    ctx.org.currentSeasonSetting = { id: SEASON, status: 'completed' };
    await preset('division', 'd-u8', true);
    mutateDb((db) => {
      db.season_settings.find((s) => s.id === SEASON).status = 'completed';
    });
    await ready();
    const reason = screen.getByText(
      'This season is completed: its programs’ and divisions’ settings are history and cannot be changed. The organization’s setting applies to the seasons to come.'
    );
    for (const name of ['Program: Juniors', 'Division: U8', 'Division: U10', 'Division: U12']) {
      const control = select(name);
      expect(control.disabled, `${name} is read-only`).toBe(true);
      expect(control.getAttribute('aria-describedby')).toBe(reason.id);
    }
    expect(select('Division: U8').value).toBe('true');
    expect(appliesNow('Division: U8')).toBe('Counted, set here');
    expect(select('Organization: Synthetic FC').disabled).toBe(false);
  });

  it('is hidden from a member who is not an admin (the server refuses them anyway)', async () => {
    ctx.org.orgMember = { role: 'coach' };
    const { container } = render(<ScopedSettingsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says the setting applies once Standings is on, when Standings is off', async () => {
    ctx.org.featureFlags = {};
    await ready();
    expect(
      screen.getByText(
        'Standings are off for this league: this setting takes effect once Standings is turned on (Settings, Features). What is set here is kept.'
      )
    ).toBeTruthy();
  });

  it('CONTROL: says nothing about Standings when Standings is on', async () => {
    await ready();
    expect(screen.queryByText(/Standings are off/)).not.toBeInTheDocument();
  });
});

describe('labels and keyboard', () => {
  it('every select has an accessible name naming its row and the setting, and is in the tab order', async () => {
    await ready();
    const selects = screen.getAllByRole('combobox');
    expect(selects).toHaveLength(5);
    for (const control of selects) {
      expect(control.tagName).toBe('SELECT');
      expect(control.getAttribute('tabindex')).not.toBe('-1');
      control.focus();
      expect(document.activeElement).toBe(control);
    }
    // the names, each unique
    const names = selects.map((control) =>
      /** @type {string} */ (control.getAttribute('aria-labelledby'))
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .join(' ')
    );
    expect(names).toEqual([
      `Organization: Synthetic FC ${CAPTION}`,
      `Program: Juniors ${CAPTION}`,
      `Division: U10 ${CAPTION}`,
      `Division: U8 ${CAPTION}`,
      `Division: U12 ${CAPTION}`,
    ]);
  });

  it.each(['light', 'dark'])('axe finds no violation in the %s theme', async (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    await preset('program', 'p-juniors', true);
    const { container } = render(<ScopedSettingsSection />);
    await within(container).findByRole('table', { name: CAPTION });
    await waitFor(() => expect(screen.queryByText('Loading settings…')).not.toBeInTheDocument());
    // jsdom draws no colours, so contrast is the E2E's (both themes); every other WCAG A/AA rule runs here
    const results = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.passes.length, 'axe passed some rule: the panel rendered').toBeGreaterThan(0);
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
