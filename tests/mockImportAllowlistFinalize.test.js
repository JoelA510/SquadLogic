// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * The mock's finalize_import_job builds custom_attributes as the SQL does
 * (migration 20261022010000): each value read like import_payload_text (the
 * first key with a non-blank value, trimmed), the coaching answer from
 * `willing_to_coach`, `coach_volunteer` or the GotSport question, and a
 * re-import dropping an undeclared key the player already held. Placeholder
 * values only.
 */
async function importPlayers(jobId, rows) {
  await supabase
    .from('import_jobs')
    .insert({
      id: jobId,
      created_by: 'mock-admin-id',
      organization_id: MOCK_ORG_ID,
      job_type: 'registration',
      storage_path: `imports/mock-admin-id/${jobId}.csv`,
      status: 'importing',
      total_rows: rows.length,
      processed_rows: 0,
      progress_percent: 0,
    })
    .select();
  const { error: validationError } = await supabase.functions.invoke('import-validation', {
    body: {
      import_type: 'players',
      organization_id: MOCK_ORG_ID,
      rows,
      import_job_id: jobId,
      row_offset: 0,
    },
  });
  expect(validationError).toBeNull();
  const { data, error } = await supabase.rpc('finalize_import_job', {
    p_import_job_id: jobId,
    p_validation_errors: [],
  });
  expect(error).toBeNull();
  return data;
}

const BASE = {
  'First Name': 'First1',
  'Last Name': 'Last1',
  'Date of Birth': '2016-01-01',
  'Registration ID': 'REG-MOCK-1',
};

describe('the mock player finalizer builds custom_attributes as the SQL does', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    await supabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
  });

  it('trims team placement, reads the coaching answer from coach_volunteer, and re-filters on re-import', async () => {
    const first = await importPlayers('mock-job-allowlist-1', [
      {
        ...BASE,
        'Team Name': '  Team 9  ',
        'Team Age': '   ',
        coach_volunteer: ' Yes ',
        'Play Up': ' yes ',
      },
    ]);
    expect(first.inserted_players).toBe(1);
    const player = () =>
      getMockData('players').find((p) => p.external_registration_id === 'REG-MOCK-1');
    expect(player().custom_attributes).toEqual({
      team_name: 'Team 9',
      coaching_answer: 'yes',
    });
    // The play-up column is the request, not an attribute.
    expect(player().play_up_requested).toBe(true);

    // A key the import does not write, planted on the stored player.
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__'));
    const stored = db.players.find((p) => p.external_registration_id === 'REG-MOCK-1');
    stored.custom_attributes = { ...stored.custom_attributes, 'legacy column': 'x' };
    window.__saveMockDB__(db);

    const second = await importPlayers('mock-job-allowlist-2', [{ ...BASE }]);
    expect(second.updated_players).toBe(1);
    expect(player().custom_attributes).toEqual({
      team_name: 'Team 9',
      coaching_answer: 'yes',
    });
    // A re-import with no play-up column leaves the request alone.
    expect(player().play_up_requested).toBe(true);
  });

  it('reads each spelling of the play-up column as a request, anything else as none', async () => {
    /** @type {Array<[string, boolean]>} */
    const spellings = [
      ['yes', true],
      ['TRUE', true],
      ['1', true],
      ['x', true],
      ['no', false],
      ['maybe', false],
    ];
    for (const [index, [value, expected]] of spellings.entries()) {
      const externalId = `REG-PU-${index}`;
      await importPlayers(`mock-job-playup-${index}`, [
        { ...BASE, 'Registration ID': externalId, 'Play Up': value },
      ]);
      expect(
        getMockData('players').find((p) => p.external_registration_id === externalId)
          .play_up_requested,
        String(value)
      ).toBe(expected);
    }
  });

  it('trims a value staged untrimmed, as a direct write to staging could leave it', async () => {
    await importPlayers('mock-job-allowlist-3', [{ ...BASE, 'Registration ID': 'REG-MOCK-3' }]);
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__'));
    db.import_jobs.push({
      id: 'mock-job-allowlist-4',
      organization_id: MOCK_ORG_ID,
      job_type: 'registration',
      status: 'importing',
    });
    db.staging_players.push({
      id: 'mock-staged-untrimmed',
      organization_id: MOCK_ORG_ID,
      import_job_id: 'mock-job-allowlist-4',
      source_row_number: 1,
      raw_payload: {},
      normalized_payload: {
        first_name: 'First1',
        last_name: 'Last1',
        date_of_birth: '2016-01-01',
        external_registration_id: 'REG-MOCK-3',
        'team name': '  Team 7  ',
        'team age': '   ',
      },
      validation_errors: [],
    });
    window.__saveMockDB__(db);

    const { error } = await supabase.rpc('finalize_import_job', {
      p_import_job_id: 'mock-job-allowlist-4',
      p_validation_errors: [],
    });
    expect(error).toBeNull();
    expect(
      getMockData('players').find((p) => p.external_registration_id === 'REG-MOCK-3')
        .custom_attributes
    ).toEqual({ team_name: 'Team 7' });
  });
});
