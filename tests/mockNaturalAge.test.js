// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * The mock twin of R5 (docs/changes/2026-10-22-admin-focus.md; migration
 * 20261026010000): import-validation computes the player's natural age (the birth
 * date with the active season's cutoff, else the age group the export states),
 * stages no birth key and returns the row, birth date included, for the import
 * session; finalize_import_job stores the natural age and no birth date, and
 * promotes a row with none. Placeholder values only.
 */
async function signIn() {
  sessionStorage.clear();
  window.__MOCK_DB__ = undefined;
  await supabase.auth.signInWithPassword({
    email: 'admin@example.com',
    password: 'test-password-123',
  });
}

/** The active season counts ages in `seasonYear` with `cutoffMode`. */
function setSeason(seasonYear, cutoffMode) {
  const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__'));
  const season = db.season_settings.find(
    (row) => row.organization_id === MOCK_ORG_ID && row.status === 'active'
  );
  season.season_year = seasonYear;
  season.age_cutoff_mode = cutoffMode;
  window.__saveMockDB__(db);
}

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
  const { data: validated, error: validationError } = await supabase.functions.invoke(
    'import-validation',
    {
      body: {
        import_type: 'players',
        organization_id: MOCK_ORG_ID,
        rows,
        import_job_id: jobId,
        row_offset: 0,
      },
    }
  );
  expect(validationError).toBeNull();
  const staged = getMockData('staging_players').filter((row) => row.import_job_id === jobId);
  const { data, error } = await supabase.rpc('finalize_import_job', {
    p_import_job_id: jobId,
    p_validation_errors: [],
  });
  expect(error).toBeNull();
  return { validated: validated.validated_data, staged, finalized: data };
}

const player = (externalId) =>
  getMockData('players').find((p) => p.external_registration_id === externalId);

describe('the mock import stores a natural age and no birth date (R5)', () => {
  beforeEach(signIn);

  it('computes it from the birth date with the season cutoff, stages no birth key, keeps the date for the session', async () => {
    setSeason(2026, 'school_year_aug_jul');
    const { validated, staged, finalized } = await importPlayers('mock-job-r5-dob', [
      // An August birth is a year younger under the August 1 cutoff.
      {
        'First Name': 'First1',
        'Last Name': 'Last1',
        'Date of Birth': '2016-03-01',
        'Registration ID': 'R5-1',
      },
      {
        'First Name': 'First2',
        'Last Name': 'Last2',
        'Date of Birth': '2016-08-15',
        'Registration ID': 'R5-2',
      },
    ]);
    expect(finalized.inserted_players).toBe(2);
    expect(player('R5-1').natural_age).toBe(10);
    expect(player('R5-2').natural_age).toBe(9);
    for (const id of ['R5-1', 'R5-2']) {
      expect(player(id)).not.toHaveProperty('date_of_birth');
      expect(player(id)).not.toHaveProperty('birth_year');
    }
    expect(JSON.stringify(staged)).not.toMatch(/2016-0[38]/);
    expect(staged.map((row) => row.normalized_payload.natural_age)).toEqual(['10', '9']);
    expect(validated.map((row) => row.date_of_birth)).toEqual(['2016-03-01', '2016-08-15']);
  });

  it('takes the birth date over the age group, the age group when no birth date gives an age, and never a natural_age column from the file', async () => {
    // The mock seed's season has no season_year, so the birth date gives no age yet.
    await importPlayers('mock-job-r5-age-group', [
      {
        'First Name': 'First3',
        'Last Name': 'Last3',
        'Date of Birth': '2016-03-01',
        'Age Group': '11',
        natural_age: '4',
        'Registration ID': 'R5-3',
      },
    ]);
    expect(player('R5-3').natural_age).toBe(11);
    setSeason(2026, 'birth_year');
    await importPlayers('mock-job-r5-age-group-2', [
      {
        'First Name': 'First3',
        'Last Name': 'Last3',
        'Date of Birth': '2016-03-01',
        'Age Group': '11',
        'Registration ID': 'R5-3',
      },
    ]);
    expect(player('R5-3').natural_age).toBe(10);
  });

  it('promotes a row with neither, with no natural age (teaming places and flags it)', async () => {
    // The mock seed's season has no season_year, so a birth date gives no age.
    const { finalized } = await importPlayers('mock-job-r5-none', [
      {
        'First Name': 'First4',
        'Last Name': 'Last4',
        'Date of Birth': '2016-03-01',
        'Registration ID': 'R5-4',
      },
      {
        'First Name': 'First5',
        'Last Name': 'Last5',
        'Date of Birth': '2016-03-01',
        'Age Group': '30',
        'Registration ID': 'R5-5',
      },
    ]);
    expect(finalized.inserted_players).toBe(2);
    expect(player('R5-4').natural_age).toBeNull();
    expect(player('R5-5').natural_age).toBeNull();
  });

  it('rewrites the natural age on a re-import, as the division is', async () => {
    setSeason(2026, 'birth_year');
    const row = {
      'First Name': 'First6',
      'Last Name': 'Last6',
      'Date of Birth': '2016-03-01',
      'Registration ID': 'R5-6',
    };
    await importPlayers('mock-job-r5-first', [row]);
    expect(player('R5-6').natural_age).toBe(10);
    setSeason(2027, 'birth_year');
    const { finalized } = await importPlayers('mock-job-r5-second', [row]);
    expect(finalized.updated_players).toBe(1);
    expect(player('R5-6').natural_age).toBe(11);
  });

  it('refuses a player patch naming date_of_birth, as sanitize_player_patch does', async () => {
    const { data: created } = await supabase.rpc('admin_create_player', {
      p_organization_id: MOCK_ORG_ID,
      p_fields: { first_name: 'First7', last_name: 'Last7' },
    });
    const { error } = await supabase.rpc('admin_update_player', {
      p_player_id: created?.id,
      p_patch: { date_of_birth: '2016-03-01' },
    });
    expect(error?.message).toBe('field date_of_birth is not editable');
    expect(getMockData('players').find((p) => p.id === created.id)).not.toHaveProperty(
      'date_of_birth'
    );
  });
});
