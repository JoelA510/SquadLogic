import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Papa from 'papaparse';
import ImportPanel from '../frontend/src/components/ImportPanel.jsx';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';
import { canonicalImportKey } from '../frontend/src/utils/importAllowlist.js';
import { normalizeImportRow } from '../frontend/src/utils/importRows.js';
import { validateEvaluationRow } from '../frontend/src/utils/importEvaluations.js';

/**
 * The column mapper's rewrite of an evaluations file (E3c; Codex, P2 on #684). With the real
 * PapaParse and no stub of the mapper, the panel's `handleMappingConfirm` rewrites the file from
 * what the admin mapped; what `import-validation` then reads from that file is normalized and
 * judged here by the same functions it uses (`canonicalImportKey`, `normalizeImportRow`,
 * `validateEvaluationRow`). The case: `Registration ID,Skill Level` with `GS-1,4`, where Skill Level
 * is mapped to Rating and Skill Tier is cleared. A source column the mapping consumed, or the
 * admin left unmapped, must not come through under its header's alias as well.
 */

const mocks = vi.hoisted(() => ({
  startImport: vi.fn(),
}));

vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({
    isImporting: false,
    progress: 0,
    importStatus: 'idle',
    startImport: mocks.startImport,
    applyDeferredImport: vi.fn(),
    cancelDeferredImport: vi.fn(),
    resetImport: vi.fn(),
    notifyOnComplete: false,
    setNotifyOnComplete: vi.fn(),
    importedPlayers: null,
    importedCoaches: null,
    importedEvaluations: null,
    importedFields: null,
    importedFieldAvailability: null,
    rollbackImport: vi.fn(),
    telemetryLogs: [],
    importLogs: [],
    activeJob: null,
  }),
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    currentSeasonSetting: { id: 'season-1', name: 'Spring 2026', status: 'active' },
    availableSeasons: [{ id: 'season-1', name: 'Spring 2026', status: 'active' }],
  }),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    rpc: vi.fn(),
  },
}));

/** The text of a File the panel built, as PapaParse is given it. */
const textOf = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(file);
  });

/** The header row and the first data row of the file the panel sends, as import-validation reads them. */
async function sentFile() {
  await waitFor(() => expect(mocks.startImport).toHaveBeenCalled());
  const [file, type] = mocks.startImport.mock.calls.at(-1);
  expect(type).toBe('evaluations');
  const text = (await textOf(file)).replace(/^\uFEFF/, '');
  const { data, meta } = Papa.parse(text, { header: true, skipEmptyLines: true });
  const normalized = normalizeImportRow(data[0], canonicalImportKey);
  return { fields: meta.fields, normalized, errors: validateEvaluationRow(normalized) };
}

const upload = async (name, csv) => {
  const file = new File([csv], name, { type: 'text/csv' });
  fireEvent.change(screen.getByLabelText(/browse files/i), { target: { files: [file] } });
  await screen.findByText(name);
};
const adjustMapping = async () => {
  fireEvent.click(screen.getByRole('button', { name: /adjust mapping/i }));
  await screen.findByRole('heading', { name: 'Map your columns' });
};
const confirmMapping = async (name) => {
  fireEvent.click(screen.getByRole('button', { name: /^continue/i }));
  // Back on the preview, for the rewritten file.
  await screen.findByText(name);
};

describe('ImportPanel: the evaluations column mapping rewrites the file from what was mapped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('imports numeric evaluations through Rating when Skill Level is mapped to it and Skill Tier is cleared', async () => {
    render(<ImportPanel onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^evaluations\b/i }));
    await upload('numeric.csv', 'Registration ID,Skill Level\nGS-1,4');
    await adjustMapping();

    // The mapper starts from the alias: Skill Level is the suggested Skill Tier.
    expect(screen.getByLabelText('Skill Tier source column')).toHaveValue('Skill Level');
    fireEvent.change(screen.getByLabelText('Skill Tier source column'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Rating source column'), {
      target: { value: 'Skill Level' },
    });
    await confirmMapping('numeric.mapped.csv');

    // The rewritten file's preview marks nothing, and the file sent carries the rating alone.
    expect(document.querySelectorAll('.cell-error')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    const sent = await sentFile();
    expect(sent.fields).toEqual(['external_registration_id', 'rating']);
    expect(sent.normalized).toEqual({ external_registration_id: 'GS-1', rating: '4' });
    expect(sent.errors).toEqual([]);
  });

  it('CONTROL: with Skill Tier mapped and Rating not, the tier word goes through as the tier', async () => {
    render(<ImportPanel onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^evaluations\b/i }));
    await upload('tier.csv', 'Registration ID,Skill Level\nGS-1,Developing');
    await adjustMapping();
    expect(screen.getByLabelText('Skill Tier source column')).toHaveValue('Skill Level');
    expect(screen.getByLabelText('Rating source column')).toHaveValue('');
    await confirmMapping('tier.mapped.csv');

    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    const sent = await sentFile();
    expect(sent.fields).toEqual(['external_registration_id', 'skill_tier']);
    expect(sent.normalized).toEqual({ external_registration_id: 'GS-1', skill_tier: 'Developing' });
    expect(sent.errors).toEqual([]);
  });

  it('leaves a value column the admin did not map out of the file, even when its header is an alias', async () => {
    render(<ImportPanel onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^evaluations\b/i }));
    await upload('extra.csv', 'Registration ID,Years Played,Rating\nGS-1,31,3');
    await adjustMapping();
    // Years Played is suggested; clearing it says the file's years are not wanted.
    fireEvent.change(screen.getByLabelText('Years Played source column'), {
      target: { value: '' },
    });
    await confirmMapping('extra.mapped.csv');

    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    const sent = await sentFile();
    expect(sent.fields).toEqual(['external_registration_id', 'rating']);
    expect(sent.errors).toEqual([]);
  });

  it('CONTROL: the coach mapping still keeps a column it did not map, as it always has', async () => {
    render(<ImportPanel onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^coaches\b/i }));
    await upload(
      'coaches.csv',
      'Coach Name,Contact Email,Shirt Size\nAda Byron,ada@example.test,AL'
    );
    await adjustMapping();
    await confirmMapping('coaches.mapped.csv');

    fireEvent.click(screen.getByRole('button', { name: /start import/i }));
    await waitFor(() => expect(mocks.startImport).toHaveBeenCalled());
    const [file, type] = mocks.startImport.mock.calls.at(-1);
    expect(type).toBe('coaches');
    const { meta } = Papa.parse((await textOf(file)).replace(/^\uFEFF/, ''), { header: true });
    // The canonical columns, then the raw column nothing mapped (a declared field may want it).
    expect(meta.fields).toEqual(['full_name', 'email', 'Shirt Size']);
  });
});
