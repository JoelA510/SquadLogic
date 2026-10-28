import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SeasonsSection from '../frontend/src/components/settings/modules/SeasonsSection.jsx';
import {
  CreateSeasonFromSchema,
  CutoffSchema,
  DivisionWindowSchema,
  SeasonPatchSchema,
} from '../frontend/src/utils/seasonSchemas.js';

/**
 * Settings > Season > Seasons (Phase E3b): the seasons with their status; start the next season
 * from one; edit a draft (name, dates, year, the age cutoff and each division's optional window);
 * activate it. A completed season can be started from and nothing else.
 */
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  refetchOrgs: vi.fn(),
  switchSeason: vi.fn(),
  /** @type {{ players: any[], divisions: any[] }} */
  tables: { players: [], divisions: [] },
  org: /** @type {any} */ ({}),
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => mocks.org,
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: (...args) => mocks.rpc(...args),
    from: (table) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        limit: () => Promise.resolve({ data: mocks.tables[table].slice(0, 1), error: null }),
        order: () => Promise.resolve({ data: mocks.tables[table], error: null }),
      };
      return builder;
    },
  },
}));

const ACTIVE = {
  id: 's-active',
  name: 'Fall 2026',
  status: 'active',
  season_year: 2026,
  season_start: '2026-08-01',
  season_end: '2027-06-30',
  timezone: 'America/Chicago',
  age_cutoff_mode: 'school_year_aug_jul',
};
const DRAFT = {
  id: 's-draft',
  name: 'Fall 2027',
  status: 'draft',
  season_year: 2027,
  season_start: '2027-08-01',
  season_end: '2028-06-30',
  timezone: 'America/Chicago',
  age_cutoff_mode: 'custom',
  age_cutoff_month: 9,
  age_cutoff_day: 1,
};
const DONE = {
  id: 's-done',
  name: 'Fall 2025',
  status: 'completed',
  season_year: 2025,
  season_start: '2025-08-01',
  season_end: '2026-06-30',
  age_cutoff_mode: 'birth_year',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.org = {
    availableSeasons: [ACTIVE, DRAFT, DONE],
    currentSeasonSetting: ACTIVE,
    orgMember: { role: 'admin' },
    refetchOrgs: mocks.refetchOrgs,
    switchSeason: mocks.switchSeason,
  };
  mocks.tables.players = [];
  mocks.tables.divisions = [
    { id: 'd-u4', name: 'U4', birthdate_start: null, birthdate_end: null },
    { id: 'd-u10', name: 'U10', birthdate_start: '2015-09-01', birthdate_end: '2016-08-31' },
  ];
  mocks.rpc.mockResolvedValue({ data: { id: 'x' }, error: null });
});

const seasonItem = (name) =>
  within(screen.getByRole('list', { name: 'Seasons of this league' }))
    .getAllByRole('listitem')
    .find((li) => within(li).queryByRole('heading', { name: new RegExp(name) }));

