/**
 * import-validation counts a player file's ages from ONE call that returns the rule with its revision
 * and stamps the job (Phase E3b; Codex's findings on #680): `loadImportAgeRule` asks
 * `import_age_rule` and maps what it returns, a first batch restarts the stamp and a later one keeps
 * it, an error is reported, and the handler reads no rule by itself (no second read of the season
 * or the divisions, which is how a change and its reversal slipped between a stamp and a read).
 * Placeholder ids only.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { loadImportAgeRule, type AgeRuleClient } from '../import-age-rule.ts';

type Call = { fn: string; args: Record<string, unknown> };

function fakeClient(
  result: { data: unknown; error: { message?: string } | null },
  reads: { from: number } = { from: 0 }
) {
  const calls: Call[] = [];
  const client: AgeRuleClient & { from: () => never } = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(result);
    },
    from() {
      reads.from += 1;
      throw new Error('the rule must come from import_age_rule, not a table read');
    },
  };
  return { client, calls, reads };
}

const ORG = '00000000-0000-4000-8000-0000000000b1';
const JOB = '00000000-0000-4000-8000-0000000000a1';
const RULE = {
  season_id: '00000000-0000-4000-8000-0000000000c1',
  status: 'draft',
  season_year: 2027,
  age_cutoff_mode: 'custom',
  age_cutoff_month: 9,
  age_cutoff_day: 1,
  revision: 7,
  divisions: [
    {
      name: 'U4',
      min_age: 4,
      max_age: 4,
      birthdate_start: '2023-01-01',
      birthdate_end: '2024-07-31',
    },
  ],
};

Deno.test('the rule, its revision and the job stamp come from one call', async () => {
  const { client, calls } = fakeClient({ data: RULE, error: null });
  const loaded = await loadImportAgeRule(client, {
    organizationId: ORG,
    importJobId: JOB,
    rowOffset: 0,
  });
  assertEquals(calls, [
    {
      fn: 'import_age_rule',
      args: { p_organization_id: ORG, p_import_job_id: JOB, p_restart: true },
    },
  ]);
  assertEquals(loaded.error, null);
  assertEquals(loaded.rule?.revision, 7);
  assertEquals(loaded.rule?.season, {
    id: RULE.season_id,
    status: 'draft',
    season_year: 2027,
    age_cutoff_mode: 'custom',
    age_cutoff_month: 9,
    age_cutoff_day: 1,
  });
  assertEquals(loaded.rule?.windowedDivisions, RULE.divisions);
});

Deno.test(
  'a later batch keeps the first stamp, and a missing offset is the first batch',
  async () => {
    const later = fakeClient({ data: RULE, error: null });
    await loadImportAgeRule(later.client, {
      organizationId: ORG,
      importJobId: JOB,
      rowOffset: 5000,
    });
    assertEquals(later.calls[0].args.p_restart, false);
    const first = fakeClient({ data: RULE, error: null });
    await loadImportAgeRule(first.client, { organizationId: ORG, importJobId: JOB });
    assertEquals(first.calls[0].args.p_restart, true);
  }
);

Deno.test('with no job the rule is still read, and nothing is stamped', async () => {
  const { client, calls } = fakeClient({ data: RULE, error: null });
  await loadImportAgeRule(client, { organizationId: ORG, importJobId: null });
  assertEquals(calls[0].args.p_import_job_id, null);
});

Deno.test('no season for the job is a rule with no season, never an error', async () => {
  const { client } = fakeClient({ data: null, error: null });
  const loaded = await loadImportAgeRule(client, { organizationId: ORG, importJobId: JOB });
  assertEquals(loaded.error, null);
  assertEquals(loaded.rule, { season: null, windowedDivisions: [], revision: null });
});

Deno.test('a refused call is an error to report, never a rule', async () => {
  const refused = fakeClient({ data: null, error: { message: 'permission denied' } });
  const loaded = await loadImportAgeRule(refused.client, { organizationId: ORG, importJobId: JOB });
  assertEquals(loaded.rule, null);
  assertEquals(loaded.error, { message: 'permission denied' });
  const silent = fakeClient({ data: null, error: {} });
  const second = await loadImportAgeRule(silent.client, { organizationId: ORG, importJobId: JOB });
  assert(second.error !== null && second.error.message.length > 0);
});

Deno.test('the rule is read from the call alone: no table is read for it', async () => {
  const { client, reads } = fakeClient({ data: RULE, error: null });
  await loadImportAgeRule(client, { organizationId: ORG, importJobId: JOB, rowOffset: 0 });
  assertEquals(reads.from, 0);
});

Deno.test('the handler counts ages from the call and reads no rule of its own', async () => {
  const source = await Deno.readTextFile(
    new URL('../../import-validation/index.ts', import.meta.url)
  );
  assertEquals(source.split('await loadImportAgeRule(').length - 1, 1, 'one call');
  assert(!source.includes(".from('season_settings')"), 'no second read of the season');
  assert(!source.includes(".from('divisions')"), 'nor of the divisions');
  assert(!source.includes('importSeason('), 'and no season picked from a list');
  // The ages are counted from the call's season and divisions.
  assert(source.includes('season = loaded.rule.season'));
  assert(source.includes('windowedDivisions = loaded.rule.windowedDivisions'));
  assert(
    source.indexOf('await loadImportAgeRule(') < source.indexOf('importNaturalAge({'),
    'the rule is loaded before any age is counted'
  );
});
