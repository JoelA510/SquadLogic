import { describe, it, expect, beforeEach } from 'vitest';
import { seedMockDb } from '../seedMockDb.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

describe('seedMockDb', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('writes rows to sessionStorage under __MOCK_DB__', () => {
    seedMockDb({ organizations: [{ id: MOCK_ORG_ID, name: 'A' }] });
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    expect(db.organizations).toEqual([{ id: MOCK_ORG_ID, name: 'A' }]);
  });

  it('appends rows to an existing table instead of clobbering', () => {
    seedMockDb({ teams: [{ id: 't-1' }] });
    seedMockDb({ teams: [{ id: 't-2' }] });
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    expect(db.teams).toEqual([{ id: 't-1' }, { id: 't-2' }]);
  });

  it('leaves tables absent from the call unchanged', () => {
    seedMockDb({ organizations: [{ id: MOCK_ORG_ID }], teams: [{ id: 't-1' }] });
    seedMockDb({ teams: [{ id: 't-2' }] });
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    expect(db.organizations).toEqual([{ id: MOCK_ORG_ID }]);
    expect(db.teams).toEqual([{ id: 't-1' }, { id: 't-2' }]);
  });

  it('initializes __MOCK_DB__ when sessionStorage is empty', () => {
    expect(sessionStorage.getItem('__MOCK_DB__')).toBeNull();
    seedMockDb({ players: [{ id: 'p-1' }] });
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    expect(db).toEqual({ players: [{ id: 'p-1' }] });
  });

  it('handles multiple tables in a single call', () => {
    seedMockDb({
      organizations: [{ id: MOCK_ORG_ID }],
      teams: [{ id: 't-1' }, { id: 't-2' }],
      players: [{ id: 'p-1' }],
    });
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    expect(db.organizations).toHaveLength(1);
    expect(db.teams).toHaveLength(2);
    expect(db.players).toHaveLength(1);
  });
});
