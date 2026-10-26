import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProgramsSection from '../frontend/src/components/settings/modules/ProgramsSection.jsx';
import ProgramOverview from '../frontend/src/components/teaming/ProgramOverview.jsx';
import {
  CreateProgramSchema,
  MergeProgramsSchema,
  ProgramNameSchema,
  SetDivisionProgramSchema,
} from '../frontend/src/utils/programSchemas.js';

/**
 * Settings > Season > Programs (Phase E2, "Program management"): admins create, rename, delete and
 * merge programs and move a division between them; a delete or a merge names the divisions that
 * move first; programs are optional, so a league with none sees an invitation and no program
 * heading on the pages that list its divisions.
 */
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  /** @type {{ programs: any, divisions: any }} */
  tables: { programs: [], divisions: [] },
  org: { currentSeasonSetting: { id: 'season-1', status: 'active' }, orgMember: { role: 'admin' } },
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
        order: () =>
          Promise.resolve(
            mocks.tables[table] === 'missing'
              ? { data: null, error: { code: 'PGRST205', message: `no table ${table}` } }
              : { data: mocks.tables[table], error: null }
          ),
      };
      return builder;
    },
  },
}));

const DEFAULT = { id: 'p-default', name: 'No program', is_default: true };
const JUNIOR = { id: 'p-junior', name: 'Junior', is_default: false };
const MINI = { id: 'p-mini', name: 'Mini', is_default: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.org.currentSeasonSetting = { id: 'season-1', status: 'active' };
  mocks.org.orgMember = { role: 'admin' };
  mocks.tables.programs = [DEFAULT, JUNIOR, MINI];
  mocks.tables.divisions = [
    { id: 'd-7b', name: 'U7B', program_id: 'p-junior' },
    { id: 'd-7g', name: 'U7G', program_id: 'p-junior' },
    { id: 'd-9b', name: 'U9B', program_id: 'p-default' },
  ];
  mocks.rpc.mockResolvedValue({ data: {}, error: null });
});

async function ready() {
  render(<ProgramsSection />);
  await screen.findByRole('heading', { name: 'Programs' });
  await screen.findByRole('heading', { name: 'Junior' });
}

describe('the Programs section', () => {
  it('says programs are optional, lists them with their divisions, and offers each division a program', async () => {
    await ready();
    expect(screen.getByText(/Programs are optional/)).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Programs of this season' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('U7B, U7G')).toBeTruthy();
    const select = /** @type {HTMLSelectElement} */ (screen.getByLabelText('Program for U7B'));
    expect(select.value).toBe('p-junior');
    expect(/** @type {HTMLSelectElement} */ (screen.getByLabelText('Program for U9B')).value).toBe(
      ''
    );
  });

  it('creates a program through the audited writer, after trimming and checking the name', async () => {
    await ready();
    const input = screen.getByLabelText('New program name');
    fireEvent.change(input, { target: { value: '  Select ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add program' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_upsert_program', {
        p_season_id: 'season-1',
        p_id: null,
        p_name: 'Select',
      })
    );
    await screen.findByText('Program "Select" added.');
  });

  it('moves a division between programs and out of one (NULL), one writer call each', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('Program for U9B'), { target: { value: 'p-mini' } });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_set_division_program', {
        p_division_id: 'd-9b',
        p_program_id: 'p-mini',
      })
    );
    fireEvent.change(screen.getByLabelText('Program for U7B'), { target: { value: '' } });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_set_division_program', {
        p_division_id: 'd-7b',
        p_program_id: null,
      })
    );
  });

  it('a delete names the divisions that move before it happens, and deletes only on confirm', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Delete the program Junior' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('U7B, U7G');
    expect(dialog.textContent).toContain('No program');
    expect(mocks.rpc).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_delete_program', { p_program_id: 'p-junior' })
    );
  });

  it('a merge names the divisions that move and the program they join', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('Merge Junior into'), { target: { value: 'p-mini' } });
    fireEvent.click(screen.getByRole('button', { name: 'Merge the program Junior' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('U7B, U7G');
    expect(dialog.textContent).toContain('"Mini"');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_merge_programs', {
        p_source_id: 'p-junior',
        p_target_id: 'p-mini',
      })
    );
  });

  it('renames a program through the same writer', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Rename the program Mini' }));
    fireEvent.change(screen.getByLabelText('New name for the program Mini'), {
      target: { value: 'Minis' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_upsert_program', {
        p_season_id: 'season-1',
        p_id: 'p-mini',
        p_name: 'Minis',
      })
    );
  });

  it("shows the database's own words when a change is refused", async () => {
    await ready();
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'a program named "Junior" already exists in this season' },
    });
    fireEvent.change(screen.getByLabelText('New program name'), { target: { value: 'Junior' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add program' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already exists in this season');
  });

  it('is read-only for a completed season', async () => {
    mocks.org.currentSeasonSetting = { id: 'season-1', status: 'completed' };
    await ready();
    expect(screen.getByText(/its programs are history/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add program' })).toBeNull();
    expect(
      /** @type {HTMLSelectElement} */ (screen.getByLabelText('Program for U7B')).disabled
    ).toBe(true);
  });

  it('is invisible before the migration: no table, nothing rendered', async () => {
    mocks.tables.programs = 'missing';
    const { container } = render(<ProgramsSection />);
    await waitFor(() => expect(mocks.rpc).not.toHaveBeenCalled());
    // Give the (failed) read time to settle; the section never appears.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe('');
  });
});

