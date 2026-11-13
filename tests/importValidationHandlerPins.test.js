/**
 * The Vitest twin of the source assertions the Deno suite makes about `supabase/functions/import-validation/index.ts`
 * (`_shared/tests/import-age-rule_test.ts`, "the handler counts ages from the call and reads no rule of its own").
 *
 * Deno is absent where most changes to the handler are written, and the first push of the games arm (PR 6 of the
 * schedule expansion) added a `.from('season_settings')` read to the handler that this Deno test forbids: CI was the
 * first to say so. This file reads the Deno test's own assertions out of its text and makes each of them here, so a
 * change to the handler that breaks one is red before a push, and an assertion added there and not here is red too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(REPO, file), 'utf8');
const HANDLER = read('supabase/functions/import-validation/index.ts');
const DENO = read('supabase/functions/_shared/tests/import-age-rule_test.ts');
const BLOCK = DENO.slice(
  DENO.indexOf("Deno.test('the handler counts ages from the call and reads no rule of its own'")
);

describe('the handler assertions of the Deno suite, made here too', () => {
  it('finds the Deno test and every kind of assertion it makes (a twin of nothing passes)', () => {
    expect(BLOCK.length).toBeGreaterThan(200);
    expect(BLOCK).toContain("new URL('../../import-validation/index.ts', import.meta.url)");
  });

  it('forbids what it forbids: every `!source.includes(...)` of the Deno test', () => {
    const forbidden = [...BLOCK.matchAll(/assert\(!source\.includes\((["'])(.+?)\1\)/g)].map((m) =>
      m[2].replace(/\\'/g, "'")
    );
    expect(forbidden).toEqual([".from('season_settings')", ".from('divisions')", 'importSeason(']);
    expect(forbidden.filter((text) => HANDLER.includes(text))).toEqual([]);
  });

  it('requires what it requires: every `source.includes(...)` and the one call', () => {
    const required = [...BLOCK.matchAll(/assert\(source\.includes\('(.+?)'\)\)/g)].map((m) => m[1]);
    expect(required.length).toBe(2);
    for (const text of required) expect(HANDLER, text).toContain(text);
    expect(BLOCK).toContain("source.split('await loadImportAgeRule(').length - 1, 1");
    expect(HANDLER.split('await loadImportAgeRule(').length - 1).toBe(1);
    expect(HANDLER.indexOf('await loadImportAgeRule(')).toBeLessThan(
      HANDLER.indexOf('importNaturalAge({')
    );
  });

  it('the games and practice arms read their season through the shared module, for the JOB’s season and organization', () => {
    // one read in the games arm and one in the practice schedule arm (PR 11), each of the job's season
    expect(HANDLER.split('await loadGameImportSeason(').length - 1).toBe(2);
    expect(
      HANDLER.split('{ seasonSettingsId: job.season_settings_id, organizationId }').length - 1
    ).toBe(2);
    expect(HANDLER).toContain('seasonSettingsId: job.season_settings_id, organizationId');
    const shared = read('supabase/functions/_shared/schedule-import.ts');
    const fn = shared.slice(shared.indexOf('export async function loadGameImportSeason('));
    expect(fn).toContain(".from('season_settings')");
    expect(fn).toContain(".select('id, timezone, season_start, season_end')");
    expect(fn).toContain(".eq('id', seasonSettingsId)");
    expect(fn).toContain(".eq('organization_id', organizationId)");
  });
});
