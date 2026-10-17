import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTeamAnalysis } from '../frontend/src/hooks/useTeamAnalysis.js';
import { useImport } from '../frontend/src/contexts/ImportContext.jsx';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

vi.mock('../frontend/src/lib/logger', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: vi.fn(),
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));

describe('useTeamAnalysis', () => {
  // season_year controls U-group calculation — no need for fake timers
  const mockOrg = { id: MOCK_ORG_ID };
  const mockSeason = { id: MOCK_SEASON_ID, season_year: 2025 };

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error [MOCK] - partial mock for test isolation; context return value requires more comprehensive type mapping for full coverage
    vi.mocked(useOrganization).mockReturnValue({
      currentOrganization: mockOrg,
      currentSeasonSetting: mockSeason,
    });
  });

  afterEach(() => {
    // Safety: ensure real timers are restored in case a test enables fake timers
    vi.useRealTimers();
  });

  it('processes imported players into program groups', async () => {
    const mockPlayers = [
      { 'First Name': 'Alice', 'Last Name': 'Smith', Birthdate: '2016-01-01', Gender: 'f' }, // Age 9 (2025-2016) -> U9 Girls
      { 'First Name': 'Bob', 'Last Name': 'Brown', Birthdate: '2018-06-15', Gender: 'm' }, // Age 7 (2025-2018) -> U7 Boys
    ];

    // @ts-expect-error [MOCK] - partial mock for test isolation; context return value requires more comprehensive type mapping for full coverage
    vi.mocked(useImport).mockReturnValue({
      importedPlayers: { data: mockPlayers },
    });

    const { result } = renderHook(() => useTeamAnalysis());

    await waitFor(
      () => {
        expect(result.current.programs.length).toBeGreaterThan(0);
      },
      { timeout: 3000 }
    );

    const programNames = result.current.programs.map((p) => p.name);
    expect(programNames).toContain('U9 Girls');
    expect(programNames).toContain('U7 Boys');
  });

  it('reports missing DOB/Gender as validation errors', async () => {
    const mockPlayers = [
      { 'First Name': 'Missing', 'Last Name': 'Data' }, // No Birthdate/Gender
    ];

    // @ts-expect-error [MOCK] - partial mock for test isolation; context return value requires more comprehensive type mapping for full coverage
    vi.mocked(useImport).mockReturnValue({
      importedPlayers: { data: mockPlayers },
    });

    const { result } = renderHook(() => useTeamAnalysis());

    await waitFor(
      () => {
        expect(result.current.validationErrors.length).toBe(1);
      },
      { timeout: 2000 }
    );
    expect(result.current.validationErrors[0].type).toBe('missing_info');
  });
});