describe('the Seasons section lists the seasons', () => {
  it('shows each season with its status, year, dates and age cutoff', () => {
    render(<SeasonsSection />);
    const items = within(screen.getByRole('list', { name: 'Seasons of this league' })).getAllByRole(
      'listitem'
    );
    expect(items).toHaveLength(3);
    expect(within(seasonItem('Fall 2026')).getByText('Active')).toBeTruthy();
    expect(within(seasonItem('Fall 2027')).getByText('Draft')).toBeTruthy();
    expect(within(seasonItem('Fall 2025')).getByText('Completed')).toBeTruthy();
    expect(seasonItem('Fall 2027').textContent).toContain('Aug 1, 2027 to Jun 30, 2028');
    expect(seasonItem('Fall 2027').textContent).toContain('Custom: September 1');
    expect(seasonItem('Fall 2026').textContent).toContain('School year (Aug 1)');
    expect(seasonItem('Fall 2025').textContent).toContain('Calendar year (Jan 1)');
    expect(within(seasonItem('Fall 2026')).getByText('(shown)')).toBeTruthy();
  });

  it('offers a completed season only the start of the next one, and a non-admin nothing', () => {
    render(<SeasonsSection />);
    const done = seasonItem('Fall 2025');
    expect(within(done).getByRole('button', { name: /Start next season from/ })).toBeTruthy();
    expect(within(done).queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(within(done).queryByRole('button', { name: /^Activate/ })).toBeNull();
    const active = seasonItem('Fall 2026');
    expect(within(active).queryByRole('button', { name: /^Activate/ })).toBeNull();
    expect(within(active).getByRole('button', { name: /^Edit/ })).toBeTruthy();
  });

  it('shows no buttons to someone who cannot manage the organization', () => {
    mocks.org.orgMember = { role: 'coach' };
    render(<SeasonsSection />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Fall 2027')).toBeTruthy();
  });

  it('renders nothing before the seasons are known', () => {
    mocks.org.availableSeasons = [];
    const { container } = render(<SeasonsSection />);
    expect(container.textContent).toBe('');
  });
});

describe('start next season', () => {
  it('suggests the next year as the name and the year, says what is not copied, and creates the draft', async () => {
    render(<SeasonsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Start next season from Fall 2026' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start next season' });
    expect(within(dialog).getByText(/Players, coaches and teams are not copied/)).toBeTruthy();
    expect(
      /** @type {HTMLInputElement} */ (within(dialog).getByLabelText('Season name')).value
    ).toBe('2027');
    expect(
      /** @type {HTMLInputElement} */ (
        within(dialog).getByLabelText('Season year (the year the season starts)')
      ).value
    ).toBe('2027');
    fireEvent.change(within(dialog).getByLabelText('Season name'), {
      target: { value: '  Winter 2027 ' },
    });
    fireEvent.change(within(dialog).getByLabelText('Start date (optional)'), {
      target: { value: '2027-01-10' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create draft season' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_create_season_from', {
        p_source_season_id: 's-active',
        p_name: 'Winter 2027',
        p_season_year: 2027,
        p_season_start: '2027-01-10',
        p_season_end: null,
      })
    );
    await waitFor(() => expect(mocks.refetchOrgs).toHaveBeenCalled());
    expect(
      await screen.findByText(/Draft season "Winter 2027" created from "Fall 2026"/)
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('writes a dual-year name when the league names seasons that way', async () => {
    render(<SeasonsSection seasonFormat="dual" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start next season from Fall 2026' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start next season' });
    expect(
      /** @type {HTMLInputElement} */ (within(dialog).getByLabelText('Season name')).value
    ).toBe('2027-2028');
  });

  it('says a mistake in words before the call, and the database’s refusal after it', async () => {
    render(<SeasonsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Start next season from Fall 2026' }));
    let dialog = await screen.findByRole('dialog', { name: 'Start next season' });
    fireEvent.change(within(dialog).getByLabelText('Start date (optional)'), {
      target: { value: '2027-09-01' },
    });
    fireEvent.change(within(dialog).getByLabelText('End date (optional)'), {
      target: { value: '2027-08-01' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create draft season' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The season cannot end before it starts.'
    );
    expect(mocks.rpc).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('End date (optional)'), {
      target: { value: '2028-06-01' },
    });
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'a season named "2027" already exists' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create draft season' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'a season named "2027" already exists'
    );
    dialog = screen.getByRole('dialog', { name: 'Start next season' });
    expect(dialog).toBeTruthy();
    expect(mocks.refetchOrgs).not.toHaveBeenCalled();
  });
});

describe('edit a draft', () => {
  const openDraft = async () => {
    render(<SeasonsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Fall 2027' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Fall 2027' });
    await waitFor(() => expect(within(dialog).getByLabelText('Cutoff')).not.toBeDisabled());
    return dialog;
  };

  it('sends only what changed, with the custom cutoff day', async () => {
    const dialog = await openDraft();
    fireEvent.change(within(dialog).getByLabelText('Season name'), {
      target: { value: 'Winter 2027' },
    });
    fireEvent.change(within(dialog).getByLabelText('Cutoff month'), { target: { value: '7' } });
    fireEvent.change(within(dialog).getByLabelText('Cutoff day'), { target: { value: '31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save season' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_update_draft_season', {
        p_season_id: 's-draft',
        p_patch: {
          name: 'Winter 2027',
          age_cutoff_mode: 'custom',
          age_cutoff_month: 7,
          age_cutoff_day: 31,
        },
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('tells the admin to finish or cancel the pending import when the database refuses the change', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '22023',
        message:
          'Season s-draft has a player import in progress: finish or cancel it before its age cutoff or season year changes',
        details: 'import_pending',
      },
    });
    const dialog = await openDraft();
    fireEvent.change(within(dialog).getByLabelText('Cutoff day'), { target: { value: '15' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save season' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Finish or cancel the pending import first'
    );
    // The dialog stays open: nothing was saved.
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // A division window is refused the same way.
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'x', details: 'import_pending' },
    });
    fireEvent.change(within(dialog).getByLabelText('U4: born from'), {
      target: { value: '2023-01-01' },
    });
    fireEvent.change(within(dialog).getByLabelText('U4: born through'), {
      target: { value: '2024-07-31' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the window for U4' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_set_division_birthdate_window', {
        p_division_id: 'd-u4',
        p_birthdate_start: '2023-01-01',
        p_birthdate_end: '2024-07-31',
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Finish or cancel the pending import first'
      )
    );
  });

  it('switches to a preset, which clears the custom day', async () => {
    const dialog = await openDraft();
    fireEvent.change(within(dialog).getByLabelText('Cutoff'), {
      target: { value: 'birth_year' },
    });
    expect(within(dialog).queryByLabelText('Cutoff day')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save season' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_update_draft_season', {
        p_season_id: 's-draft',
        p_patch: { age_cutoff_mode: 'birth_year', age_cutoff_month: null, age_cutoff_day: null },
      })
    );
  });

  it('refuses a custom cutoff with no day, or a day the month does not have, before any call', async () => {
    const dialog = await openDraft();
    fireEvent.change(within(dialog).getByLabelText('Cutoff month'), { target: { value: '2' } });
    fireEvent.change(within(dialog).getByLabelText('Cutoff day'), { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save season' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That month does not have that many days.'
    );
    fireEvent.change(within(dialog).getByLabelText('Cutoff day'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save season' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Pick the month and day of the cutoff.'
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('fixes the year and the cutoff once the season has players, and says why', async () => {
    mocks.tables.players = [{ id: 'p1' }];
    render(<SeasonsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Fall 2027' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Fall 2027' });
    await within(dialog).findByText(/their ages were counted with this rule/);
    expect(within(dialog).getByLabelText('Cutoff')).toBeDisabled();
    expect(
      within(dialog).getByLabelText('Season year (the year the season starts)')
    ).toBeDisabled();
    expect(within(dialog).getByLabelText('U10: born from')).toBeDisabled();
    // The name and the dates stay editable.
    expect(within(dialog).getByLabelText('Season name')).not.toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Season name'), {
      target: { value: 'Renamed' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save season' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_update_draft_season', {
        p_season_id: 's-draft',
        p_patch: { name: 'Renamed' },
      })
    );
  });

  it('leaves the cutoff and year of the active season fixed, and edits only its name and dates', async () => {
    render(<SeasonsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Fall 2026' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Fall 2026' });
    expect(within(dialog).getByText(/can only change on a draft/)).toBeTruthy();
    expect(within(dialog).getByLabelText('Cutoff')).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('End date'), {
      target: { value: '2027-07-15' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save season' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_update_draft_season', {
        p_season_id: 's-active',
        p_patch: { season_end: '2027-07-15' },
      })
    );
  });

  it('sets and clears a division’s birth-date window through the audited writer', async () => {
    const dialog = await openDraft();
    const save = within(dialog).getByRole('button', { name: 'Save the window for U4' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('U4: born from'), {
      target: { value: '2023-01-01' },
    });
    fireEvent.change(within(dialog).getByLabelText('U4: born through'), {
      target: { value: '2024-07-31' },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_set_division_birthdate_window', {
        p_division_id: 'd-u4',
        p_birthdate_start: '2023-01-01',
        p_birthdate_end: '2024-07-31',
      })
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear the window for U10' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_set_division_birthdate_window', {
        p_division_id: 'd-u10',
        p_birthdate_start: null,
        p_birthdate_end: null,
      })
    );
  });
});

describe('activate a draft', () => {
  it('names what is missing and disables Activate until it is there', () => {
    mocks.org.availableSeasons = [
      ACTIVE,
      { ...DRAFT, timezone: null, season_end: null, season_year: null },
    ];
    render(<SeasonsSection />);
    const draft = seasonItem('Fall 2027');
    expect(draft.textContent).toContain(
      'To activate it, set a timezone, a start and an end date, a season year.'
    );
    expect(within(draft).getByRole('button', { name: 'Activate Fall 2027' })).toBeDisabled();
  });

  it('asks first, says which season is completed, activates, and follows the new season in the header', async () => {
    render(<SeasonsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Activate Fall 2027' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate season' });
    expect(dialog.textContent).toContain('"Fall 2026" is completed');
    expect(dialog.textContent).toContain('cannot be activated again');
    expect(mocks.rpc).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_activate_season', { p_season_id: 's-draft' })
    );
    await waitFor(() =>
      expect(mocks.switchSeason).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's-draft', status: 'active' })
      )
    );
    expect(
      await screen.findByText(/"Fall 2027" is now the active season; "Fall 2026" is completed/)
    ).toBeTruthy();
  });

  it('shows the database’s refusal and leaves the header alone', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '22023',
        message: 'Season s-draft needs a known timezone before it is activated',
      },
    });
    render(<SeasonsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Activate Fall 2027' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate season' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needs a known timezone');
    expect(mocks.switchSeason).not.toHaveBeenCalled();
  });
});

