/**
 * What the practice import catches, and what it lets through (PR 11 review of #732, items 2 and 10): only the error a
 * case is about is caught, and every other one is thrown, so a defect is never reported as the file's fault.
 *
 * - The stage (the Edge function, and its mock twin) answers `bad-date` for a date it was given that is not a calendar
 *   date (`PracticeImportDateError`, its own class in core and in the Edge mirror) and nothing else: any other error is
 *   thrown (the Edge function audits `import.failed` and rethrows it, so its failure log has it too).
 * - `practiceImportWords` shows a code it has no words for as the code, and catches nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const boom = vi.hoisted(() => ({ on: false }));
vi.mock('../packages/core/src/practiceImport/staging.js', async (original) => {
  const real = /** @type {any} */ (await original());
  return {
    ...real,
    stagePracticeFile: (/** @type {any} */ input) => {
      if (boom.on) throw new TypeError('an unexpected defect, not a date');
      return real.stagePracticeFile(input);
    },
  };
});
vi.mock('../packages/core/src/practiceImport/reasonCodes.js', async (original) => {
  const real = /** @type {any} */ (await original());
  return {
    ...real,
    describePracticeImportReason: (/** @type {string} */ code) => {
      if (code === 'bad-use') throw new RangeError('a defect in the words table');
      return real.describePracticeImportReason(code);
    },
  };
});

const { handlePracticeImportFunction } = await import('../frontend/src/lib/mockPracticeImport.js');
const { practiceImportWords } = await import('../frontend/src/utils/practiceImportWords.js');
const { PracticeImportDateError } =
  await import('../packages/core/src/practiceImport/parseRows.js');
const edge = await import('../supabase/functions/_shared/practice-import.ts');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HANDLER = readFileSync(
  path.join(REPO, 'supabase/functions/import-validation/index.ts'),
  'utf8'
);

const ORG = '0c000000-0000-4000-8000-000000000001';
const JOB = '0c000000-0000-4000-8000-000000000002';
const SEASON = '0c000000-0000-4000-8000-000000000003';
const db = () => ({
  season_settings: [
    {
      id: SEASON,
      organization_id: ORG,
      status: 'active',
      season_start: '2026-09-07',
      season_end: '2027-03-31',
    },
  ],
  import_jobs: [
    {
      id: JOB,
      organization_id: ORG,
      job_type: 'practice_schedule',
      status: 'importing',
      season_settings_id: SEASON,
    },
  ],
  staging_import_rows: [],
});
const ctx = { currentUserId: 'admin', isOrgAdmin: () => true };
const body = (extra = {}) => ({
  import_type: 'practice_schedule',
  action: 'stage',
  organization_id: ORG,
  import_job_id: JOB,
  headers: ['Day', 'Start', 'End', 'Location', 'Field'],
  rows: [{ Day: 'Mon', Start: '16:00', End: '17:00', Location: 'Venue A', Field: 'Field 1' }],
  dates: null,
  ...extra,
});

describe('the stage answers bad-date for a date, and throws everything else (item 2)', () => {
  it('a confirm-step date that is not a calendar date is refused as bad-date', () => {
    const answer = handlePracticeImportFunction(
      db(),
      body({ dates: { valid_from: '2026-02-31' } }),
      ctx
    );
    expect(answer.data).toMatchObject({ status: 'refused', code: 'bad-date' });
  });

  it('an unexpected TypeError is thrown, never reported as bad-date', () => {
    boom.on = true;
    try {
      expect(() => handlePracticeImportFunction(db(), body(), ctx)).toThrow(
        'an unexpected defect, not a date'
      );
    } finally {
      boom.on = false;
    }
  });

  it('core and the Edge mirror throw the date error as its own class, a TypeError still', () => {
    for (const stage of [edge.stagePracticeFile]) {
      try {
        stage({
          headers: ['Day', 'Start', 'End', 'Location', 'Field'],
          rows: [],
          season: { startDate: 'soon' },
          dates: null,
          clean: (v) => String(v ?? ''),
        });
        throw new Error('it did not throw');
      } catch (error) {
        expect(error).toBeInstanceOf(edge.PracticeImportDateError);
        expect(error).toBeInstanceOf(TypeError);
      }
    }
    expect(new PracticeImportDateError('x')).toBeInstanceOf(TypeError);
  });

  it('the Edge handler catches only the date error, audits the failure, and rethrows the rest', () => {
    const arm = HANDLER.slice(HANDLER.indexOf('if (practices) {'));
    const catchBlock = arm.slice(
      arm.indexOf('} catch (error) {'),
      arm.indexOf('if (staged.refusal)')
    );
    expect(catchBlock).toContain("action: 'import.failed'");
    expect(catchBlock).toContain('if (!(error instanceof PracticeImportDateError)) throw error;');
    expect(catchBlock).not.toMatch(/instanceof TypeError/);
  });
});

describe('practiceImportWords catches nothing (item 10)', () => {
  it('a known code is its words; a code this build does not know is shown as it is', () => {
    expect(practiceImportWords('bad-day')).toMatch(/^The day is not Monday to Sunday/);
    expect(practiceImportWords('a-newer-reason')).toBe('a-newer-reason');
  });

  it('any other failure is thrown, not turned into the code', () => {
    expect(() => practiceImportWords('bad-use')).toThrow(RangeError);
  });
});