describe('programs stay optional', () => {
  it('a league with no program of its own sees the invitation and only the division list', async () => {
    mocks.tables.programs = [DEFAULT];
    mocks.tables.divisions = [{ id: 'd-9b', name: 'U9B', program_id: 'p-default' }];
    render(<ProgramsSection />);
    await screen.findByLabelText('Program for U9B');
    expect(screen.queryByRole('list', { name: 'Programs of this season' })).toBeNull();
    expect(screen.getByText(/leave this empty/)).toBeTruthy();
  });

  it('the division overview is a flat list with no program heading when it is not given groups', () => {
    const programs = [
      { id: 'u9b', name: 'U9B', playerCount: 10, estimatedTeams: 1, avgRosterSize: 10 },
      { id: 'u10b', name: 'U10B', playerCount: 12, estimatedTeams: 1, avgRosterSize: 12 },
    ];
    render(
      <ProgramOverview programs={programs} onSelectProgram={() => {}} selectedProgramId="u9b" />
    );
    expect(screen.queryByText('No program')).toBeNull();
    expect(screen.queryAllByRole('rowheader')).toHaveLength(0);
    expect(screen.getByRole('table', { name: 'Division Overview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'U9B' })).toBeTruthy();
  });

  it('groups the divisions under their programs, "No program" last, when it is given groups', () => {
    const programs = [
      { id: 'u9b', name: 'U9B', playerCount: 10, estimatedTeams: 1, avgRosterSize: 10 },
      { id: 'u7b', name: 'U7B', playerCount: 8, estimatedTeams: 1, avgRosterSize: 8 },
    ];
    render(
      <ProgramOverview
        programs={programs}
        groups={[
          { key: 'junior', label: 'Junior', ids: ['u7b'] },
          { key: 'none', label: 'No program', ids: ['u9b'] },
        ]}
        selectedProgramId=""
        onSelectProgram={() => {}}
      />
    );
    const headings = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(headings).toEqual(['Junior', 'No program']);
    expect(
      within(screen.getByTestId('program-group-junior')).getByRole('button', { name: 'U7B' })
    ).toBeTruthy();
  });
});

describe("the writers' Zod schemas", () => {
  it('trims a name and holds it to 1-80 characters', () => {
    expect(ProgramNameSchema.parse('  Junior ')).toBe('Junior');
    expect(ProgramNameSchema.safeParse('   ').success).toBe(false);
    expect(ProgramNameSchema.safeParse('x'.repeat(81)).success).toBe(false);
    expect(ProgramNameSchema.safeParse('x'.repeat(80)).success).toBe(true);
  });

  it('refuses a missing season, a merge into itself, and a division with no id', () => {
    expect(CreateProgramSchema.safeParse({ seasonId: '', name: 'A' }).success).toBe(false);
    expect(MergeProgramsSchema.safeParse({ sourceId: 'a', targetId: 'a' }).success).toBe(false);
    expect(MergeProgramsSchema.safeParse({ sourceId: 'a', targetId: 'b' }).success).toBe(true);
    expect(SetDivisionProgramSchema.safeParse({ divisionId: '', programId: null }).success).toBe(
      false
    );
    expect(SetDivisionProgramSchema.safeParse({ divisionId: 'd', programId: null }).success).toBe(
      true
    );
  });
});