describe('the schemas', () => {
  it('trim and bound a name, bound the year, and order the dates', () => {
    expect(
      CreateSeasonFromSchema.parse({
        sourceId: 's',
        name: '  X ',
        year: '2027',
        start: '',
        end: '',
      })
    ).toMatchObject({ name: 'X', year: 2027, start: null, end: null });
    expect(() => CreateSeasonFromSchema.parse({ sourceId: 's', name: ' ', year: 2027 })).toThrow();
    expect(() => CreateSeasonFromSchema.parse({ sourceId: 's', name: 'X', year: 1999 })).toThrow();
    expect(() =>
      CreateSeasonFromSchema.parse({ sourceId: 's', name: 'x'.repeat(81), year: 2027 })
    ).toThrow();
    expect(() =>
      CreateSeasonFromSchema.parse({
        sourceId: 's',
        name: 'X',
        year: 2027,
        start: '2027-02-01',
        end: '2027-01-01',
      })
    ).toThrow();
  });

  it('judge a custom cutoff, a window and a patch', () => {
    expect(CutoffSchema.safeParse({ mode: 'custom', month: 2, day: 29 }).success).toBe(true);
    expect(CutoffSchema.safeParse({ mode: 'custom', month: 4, day: 31 }).success).toBe(false);
    expect(CutoffSchema.safeParse({ mode: 'custom', month: null, day: null }).success).toBe(false);
    expect(CutoffSchema.safeParse({ mode: 'birth_year' }).success).toBe(true);
    expect(CutoffSchema.safeParse({ mode: 'lunar' }).success).toBe(false);
    expect(
      DivisionWindowSchema.safeParse({ divisionId: 'd', start: null, end: null }).success
    ).toBe(true);
    expect(
      DivisionWindowSchema.safeParse({ divisionId: 'd', start: '2023-01-01', end: null }).success
    ).toBe(false);
    expect(
      DivisionWindowSchema.safeParse({ divisionId: 'd', start: '2024-01-01', end: '2023-01-01' })
        .success
    ).toBe(false);
    expect(SeasonPatchSchema.safeParse({ status: 'active' }).success).toBe(false);
    expect(SeasonPatchSchema.safeParse({ name: ' ok ', season_end: null }).data).toEqual({
      name: 'ok',
      season_end: null,
    });
  });
});
